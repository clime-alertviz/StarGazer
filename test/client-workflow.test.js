import test from "node:test";
import assert from "node:assert/strict";
import { solverFixture } from "./helpers/solver-fixture.js";
import { operations } from "../web/server/mcp.js";
import { pump } from "../web/server/delivery.js";
import { createHub } from "../web/hub.js";
import { rm } from "node:fs/promises";

const run = (hub, id, name, input = {}) => {
  const op = operations(hub, id)[name];
  return op.run(op.schema.parse(input));
};
async function openDraft(f) {
  const result = await f.hub.plan(f.owner.id, {
    ...f.input,
    solver: "deterministic",
  });
  const o = f.hub.outing(result.id);
  o.site.access = "confirmed";
  o.site.accessNote = "Public access checked for this evening.";
  return o;
}
async function friend(f, email, channel = "email") {
  const u = f.hub.identity.user(email);
  await f.hub.saveProfile(u.id, {
    ...f.owner.preferences,
    name: email.split("@")[0],
    channel,
  });
  f.hub.data.connections.push({
    from: f.owner.id,
    to: u.id,
    status: "accepted",
  });
  return u;
}

test("local client chooses and saves a plan through granular MCP tools without a backend LLM", async (t) => {
  const f = await solverFixture({
    run: async () => {
      throw new Error("Backend model must not run");
    },
  });
  t.after(f.close);
  const session = await run(f.hub, f.owner.id, "begin_planning", f.input);
  assert.equal(session.organizer.id, f.owner.id);
  assert.equal(JSON.stringify(session).includes(f.owner.email), false);
  const sites = await run(f.hub, f.owner.id, "find_planning_sites", {
    planningId: session.planningId,
  });
  const windows = await run(
    f.hub,
    f.owner.id,
    "inspect_planning_conditions",
    { planningId: session.planningId, siteId: sites.sites[1].id },
  );
  assert.ok(windows.totalSuitable);
  const args = {
    planningId: session.planningId,
    siteId: sites.sites[1].id,
    start: `${f.day}T20:00:00Z`,
    participantIds: [f.owner.id],
    transports: { [f.owner.id]: "walk" },
  };
  await assert.rejects(
    run(f.hub, "outsider", "check_plan_candidate", args),
    /not found/,
  );
  const candidate = await run(
    f.hub,
    f.owner.id,
    "check_plan_candidate",
    args,
  );
  const saved = await run(f.hub, f.owner.id, "save_plan_candidate", {
    planningId: session.planningId,
    candidateId: candidate.candidateId,
    explanation:
      "I chose this checked plan for a quiet photography evening.",
  });
  assert.equal(saved.solver.execution, "client");
  assert.equal(saved.site.name, "Quiet hill");
  const again = await run(f.hub, f.owner.id, "save_plan_candidate", {
    planningId: session.planningId,
    candidateId: candidate.candidateId,
    explanation: "Same decision.",
  });
  assert.equal(again.id, saved.id);
  assert.equal(f.hub.data.outings.length, 1);
  await run(f.hub, f.owner.id, "list_outing_candidates");
});

test("client planning rejects changed profiles rather than committing stale offers", async (t) => {
  const f = await solverFixture({
    run: async () => assert.fail("No model"),
  });
  t.after(f.close);
  const s = await f.hub.clientPlanning.begin(f.owner.id, f.input);
  await f.hub.clientPlanning.run(
    f.owner.id,
    s.planningId,
    "discover_sites",
    {},
  );
  const c = await f.hub.clientPlanning.run(
    f.owner.id,
    s.planningId,
    "evaluate_candidate",
    {
      siteId: "spot-0",
      start: `${f.day}T20:00:00Z`,
      participantIds: [f.owner.id],
      transports: { [f.owner.id]: "walk" },
    },
  );
  f.owner.preferences.maxWalkMinutes = 0;
  await assert.rejects(
    f.hub.clientPlanning.save(f.owner.id, {
      planningId: s.planningId,
      candidateId: c.candidateId,
      explanation: "Test",
    }),
    /changed/,
  );
  assert.equal(f.hub.data.outings.length, 0);
});

test("Codex email and Calendar handoffs exclude the server, preserve receipts and cancel the same event", async (t) => {
  const f = await solverFixture();
  t.after(f.close);
  const a = await friend(f, "mail@fixture.test"),
    b = await friend(f, "calendar@fixture.test", "calendar");
  let sends = 0;
  f.hub.providers.mail = async () => {
    sends++;
    return { delivery: "sent" };
  };
  f.hub.providers.calendar = async () => {
    sends++;
    throw Error("Server must not send");
  };
  const o = await openDraft(f);
  await run(f.hub, f.owner.id, "set_outing_delivery", {
    outingId: o.id,
    mode: "codex",
  });
  await f.hub.invite(f.owner.id, {
    outingId: o.id,
    participantIds: [a.id, b.id],
  });
  await pump(f.hub, { sync: true });
  assert.equal(sends, 0);
  const list = await run(f.hub, f.owner.id, "list_connector_deliveries");
  const mail = list.deliveries.find(
    (x) =>
      x.kind === "email" &&
      f.hub.data.messages.find((m) => m.id === x.id)?.to === a.email,
  );
  const cm = await run(f.hub, f.owner.id, "claim_connector_delivery", {
    kind: "email",
    deliveryId: mail.id,
  });
  assert.equal(cm.to, a.email);
  assert.equal(cm.recoveryRequired, false);
  await assert.rejects(
    run(f.hub, a.id, "claim_connector_delivery", {
      kind: "email",
      deliveryId: mail.id,
    }),
    /not found/,
  );
  assert.equal(
    (
      await run(f.hub, f.owner.id, "claim_connector_delivery", {
        kind: "email",
        deliveryId: mail.id,
      })
    ).recoveryRequired,
    true,
  );
  const receipt = {
    kind: "email",
    deliveryId: mail.id,
    claimToken: cm.claimToken,
    outcome: "sent",
    providerId: "gmail-evidence-123",
  };
  await run(f.hub, f.owner.id, "record_connector_delivery", receipt);
  await run(f.hub, f.owner.id, "record_connector_delivery", receipt);
  assert.equal(
    f.hub.data.messages.find((m) => m.id === mail.id).providerId,
    "gmail-evidence-123",
  );
  const c = await run(f.hub, f.owner.id, "claim_connector_delivery", {
    kind: "calendar",
    deliveryId: o.id,
  });
  assert.equal(c.action, "create");
  assert.deepEqual(
    c.attendees.map((p) => p.email),
    [b.email],
  );
  o.title = "Updated observing title";
  f.hub.queueCalendar(o);
  await run(f.hub, f.owner.id, "record_connector_delivery", {
    kind: "calendar",
    deliveryId: o.id,
    claimToken: c.claimToken,
    outcome: "sent",
    providerId: "google-event-123",
  });
  assert.equal(o.calendar.state, "codex_pending");
  assert.equal(
    f.hub.view(o.id, f.owner.id).calendar.id,
    "google-event-123",
  );
  const update = await run(f.hub, f.owner.id, "claim_connector_delivery", {
    kind: "calendar",
    deliveryId: o.id,
  });
  assert.equal(update.action, "update");
  assert.equal(update.eventId, "google-event-123");
  await run(f.hub, f.owner.id, "record_connector_delivery", {
    kind: "calendar",
    deliveryId: o.id,
    claimToken: update.claimToken,
    outcome: "sent",
    providerId: update.eventId,
  });
  await run(f.hub, f.owner.id, "import_calendar_responses", {
    outingId: o.id,
    revision: o.revision,
    readAt: new Date().toISOString(),
    event: {
      id: "google-event-123",
      attendees: [{ email: b.email, responseStatus: "accepted" }],
    },
  });
  assert.equal(
    o.people.find((p) => p.userId === b.id).response,
    "accepted",
  );
  await f.hub.cancel(f.owner.id, {
    outingId: o.id,
    reason: "Test complete",
  });
  const cancel = await run(f.hub, f.owner.id, "claim_connector_delivery", {
    kind: "calendar",
    deliveryId: o.id,
  });
  assert.equal(cancel.action, "cancel");
  assert.equal(cancel.eventId, "google-event-123");
  await run(f.hub, f.owner.id, "record_connector_delivery", {
    kind: "calendar",
    deliveryId: o.id,
    claimToken: cancel.claimToken,
    outcome: "sent",
    providerId: cancel.eventId,
  });
  await pump(f.hub, { sync: true });
  assert.equal(sends, 0);
});

test("Calendar preference can be retained while joining before the organizer connects Google", async (t) => {
  const f = await solverFixture();
  t.after(f.close);
  const o = await openDraft(f);
  await f.hub.invite(f.owner.id, { outingId: o.id, participantIds: [] });
  const guest = f.hub.identity.user("joining@fixture.test");
  assert.equal(f.hub.joinOptions(guest.id, o.id).calendarAvailable, false);
  const details = {
    name: "Joining",
    mode: "self",
    channel: "calendar",
    confirmed: true,
  };
  await f.hub.previewJoin(guest.id, { outingId: o.id, details });
  await f.hub.join(guest.id, { outingId: o.id, details });
  await pump(f.hub);
  assert.equal(
    o.people.find((p) => p.userId === guest.id).channel,
    "calendar",
  );
  assert.equal(o.calendar.state, "needs_connection");
  assert.equal(
    f.hub.data.messages.some((m) => m.to === guest.email),
    false,
  );
  let created = 0;
  f.hub.providers.status = () => ({ googleConnected: true });
  f.hub.providers.calendar = async (uid, method, id, payload) => {
    if (method === "GET")
      throw Object.assign(Error("Missing"), { status: 404 });
    created++;
    return { id, ...payload };
  };
  await pump(f.hub);
  assert.equal(o.calendar.state, "sent");
  assert.equal(created, 1);
});

test("public MCP exposes sign-in only, creates no session on GET, and preserves auth boundaries", async (t) => {
  const f = await solverFixture();
  f.store.close();
  const app = await createHub({
    directory: f.directory,
    port: 0,
    solvers: f.solvers,
    geo: f.geo,
    forecast: f.forecast,
    providers: {
      status: () => ({ googleConnected: false }),
      mail: async () => ({ delivery: "local_only" }),
    },
  });
  t.after(async () => {
    await app.close();
    await rm(f.directory, { recursive: true, force: true });
  });
  const rpc = (method, params) =>
    fetch(app.url + "/mcp", {
      method: "POST",
      headers: {
        Origin: app.url,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
  const listed = await (await rpc("tools/list", {})).json();
  assert.deepEqual(
    listed.result.tools.map((t) => t.name),
    ["request_signin"],
  );
  const requested = await (
    await rpc("tools/call", {
      name: "request_signin",
      arguments: { email: "new@fixture.test" },
    })
  ).json();
  assert.equal(Boolean(requested.result.isError), false);
  const mail = app.hub.data.messages.find(
    (m) => m.to === "new@fixture.test",
  );
  assert.ok(mail.link);
  await fetch(mail.link);
  assert.equal(app.hub.data.sessions.length, 0);
  assert.equal(
    (await rpc("tools/call", { name: "get_state", arguments: {} })).status,
    401,
  );
});

test("uncertain connector sends survive reload and cannot be reassigned without reconciliation", async (t) => {
  const f = await solverFixture();
  t.after(f.close);
  const a = await friend(f, "recover@fixture.test");
  const o = await openDraft(f);
  await f.hub.connectorDelivery.configure(f.owner.id, o.id, "codex");
  await f.hub.invite(f.owner.id, {
    outingId: o.id,
    participantIds: [a.id],
  });
  const pending = f.hub.connectorDelivery
    .list(f.owner.id)
    .deliveries.find((x) => x.kind === "email");
  const claim = await f.hub.connectorDelivery.claim(f.owner.id, {
    kind: "email",
    deliveryId: pending.id,
  });
  await f.hub.connectorDelivery.complete(f.owner.id, {
    kind: "email",
    deliveryId: pending.id,
    claimToken: claim.claimToken,
    outcome: "uncertain",
  });
  const { Store } = await import("../web/server/store.js");
  const reloaded = await new Store(f.directory).load();
  assert.equal(
    reloaded.community.messages.find((m) => m.id === pending.id)
      .externalClaim.token,
    claim.claimToken,
  );
  reloaded.close();
  await assert.rejects(
    f.hub.connectorDelivery.configure(f.owner.id, o.id, "server"),
    /Reconcile/,
  );
  assert.equal(
    (
      await f.hub.connectorDelivery.claim(f.owner.id, {
        kind: "email",
        deliveryId: pending.id,
      })
    ).recoveryRequired,
    true,
  );
  await assert.rejects(
    f.hub.connectorDelivery.complete(f.owner.id, {
      kind: "email",
      deliveryId: pending.id,
      claimToken: claim.claimToken,
      outcome: "not_sent",
    }),
    /verified/,
  );
  await f.hub.connectorDelivery.complete(f.owner.id, {
    kind: "email",
    deliveryId: pending.id,
    claimToken: claim.claimToken,
    outcome: "not_sent",
    recoveryNote:
      "Fixture provider confirms request was rejected before send.",
  });
  const fresh = await f.hub.connectorDelivery.claim(f.owner.id, {
    kind: "email",
    deliveryId: pending.id,
  });
  assert.notEqual(fresh.claimToken, claim.claimToken);
  assert.equal(fresh.recoveryRequired, false);
});

test("a failed draft write can be retried without creating duplicate in-memory outings", async (t) => {
  const f = await solverFixture();
  t.after(f.close);
  const s = await f.hub.clientPlanning.begin(f.owner.id, f.input);
  await f.hub.clientPlanning.run(
    f.owner.id,
    s.planningId,
    "discover_sites",
    {},
  );
  const c = await f.hub.clientPlanning.run(
    f.owner.id,
    s.planningId,
    "evaluate_candidate",
    {
      siteId: "spot-0",
      start: `${f.day}T20:00:00Z`,
      participantIds: [f.owner.id],
      transports: { [f.owner.id]: "walk" },
    },
  );
  const save = f.store.persist.bind(f.store);
  f.store.persist = async () => {
    throw Error("Disk failure");
  };
  const args = {
    planningId: s.planningId,
    candidateId: c.candidateId,
    explanation: "Checked choice",
  };
  await assert.rejects(
    f.hub.clientPlanning.save(f.owner.id, args),
    /Disk failure/,
  );
  assert.equal(f.hub.data.outings.length, 0);
  f.store.persist = save;
  await f.hub.clientPlanning.save(f.owner.id, args);
  assert.equal(f.hub.data.outings.length, 1);
});

test("local MCP client can save a cloudy draft and sees the same invitation decision", async t => {
  const f = await solverFixture({run:async()=>assert.fail("No background model")});
  t.after(f.close);
  f.hub.forecast = async () => {
    const forecast = await f.forecast();
    forecast.hours.forEach(h => {h.cloud_cover=72;});
    return forecast;
  };
  const session = await run(f.hub,f.owner.id,"begin_planning",f.input);
  await run(f.hub,f.owner.id,"find_planning_sites",{planningId:session.planningId});
  const checked = await run(f.hub,f.owner.id,"check_plan_candidate",{
    planningId:session.planningId,siteId:"spot-1",start:`${f.day}T20:00:00Z`,
    participantIds:[f.owner.id],transports:{[f.owner.id]:"walk"},
  });
  assert.equal(checked.status,"needs_weather_review");
  const draft = await run(f.hub,f.owner.id,"save_plan_candidate",{
    planningId:session.planningId,candidateId:checked.candidateId,
    explanation:"The walk and timing fit; the cloudy forecast needs your decision before inviting.",
  });
  assert.equal(draft.status,"draft");
  assert.equal(draft.solver.execution,"client");
  assert.equal(f.hub.data.messages.length,0);
  const args={outingId:draft.id,participantIds:[],confirmAccess:true};
  await assert.rejects(run(f.hub,f.owner.id,"invite_outing",args),/acknowledge/);
  const opened = await run(f.hub,f.owner.id,"invite_outing",{...args,weatherConfirmation:draft.weatherConfirmationKey});
  assert.equal(opened.weatherAccepted,true);
});
