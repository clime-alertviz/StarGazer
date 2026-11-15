import { randomUUID } from "node:crypto";
import { calendarPayload, applyCalendarSnapshot } from "./delivery.js";

export class ConnectorDelivery {
  constructor(hub) {
    this.hub = hub;
  }
  async configure(id, outingId, mode) {
    const h = this.hub,
      o = h.outing(outingId);
    h.owner(o, id);
    return h.lock(o.id, async () => {
      if (o.deliveryMode === mode) return { mode };
      if (
        o.calendar?.externalClaim ||
        ["sending", "uncertain", "failed"].includes(o.calendar?.state) ||
        h.deliveryRuns.has(o.id) ||
        h.data.messages.some(
          (m) =>
            m.outingId === o.id &&
            ["sending", "uncertain", "codex_sending"].includes(m.delivery),
        )
      )
        throw new Error(
          "Reconcile outstanding deliveries before changing who sends them.",
        );
      o.deliveryMode = mode;
      for (const m of h.data.messages.filter(
        (m) => m.outingId === o.id && m.senderId === id,
      )) {
        if (mode === "codex" && m.delivery === "queued")
          m.delivery = "codex_pending";
        if (mode === "server" && m.delivery === "codex_pending")
          m.delivery = "queued";
      }
      if (o.calendar && o.calendar.applied !== o.calendar.desired)
        o.calendar.state = mode === "codex" ? "codex_pending" : "queued";
      await h.store.persist();
      return { mode, accountEmail: h.user(id).email };
    });
  }
  list(id) {
    const h = this.hub;
    h.user(id);
    return {
      accountEmail: h.user(id).email,
      deliveries: [
        ...h.data.messages
          .filter(
            (m) =>
              m.senderId === id &&
              ["codex_pending", "codex_sending"].includes(m.delivery),
          )
          .map((m) => ({
            kind: "email",
            id: m.id,
            outingId: m.outingId,
            subject: m.subject,
            status: m.delivery,
          })),
        ...h.data.outings
          .filter(
            (o) =>
              o.organizerId === id &&
              o.deliveryMode === "codex" &&
              o.calendar?.desired &&
              (o.calendar.applied !== o.calendar.desired ||
                o.calendar.externalClaim),
          )
          .map((o) => ({
            kind: "calendar",
            id: o.id,
            outingId: o.id,
            subject: o.title,
            status: o.calendar.state,
          })),
      ],
    };
  }
  async claim(id, { kind, deliveryId }) {
    const h = this.hub;
    return h.lock(`delivery:${kind}:${deliveryId}`, async () => {
      const record =
        kind === "email"
          ? h.data.messages.find(
              (m) => m.id === deliveryId && m.senderId === id,
            )
          : h.outing(deliveryId);
      if (!record) throw new Error("Delivery not found.");
      const o = kind === "email" ? h.outing(record.outingId) : record;
      h.owner(o, id);
      if (o.deliveryMode !== "codex")
        throw new Error("This outing uses server-managed delivery.");
      const target = kind === "email" ? record : o.calendar;
      if (
        !target ||
        (kind === "email"
          ? !["codex_pending", "codex_sending"].includes(record.delivery)
          : target.applied === target.desired && !target.externalClaim)
      )
        throw new Error("No pending delivery. Do not send it again.");
      const recoveryRequired = Boolean(target.externalClaim);
      if (!target.externalClaim) {
        const token = randomUUID();
        const calendar =
          kind === "calendar"
            ? calendarPayload(h, o, target.desired)
            : null;
        if (calendar)
          calendar.description += `\nStarGazer delivery ${token}\nStarGazer sync ${target.desired}`;
        target.externalClaim = {
          token,
          createdAt: new Date().toISOString(),
          desired: target.desired,
          payload:
            kind === "email"
              ? {
                  action: "send",
                  to: record.to,
                  subject: record.subject,
                  text: `${record.text}\n\n${record.link || ""}\n\nStarGazer delivery ${token}`,
                }
              : {
                  action: ["cancelled", "not_formed"].includes(o.status)
                    ? "cancel"
                    : target.applied
                      ? "update"
                      : "create",
                  eventId: target.applied ? target.id : null,
                  ...calendar,
                },
        };
        if (kind === "email") record.delivery = "codex_sending";
        else target.state = "codex_sending";
        await h.store.persist();
      }
      return {
        kind,
        deliveryId,
        accountEmail: h.user(id).email,
        recoveryRequired,
        claimToken: target.externalClaim.token,
        ...target.externalClaim.payload,
      };
    });
  }
  async complete(id, data) {
    const h = this.hub;
    return h.lock(`delivery:${data.kind}:${data.deliveryId}`, async () => {
      const m =
        data.kind === "email"
          ? h.data.messages.find(
              (m) => m.id === data.deliveryId && m.senderId === id,
            )
          : null;
      const o = h.outing(
        data.kind === "email" ? m?.outingId : data.deliveryId,
      );
      h.owner(o, id);
      const target = m || o.calendar,
        claim = target?.externalClaim;
      if (!claim || claim.token !== data.claimToken) {
        if (target?.lastClaim === data.claimToken)
          return { recorded: true };
        throw new Error(
          "Delivery claim not found. Read the pending deliveries first.",
        );
      }
      if (data.outcome === "uncertain") {
        target.error =
          "Check the connected mailbox or Calendar for this delivery before sending again.";
        await h.store.persist();
        return { recorded: true, recoveryRequired: true };
      }
      if (data.outcome === "not_sent") {
        if (!data.recoveryNote?.trim())
          throw new Error(
            "Record how you verified that the provider did not send this delivery.",
          );
        target.recoveryNote = data.recoveryNote;
        delete target.externalClaim;
        delete target.error;
        if (m) m.delivery = "codex_pending";
        else target.state = "codex_pending";
        await h.store.persist();
        return { recorded: true, retryAvailable: true };
      }
      if (!data.providerId && claim.payload.action !== "cancel")
        throw new Error(
          "Record the message or event ID returned by the integration.",
        );
      if (m) {
        m.delivery = "sent";
        m.providerId = data.providerId;
        m.processedAt = new Date().toISOString();
      } else {
        if (
          claim.payload.eventId &&
          data.providerId &&
          data.providerId !== claim.payload.eventId
        )
          throw new Error(
            "An update must keep the same Calendar event ID.",
          );
        if (data.providerId) target.id = data.providerId;
        target.applied = claim.desired;
        target.state =
          target.desired === claim.desired ? "sent" : "codex_pending";
        if (data.url?.startsWith("https://calendar.google.com/"))
          target.url = data.url;
      }
      target.lastClaim = claim.token;
      delete target.externalClaim;
      delete target.error;
      await h.store.persist();
      return { recorded: true };
    });
  }
  importResponses(id, { outingId, revision, readAt, event }) {
    const h = this.hub,
      o = h.outing(outingId);
    h.owner(o, id);
    if (
      o.deliveryMode !== "codex" ||
      event.id !== o.calendar?.id ||
      o.calendar.applied !== o.calendar.desired
    )
      throw new Error(
        "Read the current linked Calendar event after delivering the latest changes.",
      );
    const started = Date.parse(readAt);
    if (
      !Number.isFinite(started) ||
      started > Date.now() + 1000 ||
      started < Date.now() - 5 * 60000
    )
      throw new Error(
        "Use a fresh Calendar read from the last five minutes.",
      );
    return applyCalendarSnapshot(h, o, event, { revision, started }).then(
      () => h.view(o.id, id),
    );
  }
}
