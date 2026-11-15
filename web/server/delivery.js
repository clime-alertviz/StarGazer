import { digest } from "./providers.js";
import { equipmentList } from "./outing-details.js";

const terminal = new Set(["cancelled", "completed", "not_formed"]);
const active = (p) =>
  !["declined", "expired", "withdrawn"].includes(p.response);

export function calendarPayload(hub, o, key) {
  const format = (value) =>
    new Intl.DateTimeFormat("en-GB", {
      timeZone: o.timezone,
      dateStyle: "medium",
      timeStyle: "short",
      hour12: false,
    }).format(new Date(value));
  const names = new Map(
    o.people.map((p) => [p.userId, p.preferences.name]),
  );
  const rides = (o.carpools || [])
    .map(
      (c) =>
        `${names.get(c.driverId)} drives ${c.passengerIds.map((id) => names.get(id)).join(", ")}. ${c.pickups.map((p) => `${names.get(p.participantId)}: ${p.pickup.name} at ${format(p.pickupAt)}; return ${format(p.dropoffAt)}`).join(" ")}`,
    )
    .join("\n");
  const reservations = o.people
    .filter(
      (p) =>
        ["pending", "tentative"].includes(p.response) && p.reservedUntil,
    )
    .map(
      (p) =>
        `${p.preferences.name}: reserved until ${format(p.reservedUntil)}`,
    )
    .join("\n");
  const padding =
    o.kind === "connection_test" ? 0 : (15 + o.site.walkMinutes) * 60000;
  const meeting = new Date(Date.parse(o.start) - padding).toISOString(),
    leaving = new Date(Date.parse(o.end) + padding).toISOString();
  const description = `Star Gazer outing ${o.id}\nRevision ${o.revision}\n${hub.baseUrl}/outing/${o.id}\n\nRespond in Calendar or on the outing page. After a time, site or ride change, reconfirm on the page.\n\nTimes in ${o.timezone}.\nMeet: ${format(meeting)}. Ready to leave: ${format(leaving)}.\nObserving: ${format(o.start)} – ${format(o.end)}.\n${equipmentList(o).join("\n")}\n${rides}\n\n${o.site.accessNote}\nForecast checked: ${o.weather?.fetchedAt ? format(o.weather.fetchedAt) : "not available"}. Check the outing page before departure.\nReply by ${o.deadline ? format(o.deadline) : "the deadline on the outing page"}.\n${reservations}`;
  return {
    summary: `${o.confirmationNotified ? "" : "[Provisional] "}${o.title}`,
    description,
    start: {
      dateTime: meeting,
      timeZone: o.timezone,
    },
    end: {
      dateTime: leaving,
      timeZone: o.timezone,
    },
    location: `${o.site.name} (${o.site.meetingPoint.lat}, ${o.site.meetingPoint.lon})`,
    attendees: o.people
      .filter(
        (p) =>
          p.userId !== o.organizerId &&
          p.channel === "calendar" &&
          active(p),
      )
      .map((p) => ({ email: hub.user(p.userId).email })),
    guestsCanModify: false,
    guestsCanInviteOthers: false,
    visibility: "private",
    extendedProperties: { private: { stargazer: o.id, syncKey: key } },
  };
}

export async function deliverCalendar(
  hub,
  outingId,
  { retry = false } = {},
) {
  if (hub.deliveryRuns.has(outingId)) return hub.deliveryRuns.get(outingId);
  const task = (async () => {
    const o = hub.outing(outingId),
      c = o.calendar;
    if (!c || !c.desired || o.migrationPaused || o.deliveryMode === "codex")
      return;
    if (!hub.providers.status(o.organizerId).googleConnected) {
      c.state = "needs_connection";
      c.error =
        "Connect the organizer’s Google account in Settings, then reconcile this event.";
      await hub.store.persist();
      return;
    }
    if (retry) {
      c.attempts = 0;
      delete c.nextAttempt;
    }
    if (c.applied === c.desired) return;
    if (["failed", "needs_connection"].includes(c.state) && !retry) return;
    const snapshot = structuredClone(o),
      key = c.desired,
      payload = calendarPayload(hub, snapshot, key);
    c.state = "sending";
    c.attempts = (c.attempts || 0) + 1;
    await hub.store.persist();
    try {
      let existing = null;
      try {
        existing = await hub.providers.calendar(o.organizerId, "GET", c.id);
      } catch (error) {
        if (![404, 410].includes(error.status)) throw error;
      }
      let result = existing;
      if (["cancelled", "not_formed"].includes(snapshot.status)) {
        if (existing && existing.status !== "cancelled")
          await hub.providers.calendar(o.organizerId, "DELETE", c.id);
      } else if (existing?.extendedProperties?.private?.syncKey !== key) {
        if (!existing && (c.applied || snapshot.legacy))
          throw Object.assign(
            new Error(
              "The linked Calendar event can no longer be found. Review it in Google Calendar; Star Gazer will not recreate it automatically.",
            ),
            { status: 410 },
          );
        if (existing?.status === "cancelled")
          throw Object.assign(
            new Error(
              "The linked Calendar event was cancelled outside Star Gazer. Review the outing before creating another event.",
            ),
            { status: 410 },
          );
        if (existing) {
          // Keep existing guest responses. PATCH must not erase their RSVP when
          // rebuilding the attendee list after a new participant joins.
          payload.attendees = payload.attendees.map((p) => ({
            ...p,
            ...(existing.attendees?.find(
              (a) => a.email?.toLowerCase() === p.email,
            )
              ? {
                  responseStatus: existing.attendees.find(
                    (a) => a.email?.toLowerCase() === p.email,
                  ).responseStatus,
                }
              : {}),
          }));
          result = await hub.providers.calendar(
            o.organizerId,
            "PATCH",
            c.id,
            payload,
            existing.etag,
          );
        } else {
          try {
            result = await hub.providers.calendar(
              o.organizerId,
              "POST",
              null,
              {
                id: c.id,
                ...payload,
              },
            );
          } catch (error) {
            if (error.status === 409) {
              throw Object.assign(
                new Error(
                  "Calendar reports an existing event that cannot yet be read. Reconcile after checking Google Calendar.",
                ),
                { status: 409 },
              );
            }
            throw error;
          }
        }
      }
      c.applied = key;
      c.error = null;
      c.attempts = 0;
      delete c.nextAttempt;
      if (result?.htmlLink?.startsWith("https://calendar.google.com/"))
        c.url = result.htmlLink;
      c.state = c.desired === key ? "sent" : "queued";
    } catch (error) {
      const transient =
        !error.status ||
        error.status >= 500 ||
        [409, 412, 429].includes(error.status);
      c.state = [401, 403].includes(error.status)
        ? "needs_connection"
        : transient && c.attempts < 5
          ? "uncertain"
          : "failed";
      c.error =
        error.message +
        (c.attempts >= 5
          ? " Automatic retries stopped. Review and reconcile the event."
          : "");
      c.nextAttempt =
        Date.now() + Math.min(30 * 60000, 60000 * 2 ** (c.attempts - 1));
    }
    await hub.store.persist();
  })().finally(() => hub.deliveryRuns.delete(outingId));
  hub.deliveryRuns.set(outingId, task);
  return task;
}

export async function syncCalendar(hub, outingId) {
  const o = hub.outing(outingId);
  if (
    o.deliveryMode === "codex" ||
    !o.calendar?.id ||
    o.migrationPaused ||
    terminal.has(o.status) ||
    o.status === "draft"
  )
    return;
  const revision = o.revision,
    started = Date.now();
  const generation = (o.calendar.readGeneration || 0) + 1;
  o.calendar.readGeneration = generation;
  let event;
  try {
    event = await hub.providers.calendar(
      o.organizerId,
      "GET",
      o.calendar.id,
    );
  } catch (error) {
    if (o.calendar.readGeneration !== generation) return;
    o.calendar.error = error.message;
    await hub.store.persist();
    return;
  }
  return applyCalendarSnapshot(hub, o, event, {
    revision,
    started,
    generation,
  });
}

export function applyCalendarSnapshot(
  hub,
  o,
  event,
  { revision, started, generation },
) {
  return hub.lock(o.id, async () => {
    if (
      o.revision !== revision ||
      terminal.has(o.status) ||
      (generation !== undefined && o.calendar.readGeneration !== generation)
    )
      return;
    o.calendar.checkedAt = new Date().toISOString();
    o.calendar.error = null;
    if (event.status === "cancelled") {
      o.calendar.error =
        "The Calendar event was cancelled outside Star Gazer. The organizer should review or cancel the outing here.";
      await hub.store.persist();
      return;
    }
    for (const guest of event.attendees || []) {
      const p = o.people.find(
        (p) =>
          p.channel === "calendar" &&
          hub.user(p.userId).email === guest.email?.toLowerCase(),
      );
      if (
        !p ||
        !active(p) ||
        guest.responseStatus === p.calendarStatus ||
        !["accepted", "declined", "tentative", "needsAction"].includes(
          guest.responseStatus,
        )
      )
        continue;
      p.calendarStatus = guest.responseStatus;
      p.observedAt = new Date().toISOString();
      if (
        guest.responseStatus === "accepted" &&
        p.response !== "accepted" &&
        o.kind !== "connection_test" &&
        Date.parse(
          o.routes.find((r) => r.participantId === p.userId)?.departAt,
        ) <= Date.now()
      ) {
        p.conflict =
          "Calendar acceptance was first seen after your proposed departure. Ask the organizer to review the journey.";
        hub.organizerNotice(
          o,
          "Late Calendar response needs review",
          `${p.preferences.name} replied after the proposed departure time.`,
        );
        continue;
      }
      if (
        revision > 1 ||
        p.source === "app" ||
        Date.parse(p.answeredAt) > started
      ) {
        if (guest.responseStatus !== p.response)
          p.conflict = `Calendar shows ${guest.responseStatus}. Confirm your answer on this page.`;
        continue;
      }
      if (
        ["tentative", "needsAction"].includes(guest.responseStatus) &&
        !["pending", "tentative"].includes(p.response)
      )
        p.reservedUntil = hub.reservationEnd(o);
      p.response =
        guest.responseStatus === "needsAction"
          ? "pending"
          : guest.responseStatus;
      p.source = "calendar";
      p.revision = revision;
      o.version++;
      hub.organizerNotice(
        o,
        `${p.preferences.name} · ${p.response}`,
        "Calendar response received.",
      );
      hub.rideNotices(o, p.userId);
    }
    hub.evaluate(o);
    await hub.store.persist();
  });
}

export function pump(hub, options = {}) {
  if (hub.closing) return Promise.resolve();
  if (hub.pumpRun) return hub.pumpRun;
  hub.pumpRun = runPump(hub, options).finally(() => {
    hub.pumpRun = null;
  });
  return hub.pumpRun;
}
async function runPump(hub, { sync = false } = {}) {
  try {
    // Lifecycle checks do not wait for any provider, including slow Calendar reads.
    hub.identity.cleanup();
    for (const o of hub.data.outings) hub.evaluate(o);
    await hub.store.persist();
    for (const m of hub.data.messages.filter(
      (m) => m.delivery === "queued",
    )) {
      if (hub.closing) break;
      if (m.delivery !== "queued") continue;
      m.delivery = "sending";
      await hub.store.persist();
      try {
        Object.assign(m, await hub.providers.mail(m));
        m.processedAt = new Date().toISOString();
      } catch (error) {
        m.delivery =
          error.status && error.status < 500 ? "failed" : "uncertain";
        m.error = error.message;
      }
      await hub.store.persist();
    }
    await Promise.allSettled(
      hub.data.outings.map(async (o) => {
        if (hub.closing || o.deliveryMode === "codex") return;
        if (
          o.calendar?.state === "needs_connection" &&
          hub.providers.status(o.organizerId).googleConnected
        ) {
          o.calendar.state = "queued";
          delete o.calendar.nextAttempt;
        }
        if (
          o.calendar &&
          ["queued", "uncertain"].includes(o.calendar.state) &&
          (!o.calendar.nextAttempt || o.calendar.nextAttempt <= Date.now())
        )
          await deliverCalendar(hub, o.id);
        if (sync && o.calendar?.state === "sent" && !terminal.has(o.status))
          await syncCalendar(hub, o.id);
      }),
    );
  } finally {
    await hub.store.persist();
  }
}
