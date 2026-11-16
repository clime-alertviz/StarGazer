import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../web/server/store.js";
import { Community } from "../web/server/community.js";
import { createHub } from "../web/hub.js";
import { operations } from "../web/server/mcp.js";
import { expandSlots } from "../web/server/availability.js";
import {
  calendarPayload,
  deliverCalendar,
  syncCalendar,
  pump,
} from "../web/server/delivery.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const day = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10),
  start = `${day}T19:00:00Z`,
  end = `${day}T20:00:00Z`;
const site = {
  id: "meadow",
  name: "Public meadow",
  location: { lat: 50.1, lon: 14.4 },
  meetingPoint: { lat: 50.1, lon: 14.4 },
  walkMinutes: 5,
  access: "confirmed",
  accessNote: "Public night access checked for this evening.",
  accessWindows: [
    {
      start: `${day}T15:00:00Z`,
      end: new Date(Date.parse(start) + 12 * 3600000).toISOString(),
    },
  ],
  bortle: null,
  skyQualitySource: null,
};
function preferences(name, extras = {}) {
  return {
    name,
    avatar: "star",
    timezone: "Europe/Prague",
    interests: ["Stargazing"],
    interestNote: "",
    experience: "experienced",
    happyToTeach: true,
    equipment: ["telescope"],
    shareEquipment: true,
    channel: "email",
    origin: {
      name: "Public station",
      location: { lat: 50.101, lon: 14.401 },
    },
    slots: [{ date: day, from: "16:00", until: "03:00", weekly: false }],
    travel: ["drive"],
    car: {
      available: true,
      offerRides: true,
      passengerSeats: 2,
      maxDetourMinutes: 30,
      pickupPoints: [],
    },
    maxTravelMinutes: 90,
    maxWalkMinutes: 30,
    preference: "balanced",
    ...extras,
  };
}
function geo() {
  const units = { time_units: "seconds", distance_units: "meters" };
  const leg = (a, b) => ({
    time: a.lat === b.lat && a.lon === b.lon ? 0 : 300,
    distance: 500,
  });
  return {
    autocomplete: async () => [
      { name: "Public station", location: { lat: 50.1, lon: 14.4 } },
    ],
    call: async (name, args) =>
      name === "calculate_route_matrix"
        ? {
            ...units,
            sources_to_targets: args.sources.map((a) =>
              args.targets.map((b) => leg(a, b)),
            ),
          }
        : {
            ...units,
            legs: args.waypoints
              .slice(1)
              .map((p, i) => leg(args.waypoints[i], p)),
            time: (args.waypoints.length - 1) * 300,
            distance: (args.waypoints.length - 1) * 500,
          },
  };
}
function forecast() {
  return Promise.resolve({
    source: "Fixture",
    fetchedAt: new Date().toISOString(),
    hours: Array.from({ length: 400 }, (_, i) => ({
      at: new Date(
        Math.floor(Date.now() / 3600000) * 3600000 + i * 3600000,
      ).toISOString(),
      cloud_cover: 5,
      wind_speed_10m: 5,
      temperature_2m: 8,
      precipitation_probability: 0,
      precipitation: 0,
      visibility: 20000,
    })),
  });
}
function provider() {
  const events = new Map(),
    calls = [];
  return {
    events,
    calls,
    status: () => ({
      googleConfigured: true,
      googleConnected: true,
      email: "local_outbox",
    }),
    mail: async () => ({ delivery: "local_only" }),
    calendar: async (user, method, id, payload) => {
      calls.push({ user, method, id, payload });
      if (method === "GET") {
        if (!events.has(id))
          throw Object.assign(new Error("Not found"), {
            status: 404,
          });
        return structuredClone(events.get(id));
      }
      if (method === "DELETE") {
        events.delete(id);
        return {};
      }
      const next =
        method === "POST" ? payload : { ...events.get(id), ...payload };
      events.set(id || payload.id, { ...next, etag: "v1" });
      return structuredClone(next);
    },
  };
}
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "sg-community-")),
    store = await new Store(directory).load(),
    providers = provider(),
    hub = new Community(store, {
      geo: geo(),
      forecast,
      providers,
      solver: "deterministic",
    });
  hub.setBase("http://localhost:4317");
  const owner = hub.identity.user("owner@fixture.test"),
    guest = hub.identity.user("guest@fixture.test"),
    other = hub.identity.user("other@fixture.test");
  for (const u of [owner, guest, other])
    await hub.saveProfile(u.id, preferences(u.email.split("@")[0]));
  t.after(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { hub, store, directory, providers, owner, guest, other };
}
async function outing(f, options = {}) {
  const view = await f.hub.plan(f.owner.id, {
    target: "stargazing",
    start: new Date(Date.parse(start) - 2 * 3600000).toISOString(),
    end: new Date(Date.parse(end) + 5 * 3600000).toISOString(),
    site,
    minPeople: 2,
    maxPeople: 2,
    ...options,
  });
  assert.notEqual(view.status, "no_match", JSON.stringify(view));
  return f.hub.outing(view.id);
}
async function publish(f, o, ids = []) {
  return f.hub.invite(f.owner.id, {
    outingId: o.id,
    participantIds: ids,
    visibility: "open",
  });
}

test("joining requires a fresh review when provider routes change after the displayed preview", async (t) => {
  const f = await fixture(t),
    o = await outing(f);
  await publish(f, o);
  const details = {
    name: "Rider",
    mode: "ride",
    origin: f.guest.preferences.origin,
    confirmed: true,
    channel: "email",
    maxWalkMinutes: 30,
    maxTravelMinutes: 90,
  };
  const preview = await f.hub.previewJoin(f.guest.id, {
    outingId: o.id,
    details,
  });
  const call = f.hub.geo.call;
  f.hub.geo.call = async (name, args) => {
    const result = await call(name, args);
    if (result.sources_to_targets)
      for (const row of result.sources_to_targets)
        for (const cell of row) cell.time *= 2;
    else {
      result.time *= 2;
      for (const leg of result.legs) leg.time *= 2;
    }
    return result;
  };
  const messages = f.hub.data.messages.length;
  await assert.rejects(
    f.hub.join(f.guest.id, {
      outingId: o.id,
      details,
      expectedVersion: preview.version,
      expectedPreview: preview.previewKey,
    }),
    /changed since the preview/,
  );
  assert.equal(o.people.length, 1);
  assert.equal(f.hub.data.messages.length, messages);
  const revised = await f.hub.previewJoin(f.guest.id, {
    outingId: o.id,
    details,
  });
  assert.notEqual(revised.previewKey, preview.previewKey);
  await f.hub.join(f.guest.id, {
    outingId: o.id,
    details,
    expectedVersion: revised.version,
    expectedPreview: revised.previewKey,
  });
  const actual = f.hub.view(o.id, f.guest.id).routes[0];
  assert.equal(actual.departAt, revised.route.departAt);
  assert.equal(actual.homeBy, revised.route.homeBy);
});

test("explicit join answers override saved channel, equipment and travel without changing profile defaults", async (t) => {
  const f = await fixture(t),
    o = await outing(f);
  await publish(f, o);
  const saved = structuredClone(f.guest.preferences);
  const details = {
    name: "Guest",
    mode: "self",
    confirmed: true,
    channel: "calendar",
    equipment: [],
    shareEquipment: false,
    happyToTeach: false,
  };
  const preview = await f.hub.previewJoin(f.guest.id, {
    outingId: o.id,
    details,
  });
  await f.hub.join(f.guest.id, {
    outingId: o.id,
    details,
    expectedVersion: preview.version,
    expectedPreview: preview.previewKey,
  });
  const person = f.hub
    .view(o.id, f.guest.id)
    .people.find((p) => p.id === f.guest.id);
  assert.equal(person.channel, "calendar");
  assert.equal(person.transport, "self");
  assert.deepEqual(person.equipment, []);
  assert.deepEqual(person.roles, []);
  assert.deepEqual(f.guest.preferences, saved);
});

test("discovery and its agent use only the visible form snapshot, including cleared saved values", async (t) => {
  const f = await fixture(t),
    o = await outing(f);
  await publish(f, o);
  f.guest.preferences.slots = [
    { date: "2020-01-01", from: "12:00", until: "12:30", weekly: false },
  ];
  assert.equal((await f.hub.discoverCandidates(f.guest.id)).length, 0);
  const form = { name: "Guest", interests: ["Stargazing"] };
  f.hub.solvers.rank = (id, actual, candidates) => {
    assert.deepEqual(actual, form);
    assert.equal(actual.origin, undefined);
    assert.equal(actual.slots, undefined);
    return candidates;
  };
  const operation = operations(f.hub, f.guest.id).find_outings;
  const found = await operation.run(
    operation.schema.parse({ preferences: form }),
  );
  assert.equal(found.length, 1);
  assert.ok(
    !found[0].matchReasons.some((reason) =>
      /km away|overlaps/.test(reason),
    ),
  );
  assert.equal(f.guest.preferences.slots[0].date, "2020-01-01");
});

test("edits use the organizer's explicit availability while preserving every other person's limits", async (t) => {
  const f = await fixture(t);
  await f.hub.circleInvite(f.owner.id, { email: f.guest.email });
  await f.hub.circleRespond(f.guest.id, {
    invitationId: f.hub.data.connections[0].id,
    accept: true,
  });
  const o = await outing(f),
    saved = structuredClone(f.owner.preferences);
  const shift = (value) =>
    new Date(Date.parse(value) + 86400000).toISOString();
  const next = {
    outingId: o.id,
    start: shift(o.start),
    end: shift(o.end),
    site: {
      ...o.site,
      accessWindows: o.site.accessWindows.map((w) => ({
        start: shift(w.start),
        end: shift(w.end),
      })),
    },
  };
  const availability = {
    start: shift(o.people[0].availability[0].start),
    end: shift(o.people[0].availability[0].end),
  };
  await assert.rejects(
    f.hub.edit(f.owner.id, { ...next, availability }),
    /availability|available evening/,
  );
  assert.notEqual(o.start, next.start);
  o.people.find((p) => p.userId === f.guest.id).response = "declined";
  await assert.rejects(
    f.hub.edit(f.owner.id, next),
    /availability|available evening/,
  );
  await f.hub.edit(f.owner.id, { ...next, availability });
  assert.equal(o.start, next.start);
  assert.deepEqual(
    f.hub.view(o.id, f.owner.id).people.find((p) => p.id === f.owner.id)
      .availability,
    [availability],
  );
  assert.ok(
    Date.parse(o.routes[0].departAt) >= Date.parse(availability.start),
  );
  assert.ok(Date.parse(o.routes[0].homeBy) <= Date.parse(availability.end));
  assert.deepEqual(f.owner.preferences, saved);
  assert.equal(
    o.people.find((p) => p.userId === f.guest.id).preferences.slots[0].date,
    day,
  );
});

test("Calendar descriptions and page reports use the same outing offers and local meeting times", async (t) => {
  const f = await fixture(t),
    o = await outing(f);
  await publish(f, o);
  await f.hub.join(f.guest.id, {
    outingId: o.id,
    details: {
      name: "Rider",
      mode: "ride",
      origin: f.guest.preferences.origin,
      confirmed: true,
      channel: "calendar",
      equipment: ["binoculars"],
      shareEquipment: true,
    },
  });
  await f.hub.saveProfile(f.guest.id, {
    ...f.guest.preferences,
    equipment: ["camera"],
    channel: "email",
  });
  const page = f.hub.view(o.id, f.guest.id),
    payload = calendarPayload(f.hub, o, "check");
  const format = (value) =>
    new Intl.DateTimeFormat("en-GB", {
      timeZone: o.timezone,
      dateStyle: "medium",
      timeStyle: "short",
      hour12: false,
    }).format(new Date(value));
  assert.equal(payload.start.dateTime, page.meeting.meetAt);
  assert.equal(payload.end.dateTime, page.meeting.leaveAt);
  assert.ok(
    payload.description.includes(
      `Observing: ${format(page.start)} – ${format(page.end)}`,
    ),
  );
  for (const item of page.equipment)
    assert.ok(payload.description.includes(item));
  assert.ok(payload.description.includes("Rider: Public station at"));
  assert.ok(!payload.description.includes("undefined"));
  assert.ok(!payload.description.includes("camera"));
  assert.deepEqual(page.people.find((p) => p.id === f.guest.id).equipment, [
    "binoculars",
  ]);
  assert.ok(payload.attendees.some((p) => p.email === f.guest.email));
  await f.hub.respond(f.guest.id, {
    outingId: o.id,
    response: "declined",
    revision: o.revision,
  });
  assert.ok(
    !calendarPayload(f.hub, o, "next").description.includes("binoculars"),
  );
});

test("weekly availability stays at local clock time across DST, with compatible clock changes", () => {
  const slots = expandSlots(
    [
      {
        date: "2027-03-21",
        from: "20:00",
        until: "02:00",
        weekly: true,
      },
    ],
    "Europe/Prague",
    "2027-03-20T00:00:00Z",
    "2027-04-05T00:00:00Z",
  );
  assert.equal(slots[0].start, "2027-03-21T19:00:00Z");
  assert.equal(slots[1].start, "2027-03-28T18:00:00Z");
  assert.equal(
    expandSlots(
      [
        {
          date: "2027-03-28",
          from: "02:30",
          until: "04:00",
          weekly: false,
        },
      ],
      "Europe/Prague",
      "2027-03-27T00:00:00Z",
      "2027-03-29T00:00:00Z",
    )[0].start,
    "2027-03-28T01:30:00Z",
  );
});
test("empty-circle organizer can publish; final free place is atomic across competing joins", async (t) => {
  const f = await fixture(t),
    o = await outing(f);
  assert.equal(o.status, "draft");
  assert.equal(o.deadline, undefined);
  await publish(f, o);
  const results = await Promise.allSettled([
    f.hub.join(f.guest.id, { outingId: o.id }),
    f.hub.join(f.other.id, { outingId: o.id }),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(o.people.length, 2);
  assert.equal(o.status, "confirmed");
  assert.ok(
    f.hub.data.messages.some((m) => m.subject === "Your group is full"),
  );
});
test("circle invites create mutual membership only after recipient acceptance and gate private outings", async (t) => {
  const f = await fixture(t),
    o = await outing(f, { visibility: "circle" });
  await f.hub.invite(f.owner.id, {
    outingId: o.id,
    participantIds: [],
    visibility: "circle",
  });
  assert.throws(() => f.hub.view(o.id, f.guest.id), /private/);
  const c = await f.hub.circleInvite(f.owner.id, {
    email: f.guest.email,
  });
  await assert.rejects(
    () =>
      f.hub.circleRespond(f.other.id, {
        invitationId: c.id,
        accept: true,
      }),
    /not found/,
  );
  await f.hub.circleRespond(f.guest.id, {
    invitationId: c.id,
    accept: true,
  });
  assert.deepEqual(f.hub.friends(f.guest.id), [f.owner.id]);
  assert.ok(f.hub.view(o.id, f.guest.id));
});
test("pending invitation reserves a place; expiry releases it before the outing deadline", async (t) => {
  const f = await fixture(t);
  const c = await f.hub.circleInvite(f.owner.id, {
    email: f.guest.email,
  });
  await f.hub.circleRespond(f.guest.id, {
    invitationId: c.id,
    accept: true,
  });
  const o = await outing(f);
  await publish(f, o, [f.guest.id]);
  assert.equal(f.hub.capacity(o), 2);
  await assert.rejects(
    () => f.hub.join(f.other.id, { outingId: o.id }),
    /full/,
  );
  const p = o.people.find((p) => p.userId === f.guest.id);
  f.hub.evaluate(o, Date.parse(p.reservedUntil) + 1);
  assert.equal(p.response, "expired");
  assert.equal(o.status, "invited");
  assert.equal(f.hub.capacity(o), 1);
  await f.hub.join(f.other.id, { outingId: o.id });
  assert.equal(o.status, "confirmed");
});
test("Maybe reservations expire, while the organizer always occupies a place", async (t) => {
  const f = await fixture(t),
    o = await outing(f);
  await publish(f, o);
  await f.hub.join(f.guest.id, { outingId: o.id });
  await f.hub.respond(f.guest.id, {
    outingId: o.id,
    response: "tentative",
    revision: 1,
  });
  const guest = o.people.find((p) => p.userId === f.guest.id);
  assert.ok(Date.parse(guest.reservedUntil) > Date.now());
  f.hub.evaluate(o, Date.parse(guest.reservedUntil) + 1);
  assert.equal(guest.response, "expired");
  assert.equal(f.hub.capacity(o), 1);
  const owner = o.people.find((p) => p.userId === f.owner.id);
  owner.response = "pending";
  owner.reservedUntil = new Date(Date.now() - 1000).toISOString();
  f.hub.evaluate(o);
  assert.equal(owner.response, "pending");
  assert.equal(f.hub.capacity(o), 1);
  owner.response = "declined";
  assert.equal(f.hub.capacity(o), 1);
  await f.hub.respond(f.owner.id, {
    outingId: o.id,
    response: "accepted",
    revision: 1,
  });
  assert.equal(owner.response, "accepted");
  assert.equal(f.hub.view(o.id, f.guest.id).canJoin, true);
});

test("recommended group includes compatible circle members before solo open planning", async (t) => {
  const f = await fixture(t);
  await f.hub.circleInvite(f.owner.id, { email: f.guest.email });
  const invitation = f.hub.state(f.guest.id).circleInvitations[0];
  await f.hub.circleRespond(f.guest.id, {
    invitationId: invitation.id,
    accept: true,
  });
  const o = await outing(f);
  assert.equal(o.people.length, 2);
  await publish(f, o, [f.guest.id]);
  await f.hub.respond(f.guest.id, {
    outingId: o.id,
    response: "declined",
    revision: 1,
  });
  await publish(f, o);
  assert.equal(
    o.people.find((p) => p.userId === f.guest.id).response,
    "declined",
  );
});

test("passenger joins only with a feasible offered seat and a public pickup", async (t) => {
  const f = await fixture(t),
    o = await outing(f);
  await publish(f, o);
  await f.hub.saveProfile(
    f.guest.id,
    preferences("Passenger", { travel: ["ride"], equipment: [] }),
  );
  o.people[0].preferences.car.passengerSeats = 0;
  o.people[0].preferences.car.offerRides = false;
  await assert.rejects(
    () => f.hub.join(f.guest.id, { outingId: o.id }),
    /journey/,
  );
  o.people[0].preferences.car.passengerSeats = 1;
  o.people[0].preferences.car.offerRides = true;
  await f.hub.join(f.guest.id, { outingId: o.id });
  assert.equal(o.carpools[0].passengerIds[0], f.guest.id);
  assert.equal(o.carpools[0].pickups[0].pickup.name, "Public station");
});
test("inviting checks a friend's availability before routing and preserves the draft on failure", async (t) => {
  const f = await fixture(t), o = await outing(f);
  const connection = await f.hub.circleInvite(f.owner.id, { email: f.guest.email });
  await f.hub.circleRespond(f.guest.id, { invitationId: connection.id, accept: true });
  // A leftover short profile slot cannot cover this evening, regardless of
  // transport. A distant origin must not turn that into an opaque provider error.
  f.guest.preferences.slots = [{ date: day, from: '18:00', until: '18:30', weekly: false }];
  f.guest.preferences.origin = { name: 'Distant public station', location: { lat: 49.15, lon: 16.88 } };
  const before = JSON.stringify(o), messages = JSON.stringify(f.hub.data.messages);
  let queries = 0;
  const geo = f.hub.geo;
  f.hub.geo = { call: async () => { queries++; throw new Error('Routing should not be requested.'); } };
  await assert.rejects(publish(f, o, [f.guest.id]), error => {
    assert.match(error.message, /guest’s available evening/);
    assert.match(error.message, /meet by.*stay until.*Europe\/Prague/);
    assert.match(error.message, /leave them out of this invitation/);
    return true;
  });
  assert.equal(queries, 0);
  assert.equal(JSON.stringify(o), before);
  assert.equal(JSON.stringify(f.hub.data.messages), messages);
  // Leaving out the incompatible invitee still allows the open outing to be published.
  f.hub.geo = geo;
  await publish(f, o);
  assert.equal(o.status, 'invited');
  assert.equal(o.people.length, 1);
});

test("friends with no logistics can be invited and complete their reserved place with a short join", async (t) => {
  const f = await fixture(t), o = await outing(f);
  f.guest.preferences = null;
  const c = await f.hub.circleInvite(f.owner.id, { email: f.guest.email });
  await f.hub.circleRespond(f.guest.id, { invitationId: c.id, accept: true });
  assert.deepEqual(f.hub.state(f.owner.id).circle[0].missingDetails, ['availability', 'starting point', 'travel method']);
  const real = f.hub.geo.call;
  f.hub.geo.call = async (name, args) => {
    for (const point of args.sources || args.waypoints)
      assert.ok([f.owner.preferences.origin.location, o.site.meetingPoint].some(p => p.lat === point.lat && p.lon === point.lon));
    return real(name, args);
  };
  await publish(f, o, [f.guest.id]);
  const member = o.people.find(p => p.userId === f.guest.id);
  assert.equal(member.needsDetails, true);
  assert.equal(member.preferences.origin, undefined);
  assert.equal(member.preferences.slots, undefined);
  assert.equal(member.preferences.travel, undefined);
  assert.equal(member.transport, undefined);
  assert.equal(f.guest.preferences, null);
  assert.equal(o.routes.length, 1);
  assert.equal(o.status, 'invited');
  assert.equal(f.hub.capacity(o), o.maxPeople);
  assert.equal(f.hub.view(o.id, f.guest.id).canJoin, true);
  await assert.rejects(f.hub.respond(f.guest.id, { outingId:o.id, response:'accepted', revision:o.revision }), /Confirm your meeting times and travel choice/);
  const details = { name:'Guest', mode:'self', confirmed:true, channel:'email' };
  const preview = await f.hub.previewJoin(f.guest.id, { outingId:o.id, details });
  await f.hub.join(f.guest.id, { outingId:o.id, details, expectedVersion:preview.version, expectedPreview:preview.previewKey });
  assert.equal(o.people.length, 2);
  assert.equal(o.status, 'confirmed');
  assert.equal(o.people.find(p => p.userId === f.guest.id).response, 'accepted');
  assert.equal(o.people.find(p => p.userId === f.guest.id).needsDetails, undefined);
  assert.equal(f.guest.preferences.origin, undefined);
  assert.equal(f.guest.preferences.slots, undefined);
});

test("Calendar acceptance cannot turn missing journey details into a confirmed participant", async (t) => {
  const f = await fixture(t), o = await outing(f);
  f.guest.preferences = { name:'Guest', channel:'calendar' };
  const c = await f.hub.circleInvite(f.owner.id, { email:f.guest.email });
  await f.hub.circleRespond(f.guest.id, { invitationId:c.id, accept:true });
  await publish(f, o, [f.guest.id]);
  await deliverCalendar(f.hub, o.id);
  f.providers.events.get(o.calendar.id).attendees[0].responseStatus = 'accepted';
  assert.match(f.providers.events.get(o.calendar.id).description, /availability and journey have not been checked/);
  await syncCalendar(f.hub, o.id);
  const member = o.people.find(p => p.userId === f.guest.id);
  assert.equal(member.response, 'accepted');
  assert.equal(member.needsDetails, true);
  assert.equal(o.status, 'invited');
  const view=f.hub.view(o.id, f.guest.id);
  assert.equal(view.people.find(p => p.id === f.guest.id).confirmed, false);
  assert.equal(view.canJoin, true);
});

test("expired invitations with missing details do not bypass a full group's capacity", async (t) => {
  const f = await fixture(t), o = await outing(f);
  f.guest.preferences = null;
  const c = await f.hub.circleInvite(f.owner.id, { email:f.guest.email });
  await f.hub.circleRespond(f.guest.id, { invitationId:c.id, accept:true });
  await publish(f, o, [f.guest.id]);
  o.people.find(p => p.userId === f.guest.id).reservedUntil=new Date(Date.now()-1).toISOString();
  f.hub.evaluate(o);
  await f.hub.join(f.other.id, { outingId:o.id });
  const details={name:'Guest',mode:'self',confirmed:true};
  assert.equal(f.hub.view(o.id,f.guest.id).canJoin,false);
  await assert.rejects(f.hub.previewJoin(f.guest.id,{outingId:o.id,details}),/no open place/);
  await assert.rejects(f.hub.join(f.guest.id,{outingId:o.id,details}),/full/);
});

test("fixed availability checks include the final walk, setup and pack-up before provider calls", async (t) => {
  const f = await fixture(t), o = await outing(f);
  const baseline = structuredClone(o.people);
  let queries = 0;
  f.hub.geo = { call: async () => { queries++; throw new Error('Routing should not be requested.'); } };
  for (const boundary of ['start', 'end']) {
    const people = structuredClone(baseline);
    people[0].availability = [{
      start: new Date(Date.parse(o.start) - (15 + o.site.walkMinutes) * 60000).toISOString(),
      end: new Date(Date.parse(o.end) + (15 + o.site.walkMinutes) * 60000).toISOString(),
    }];
    const slot = people[0].availability[0];
    slot[boundary] = new Date(Date.parse(slot[boundary]) + (boundary === 'start' ? 1 : -1) * 60000).toISOString();
    await assert.rejects(f.hub.routesFor(o, people), /available evening.*journey/);
  }
  assert.equal(queries, 0);
});

test("joining checks setup, pack-up and return availability, not just observing overlap", async (t) => {
  const f = await fixture(t),
    o = await outing(f);
  await publish(f, o);
  await f.hub.saveProfile(
    f.guest.id,
    preferences("Guest", {
      slots: [{ date: day, from: "20:00", until: "21:00", weekly: false }],
    }),
  );
  await assert.rejects(
    () => f.hub.join(f.guest.id, { outingId: o.id }),
    /journey/,
  );
  assert.equal(o.people.length, 1);
});

test("a Calendar-channel driver hears about a passenger decline without a whole-group Calendar update", async (t) => {
  const f = await fixture(t);
  f.owner.preferences.channel = "calendar";
  await f.hub.saveProfile(
    f.guest.id,
    preferences("Rider", { travel: ["ride"], equipment: [] }),
  );
  const o = await outing(f);
  await publish(f, o);
  await f.hub.join(f.guest.id, { outingId: o.id });
  const desired = o.calendar.desired,
    before = f.hub.data.messages.length;
  await f.hub.respond(f.guest.id, {
    outingId: o.id,
    response: "declined",
    revision: o.revision,
  });
  const messages = f.hub.data.messages.slice(
    0,
    f.hub.data.messages.length - before,
  );
  assert.ok(
    messages.some(
      (m) =>
        m.recipientId === f.owner.id &&
        m.subject === "Your shared journey changed",
    ),
  );
  assert.equal(o.calendar.desired, desired);
  const count = f.hub.data.messages.length;
  await f.hub.respond(f.guest.id, {
    outingId: o.id,
    response: "declined",
    revision: o.revision,
  });
  assert.equal(f.hub.data.messages.length, count);
});
test("a needs-review outing closes after its end and rejects further responses", async (t) => {
  const f = await fixture(t),
    o = await outing(f);
  await publish(f, o);
  await f.hub.join(f.guest.id, { outingId: o.id });
  await f.hub.respond(f.guest.id, {
    outingId: o.id,
    response: "tentative",
    revision: 1,
  });
  assert.equal(o.status, "needs_review");
  f.hub.evaluate(o, Date.parse(o.end) + 1);
  assert.equal(o.status, "completed");
  await assert.rejects(
    () =>
      f.hub.respond(f.guest.id, {
        outingId: o.id,
        response: "accepted",
        revision: 1,
      }),
    /closed/,
  );
});

test("late app or Calendar acceptance cannot confirm a journey whose departure has passed", async (t) => {
  const f = await fixture(t),
    o = await outing(f);
  await f.hub.circleInvite(f.owner.id, { email: f.guest.email });
  await f.hub.circleRespond(f.guest.id, {
    invitationId: f.hub.state(f.guest.id).circleInvitations[0].id,
    accept: true,
  });
  f.guest.preferences.channel = "calendar";
  await publish(f, o, [f.guest.id]);
  await deliverCalendar(f.hub, o.id);
  o.routes.find((r) => r.participantId === f.guest.id).departAt = new Date(
    Date.now() - 60000,
  ).toISOString();
  await assert.rejects(
    () =>
      f.hub.respond(f.guest.id, {
        outingId: o.id,
        response: "accepted",
        revision: 1,
      }),
    /departure time has passed/,
  );
  f.providers.events.get(o.calendar.id).attendees[0].responseStatus =
    "accepted";
  await syncCalendar(f.hub, o.id);
  const p = o.people.find((p) => p.userId === f.guest.id);
  assert.equal(p.response, "pending");
  assert.match(p.conflict, /departure/);
  assert.notEqual(o.status, "confirmed");
});
test("uncertain Calendar writes reconcile by event ID and fingerprint, cancellation still reaches provider", async (t) => {
  const f = await fixture(t),
    o = await outing(f);
  await publish(f, o);
  await f.hub.join(f.guest.id, {
    outingId: o.id,
    preferences: preferences("Guest", { channel: "calendar" }),
  });
  const original = f.providers.calendar;
  let fail = true;
  f.providers.calendar = async (...args) => {
    const result = await original(...args);
    if (args[1] === "POST" && fail) {
      fail = false;
      throw new Error("Timeout after applied write");
    }
    return result;
  };
  await deliverCalendar(f.hub, o.id);
  assert.equal(o.calendar.state, "uncertain");
  await deliverCalendar(f.hub, o.id, { retry: true });
  assert.equal(o.calendar.state, "sent");
  assert.equal(
    f.providers.calls.filter((c) => c.method === "POST").length,
    1,
  );
  o.calendar.state = "uncertain";
  await f.hub.cancel(f.owner.id, {
    outingId: o.id,
    reason: "Cloudy",
  });
  await deliverCalendar(f.hub, o.id, { retry: true });
  assert.equal(o.calendar.state, "sent");
  assert.equal(f.providers.events.size, 0);
  assert.ok(f.providers.calls.some((c) => c.method === "DELETE"));
});
test("slow Calendar read does not block app RSVP; stale response does not overwrite it", async (t) => {
  const f = await fixture(t),
    o = await outing(f);
  await publish(f, o);
  await f.hub.join(f.guest.id, {
    outingId: o.id,
    preferences: preferences("Guest", { channel: "calendar" }),
  });
  await deliverCalendar(f.hub, o.id);
  let release;
  const original = f.providers.calendar;
  f.providers.calendar = async (...args) => {
    if (args[1] === "GET") {
      await new Promise((r) => (release = r));
      return {
        attendees: [{ email: f.guest.email, responseStatus: "accepted" }],
      };
    }
    return original(...args);
  };
  const pending = syncCalendar(f.hub, o.id);
  await f.hub.respond(f.guest.id, {
    outingId: o.id,
    response: "tentative",
    revision: 1,
  });
  assert.equal(o.people[1].response, "tentative");
  release();
  await pending;
  assert.equal(o.people[1].response, "tentative");
  assert.match(o.people[1].conflict, /Calendar/);
});
test("four-hour revision excludes decliners and requires fresh responses; astronomy is exposed", async (t) => {
  const f = await fixture(t),
    o = await outing(f);
  await publish(f, o);
  await f.hub.join(f.guest.id, { outingId: o.id });
  await f.hub.respond(f.guest.id, {
    outingId: o.id,
    response: "declined",
    revision: 1,
  });
  o.people[1].preferences.slots = [
    {
      date: "2020-01-01",
      from: "10:00",
      until: "11:00",
      weekly: false,
    },
  ];
  const nextEnd = new Date(Date.parse(start) + 4 * 3600000).toISOString();
  await f.hub.edit(f.owner.id, {
    outingId: o.id,
    start,
    end: nextEnd,
    site,
  });
  assert.equal(o.revision, 2);
  assert.equal(o.people[0].response, "pending");
  assert.equal(o.people[1].response, "declined");
  assert.ok(f.hub.view(o.id, f.owner.id).astronomy.sampleMinutes);
});
test("comments retain explicit parents; notify only organizer and reply author; profiles stay private", async (t) => {
  const f = await fixture(t),
    o = await outing(f);
  await publish(f, o);
  await f.hub.join(f.guest.id, { outingId: o.id });
  await f.hub.comment(f.guest.id, { outingId: o.id, text: "First" });
  const parent = o.comments[0].id;
  await f.hub.comment(f.owner.id, { outingId: o.id, text: "Second" });
  await f.hub.comment(f.owner.id, {
    outingId: o.id,
    text: "Reply to first",
    replyTo: parent,
  });
  assert.equal(o.comments[2].replyTo, parent);
  const view = f.hub.view(o.id, f.guest.id);
  assert.equal(view.people[0].preferences, undefined);
  assert.equal(view.people[0].email, undefined);
  assert.equal(view.routes.length, 1);
  await assert.rejects(
    () =>
      f.hub.comment(f.other.id, {
        outingId: o.id,
        text: "Intrusion",
      }),
    /Only invited/,
  );
});
test("notifications use one invitation channel and small RSVP oscillations do not spam the group", async (t) => {
  const f = await fixture(t),
    o = await outing(f);
  await publish(f, o);
  await f.hub.join(f.guest.id, {
    outingId: o.id,
    preferences: preferences("Guest", { channel: "calendar" }),
  });
  assert.equal(
    f.hub.data.messages.filter((m) => m.to === f.guest.email).length,
    0,
  );
  const before = f.hub.data.messages.filter(
    (m) => m.subject === "Outing confirmed",
  ).length;
  await f.hub.respond(f.guest.id, {
    outingId: o.id,
    response: "tentative",
    revision: 1,
  });
  await f.hub.respond(f.guest.id, {
    outingId: o.id,
    response: "accepted",
    revision: 1,
  });
  assert.equal(
    f.hub.data.messages.filter((m) => m.subject === "Outing confirmed")
      .length,
    before,
  );
});
test("real HTTP MCP uses the same signed-in user; token access cannot edit another organizer; scanner GET is safe", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "sg-hub-http-")),
    app = await createHub({
      solver: "deterministic",
      directory,
      port: 0,
      geo: geo(),
      forecast,
      providers: provider(),
    });
  t.after(async () => {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  });
  const post = (path, data, headers = {}) =>
    fetch(app.url + path, {
      method: "POST",
      headers: {
        Origin: app.url,
        "Content-Type": "application/json",
        ...headers,
      },
      body: JSON.stringify(data),
    });
  await post("/auth/request", { email: "person@fixture.test" });
  const link = app.hub.data.messages[0].link,
    token = new URL(link).hash.slice(1);
  await fetch(link);
  await fetch(link);
  assert.equal(app.hub.data.tokens.length, 1);
  const signed = await post("/auth/confirm", { token }),
    cookie = signed.headers.get("set-cookie").split(";")[0],
    auth = await signed.json();
  assert.equal((await post("/auth/confirm", { token })).status, 400);
  const issued = await (
    await post(
      "/auth/mcp-token",
      {},
      { cookie, "x-stargazer-csrf": auth.csrf },
    )
  ).json();
  const rpc = await post(
    "/mcp",
    {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "get_state", arguments: {} },
    },
    {
      Authorization: `Bearer ${issued.token}`,
      Accept: "application/json, text/event-stream",
    },
  );
  const data = await rpc.json();
  assert.equal(
    JSON.parse(data.result.content[0].text).user.email,
    "person@fixture.test",
  );
  const client = new Client({
    name: "shared-service-check",
    version: "1.0",
  });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: ["src/remote-client.js"],
      env: {
        PATH: process.env.PATH,
        STAR_GAZER_URL: app.url,
        STAR_GAZER_TOKEN: issued.token,
      },
      stderr: "pipe",
    }),
  );
  assert.ok(
    (await client.listTools()).tools.some((t) => t.name === "join_outing"),
  );
  const bridged = await client.callTool({
    name: "get_state",
    arguments: {},
  });
  assert.equal(JSON.parse(bridged.content[0].text).user.id, auth.user.id);
  await client.close();
  assert.equal(
    (await post("/mcp", {}, { Origin: "https://evil.example" })).status,
    403,
  );
  assert.equal((await post("/auth/mcp-token", {}, { cookie })).status, 403);
});
test("organizer permissions apply to every mutation, even with an outing ID", async (t) => {
  const f = await fixture(t),
    o = await outing(f);
  await publish(f, o);
  await assert.rejects(
    () =>
      f.hub.cancel(f.other.id, {
        outingId: o.id,
        reason: "Intrusion",
      }),
    /Only the organizer/,
  );
  await assert.rejects(
    () => f.hub.weather(f.guest.id, { outingId: o.id }),
    /Only the organizer/,
  );
  await assert.rejects(
    () =>
      f.hub.invite(f.guest.id, {
        outingId: o.id,
        participantIds: [],
      }),
    /Only the organizer/,
  );
  assert.equal(o.status, "invited");
});
test("connection tests use the selected timezone and invite a new guest without requiring a circle", async (t) => {
  const f = await fixture(t),
    view = await f.hub.createTest(f.owner.id, {
      guestEmail: "new@fixture.test",
      start,
      timezone: "America/New_York",
      channel: "calendar",
    }),
    o = f.hub.outing(view.id);
  await deliverCalendar(f.hub, o.id);
  const event = f.providers.events.get(o.calendar.id);
  assert.equal(event.start.timeZone, "America/New_York");
  assert.equal(event.start.dateTime, new Date(start).toISOString());
  assert.equal(event.attendees[0].email, "new@fixture.test");
  assert.equal(o.kind, "connection_test");
});
test("rate limiting does not enumerate accounts and sign-in returns to the invited outing", async (t) => {
  const f = await fixture(t),
    messages = [];
  for (let i = 0; i < 4; i++)
    for (const email of [f.owner.email, "new@fixture.test"]) {
      if (i < 3)
        messages.push(
          await f.hub.identity.request(email, "/outing/123abc"),
        );
      else
        await assert.rejects(
          f.hub.identity.request(email, "/outing/123abc"),
          (error) => error.status === 429 && error.retryAfter > 0,
        );
    }
  assert.equal(new Set(messages.map((m) => m.message)).size, 1);
  assert.equal(
    f.hub.data.messages.filter((m) => m.subject.includes("sign-in")).length,
    6,
  );
  const link = f.hub.data.messages[0].link;
  const result = await f.hub.identity.confirm(new URL(link).hash.slice(1));
  assert.equal(result.returnTo, "/outing/123abc");
});
test("saved community survives restart, and no token or provider secret appears in the shared outing view", async (t) => {
  const f = await fixture(t),
    o = await outing(f);
  await publish(f, o);
  await f.hub.join(f.guest.id, { outingId: o.id });
  const reopened = await new Store(f.directory).load();
  assert.equal(reopened.community.outings[0].people.length, 2);
  reopened.close();
  const text = JSON.stringify(f.hub.view(o.id, f.guest.id));
  assert.ok(!text.includes(f.owner.email));
  assert.ok(!text.includes("refresh_token"));
});

test("previewing a join takes no place, and a changed group invalidates the reviewed version", async (t) => {
  const f = await fixture(t),
    o = await outing(f, { maxPeople: 3 });
  await publish(f, o);
  const preview = await f.hub.previewJoin(f.guest.id, {
    outingId: o.id,
  });
  assert.equal(o.people.length, 1);
  assert.equal(preview.route.participantId, f.guest.id);
  await f.hub.join(f.other.id, { outingId: o.id });
  await assert.rejects(
    () =>
      f.hub.join(f.guest.id, {
        outingId: o.id,
        expectedVersion: preview.version,
      }),
    /changed since/,
  );
});

test("newer Calendar polling wins when two network reads return out of order", async (t) => {
  const f = await fixture(t),
    view = await f.hub.createTest(f.owner.id, {
      guestEmail: f.guest.email,
      start,
      timezone: "Europe/Prague",
      channel: "calendar",
    }),
    o = f.hub.outing(view.id);
  await deliverCalendar(f.hub, o.id);
  let release;
  f.providers.calendar = async () => {
    if (!release) {
      await new Promise((r) => (release = r));
      return {
        attendees: [{ email: f.guest.email, responseStatus: "accepted" }],
      };
    }
    return {
      attendees: [{ email: f.guest.email, responseStatus: "tentative" }],
    };
  };
  const first = syncCalendar(f.hub, o.id);
  await syncCalendar(f.hub, o.id);
  release();
  await first;
  assert.equal(o.people[1].response, "tentative");
});

test("a cancellation queued during a Calendar write remains pending and cancels the same event", async (t) => {
  const f = await fixture(t),
    view = await f.hub.createTest(f.owner.id, {
      guestEmail: f.guest.email,
      start,
      timezone: "UTC",
      channel: "calendar",
    }),
    o = f.hub.outing(view.id);
  const original = f.providers.calendar;
  let release;
  f.providers.calendar = async (...args) => {
    if (args[1] === "POST") await new Promise((r) => (release = r));
    return original(...args);
  };
  const delivery = deliverCalendar(f.hub, o.id);
  while (!release) await new Promise((r) => setImmediate(r));
  await f.hub.cancel(f.owner.id, {
    outingId: o.id,
    reason: "Cancelled while sending",
  });
  release();
  await delivery;
  assert.equal(o.calendar.state, "queued");
  await deliverCalendar(f.hub, o.id);
  assert.equal(o.calendar.state, "sent");
  assert.equal(f.providers.events.size, 0);
});

test("a Calendar connection-test edit needs no astronomy and preserves the event ID", async (t) => {
  const f = await fixture(t),
    view = await f.hub.createTest(f.owner.id, {
      guestEmail: f.guest.email,
      start,
      timezone: "UTC",
      channel: "calendar",
    }),
    o = f.hub.outing(view.id);
  await deliverCalendar(f.hub, o.id);
  const eventId = o.calendar.id;
  await f.hub.edit(f.owner.id, {
    outingId: o.id,
    start: new Date(Date.parse(start) + 3600000).toISOString(),
    end: new Date(Date.parse(start) + 5400000).toISOString(),
    site: o.site,
  });
  await deliverCalendar(f.hub, o.id);
  assert.equal(o.calendar.id, eventId);
  assert.equal(o.revision, 2);
  assert.equal(o.astronomy, null);
  assert.equal(f.providers.events.size, 1);
});

test("signed-out discovery exposes only upcoming open previews and keeps joining authenticated", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "sg-public-"));
  const app = await createHub({
    solver: "deterministic",
    directory,
    port: 0,
    geo: geo(),
    forecast,
    providers: provider(),
  });
  t.after(async () => {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  });
  const owner = app.hub.identity.user("private-owner@fixture.test");
  await app.hub.saveProfile(
    owner.id,
    preferences("Private observer", {
      interestNote: "Private interests",
    }),
  );
  const o = await outing({ hub: app.hub, owner });
  await publish({ hub: app.hub, owner }, o);
  o.comments.push({ text: "Private conversation" });
  o.calendar = {
    state: "sent",
    url: "https://calendar.test/private-link",
    error: "Private delivery error",
  };
  const variants = [
    { visibility: "circle" },
    { status: "draft" },
    { status: "cancelled" },
    { status: "completed" },
    { status: "not_formed" },
    { start: new Date(Date.now() - 3600000).toISOString() },
    { maxPeople: 1 },
  ].map((change, i) => ({
    ...structuredClone(o),
    ...change,
    id: o.id.slice(0, -4) + String(i + 1).padStart(4, "0"),
  }));
  app.hub.data.outings.push(...variants);
  const response = await fetch(app.url + "/api/public-outings");
  assert.equal(response.status, 200);
  const previews = await response.json();
  assert.deepEqual(
    previews.map((p) => p.id),
    [o.id],
  );
  assert.equal(previews[0].remaining, 1);
  assert.equal(previews[0].going, 1);
  assert.equal(previews[0].site.name, site.name);
  assert.equal(
    previews[0].astronomy.sampleMinutes,
    o.astronomy.sampleMinutes,
  );
  assert.equal(previews[0].weather.fetchedAt, o.weather.fetchedAt);
  const detail = await (
    await fetch(app.url + `/api/public-outings/${o.id}`)
  ).json();
  assert.deepEqual(detail, previews[0]);
  for (const field of [
    "people",
    "organizerId",
    "routes",
    "carpools",
    "comments",
    "calendar",
    "preferences",
    "equipment",
    "alternatives",
  ])
    assert.equal(Object.hasOwn(detail, field), false, field);
  assert.doesNotMatch(
    JSON.stringify(detail),
    /Private|private-owner|private-link/,
  );
  assert.deepEqual(Object.keys(detail.site).sort(), [
    "accessNote",
    "name",
    "walkMinutes",
  ]);
  for (const hidden of variants.slice(0, -1))
    assert.equal(
      (await fetch(app.url + `/api/public-outings/${hidden.id}`)).status,
      404,
    );
  const full = await (
    await fetch(app.url + `/api/public-outings/${variants.at(-1).id}`)
  ).json();
  assert.equal(full.remaining, 0);
  const joinResponse = await fetch(app.url + "/mcp", {
    method: "POST",
    headers: { Origin: app.url, "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "join_outing", arguments: { outingId: o.id } },
    }),
  });
  assert.equal(joinResponse.status, 401);
  assert.equal(o.people.length, 1);
  for (const [returnTo, expected] of [
    [`/outing/${o.id}`, `/outing/${o.id}`],
    ["/?view=plan", "/?view=plan"],
    ["https://example.test", "/"],
  ]) {
    await app.hub.identity.request("visitor@fixture.test", returnTo);
    const link = app.hub.data.messages.find(
      (m) => m.to === "visitor@fixture.test",
    ).link;
    const signed = await app.hub.identity.confirm(
      new URL(link).hash.slice(1),
    );
    assert.equal(signed.returnTo, expected);
  }
});

test("a new member joins with self-transport without inventing profile availability or a home address", async (t) => {
  const f = await fixture(t),
    o = await outing(f);
  await publish(f, o);
  const user = f.hub.identity.user("new-person@fixture.test");
  f.hub.geo.call = async () => {
    throw new Error("Self-transport must not reroute the group");
  };
  const details = {
    name: "New person",
    mode: "self",
    confirmed: true,
  };
  const preview = await f.hub.previewJoin(user.id, {
    outingId: o.id,
    details,
  });
  assert.equal(preview.mode, "self");
  assert.equal(
    preview.route.meetAt,
    new Date(Date.parse(o.start) - 20 * 60000).toISOString(),
  );
  assert.equal(preview.route.departAt, undefined);
  await assert.rejects(
    f.hub.previewJoin(user.id, {
      outingId: o.id,
      details: { ...details, confirmed: false },
    }),
  );
  await f.hub.join(user.id, {
    outingId: o.id,
    details,
    expectedVersion: preview.version,
  });
  assert.equal(o.status, "confirmed");
  assert.deepEqual(user.preferences, {
    name: "New person",
    channel: "email",
  });
  assert.equal(f.hub.view(o.id, user.id).routes[0].selfArranged, true);
});

test("a partial profile saves without night-specific fields and needs those fields only for planning", async (t) => {
  const f = await fixture(t);
  await f.hub.saveProfile(f.guest.id, {
    name: "Small profile",
    interests: ["Photography"],
  });
  assert.equal(f.guest.preferences.origin, undefined);
  await assert.rejects(
    f.hub.plan(f.guest.id, {
      target: "stargazing",
      start,
      end: new Date(Date.parse(end) + 2 * 3600000).toISOString(),
      site,
    }),
    /starting point, availability/,
  );
});

test("an open outing can recruit its missing driver, holds a place and asks riders to confirm the new ride", async (t) => {
  const f = await fixture(t);
  await f.hub.saveProfile(
    f.owner.id,
    preferences("Rider", { travel: ["ride"], car: undefined }),
  );
  const o = await outing(f, { maxPeople: 2, minPeople: 1 });
  assert.deepEqual(o.pendingTransport, [f.owner.id]);
  assert.ok(o.astronomy.suitable);
  assert.ok(o.weather.suitable);
  await publish(f, o);
  assert.equal(o.status, "invited");
  assert.ok(o.reasons.some((r) => r.includes("Driver needed")));
  await assert.rejects(
    f.hub.previewJoin(f.other.id, {
      outingId: o.id,
      details: { name: "Walker", mode: "self", confirmed: true },
    }),
    /last place/,
  );
  const driver = preferences("Driver");
  const details = {
    name: "Driver",
    mode: "drive",
    confirmed: true,
    origin: driver.origin,
    car: driver.car,
  };
  const preview = await f.hub.previewJoin(f.guest.id, {
    outingId: o.id,
    details,
  });
  await f.hub.join(f.guest.id, {
    outingId: o.id,
    details,
    expectedVersion: preview.version,
  });
  assert.deepEqual(o.pendingTransport, []);
  assert.equal(
    o.people.find((p) => p.userId === f.owner.id).response,
    "pending",
  );
  assert.notEqual(o.status, "confirmed");
  await f.hub.respond(f.owner.id, {
    outingId: o.id,
    response: "accepted",
    revision: o.revision,
  });
  assert.equal(o.status, "confirmed");
});

test("quick lift selection uses the offered public point, checks seats and does not silently offer saved equipment", async (t) => {
  const f = await fixture(t);
  const prefs = preferences("Driver");
  prefs.car.pickupPoints = [prefs.origin];
  await f.hub.saveProfile(f.owner.id, prefs);
  const o = await outing(f, { maxPeople: 3 });
  await publish(f, o);
  const options = f.hub.joinOptions(f.guest.id, o.id);
  assert.equal(options.pickups.length, 1);
  const details = {
    name: "Rider",
    mode: "ride",
    pickupId: options.pickups[0].id,
    confirmed: true,
  };
  const preview = await f.hub.previewJoin(f.guest.id, {
    outingId: o.id,
    details,
  });
  assert.equal(preview.mode, "ride");
  assert.equal(preview.driver.id, f.owner.id);
  await f.hub.join(f.guest.id, {
    outingId: o.id,
    details,
    expectedVersion: preview.version,
  });
  const member = o.people.find((p) => p.userId === f.guest.id);
  assert.deepEqual(member.preferences.equipment, []);
  assert.equal(member.preferences.shareEquipment, false);
  await assert.rejects(
    f.hub.previewJoin(f.other.id, {
      outingId: o.id,
      details: { ...details, pickupId: "removed" },
    }),
    /no longer offered/,
  );
});

for (const mode of ["walk", "bicycle"]) {
  test(`${mode}-only outings confirm without a driver and have no traffic report`, async (t) => {
    const f = await fixture(t);
    await f.hub.saveProfile(
      f.owner.id,
      preferences("Independent traveler", {
        travel: [mode],
        car: undefined,
      }),
    );
    const o = await outing(f, { minPeople: 1, maxPeople: 3 });
    assert.deepEqual(o.pendingTransport, []);
    assert.equal(o.people[0].transport, mode);
    await publish(f, o);
    assert.equal(o.status, "confirmed");
    assert.equal(f.hub.view(o.id, f.owner.id).needsDriver, false);
    assert.equal(f.hub.view(o.id, f.owner.id).traffic, undefined);
    f.hub.geo.call = async () => {
      throw Error("Traffic must not query car routes");
    };
    assert.equal(await f.hub.trafficReport(f.owner.id, o.id), null);
  });
}

test("a withdrawn driver can be replaced; the passenger must confirm the replacement", async (t) => {
  const f = await fixture(t);
  f.owner.preferences.travel = ["walk"];
  f.other.preferences.travel = ["ride"];
  const o = await outing(f, { maxPeople: 4 });
  await publish(f, o);
  await f.hub.join(f.guest.id, { outingId: o.id });
  await f.hub.join(f.other.id, { outingId: o.id });
  for (const p of o.people)
    await f.hub.respond(p.userId, {
      outingId: o.id,
      response: "accepted",
      revision: o.revision,
    });
  assert.equal(o.status, "confirmed");
  await f.hub.respond(f.guest.id, {
    outingId: o.id,
    response: "declined",
    revision: o.revision,
  });
  assert.equal(o.status, "needs_review");
  assert.deepEqual(o.pendingTransport, [f.other.id]);
  assert.equal(o.carpools.length, 0);
  await f.hub.edit(f.owner.id, {
    outingId: o.id,
    start: o.start,
    end: o.end,
    site: o.site,
  });
  const replacement = f.hub.identity.user("replacement@fixture.test");
  replacement.preferences = preferences("Replacement");
  await f.hub.join(replacement.id, { outingId: o.id });
  assert.equal(o.carpools[0].driverId, replacement.id);
  assert.equal(
    o.people.find((p) => p.userId === f.other.id).response,
    "pending",
  );
  assert.equal(o.status, "needs_review");
  await f.hub.respond(f.other.id, {
    outingId: o.id,
    response: "accepted",
    revision: o.revision,
  });
  assert.equal(o.status, "confirmed");
});

test("joining preserves existing profile defaults and uses saved invitation and travel limits", async (t) => {
  const f = await fixture(t),
    o = await outing(f, { maxPeople: 3 });
  await publish(f, o);
  f.guest.preferences = preferences("Guest", {
    channel: "calendar",
    travel: ["ride", "walk", "drive"],
    maxTravelMinutes: 45,
    maxWalkMinutes: 10,
  });
  const before = structuredClone(f.guest.preferences);
  await f.hub.join(f.guest.id, {
    outingId: o.id,
    details: {
      name: "Guest",
      mode: "ride",
      origin: before.origin,
      confirmed: true,
    },
  });
  assert.deepEqual(f.guest.preferences, before);
  const p = o.people.find((p) => p.userId === f.guest.id);
  assert.equal(p.channel, "calendar");
  assert.equal(p.preferences.maxTravelMinutes, 45);
  assert.equal(p.preferences.maxWalkMinutes, 10);
});

test("draft suggestions are private and cancelling a draft sends no notices", async (t) => {
  const f = await fixture(t);
  await f.hub.circleInvite(f.owner.id, { email: f.guest.email });
  await f.hub.circleRespond(f.guest.id, {
    invitationId: f.hub.data.connections[0].id,
    accept: true,
  });
  const o = await outing(f);
  assert.ok(o.people.some((p) => p.userId === f.guest.id));
  assert.equal(f.hub.state(f.guest.id).outings.length, 0);
  assert.throws(() => f.hub.view(o.id, f.guest.id), /private/);
  const count = f.hub.data.messages.length;
  await f.hub.cancel(f.owner.id, {
    outingId: o.id,
    reason: "Draft abandoned",
  });
  assert.equal(f.hub.data.messages.length, count);
  assert.equal(f.hub.state(f.guest.id).outings.length, 0);
  assert.equal(o.calendar, undefined);
});

test("conditions block discovery and joining before a guest fills out a journey", async (t) => {
  const f = await fixture(t),
    o = await outing(f);
  await publish(f, o);
  o.astronomy.suitable = false;
  f.hub.evaluate(o);
  assert.equal(f.hub.view(o.id, f.guest.id).canJoin, false);
  assert.equal(f.hub.publicOutings().length, 0);
  assert.equal((await f.hub.discover(f.guest.id)).length, 0);
  o.astronomy.suitable = true;
  o.weather.suitable = false;
  assert.equal(f.hub.view(o.id, f.guest.id).canJoin, false);
});

test("missing lifts reserve a separate driver place, not a general vacancy", async (t) => {
  const f = await fixture(t);
  f.owner.preferences.travel = ["ride"];
  const o = await outing(f, { maxPeople: 2, minPeople: 1 });
  await publish(f, o);
  const v = f.hub.view(o.id, f.guest.id);
  assert.equal(v.remaining, 0);
  assert.equal(v.driverPlaces, 1);
  assert.equal(v.canJoin, true);
  assert.equal(f.hub.publicOutings()[0].driverPlaces, 1);
});

test("deadline-only edits keep reviewed routes without contacting providers", async (t) => {
  const f = await fixture(t),
    o = await outing(f);
  await publish(f, o);
  f.guest.preferences.travel = ["ride"];
  await f.hub.join(f.guest.id, { outingId: o.id });
  const before = JSON.stringify([
    o.routes,
    o.carpools,
    o.people,
    o.revision,
  ]);
  f.hub.routesFor = async () => {
    throw Error("Unexpected reroute");
  };
  f.hub.forecast = async () => {
    throw Error("Unexpected forecast");
  };
  await f.hub.edit(f.owner.id, {
    outingId: o.id,
    start: o.start,
    end: o.end,
    site: o.site,
    deadline: new Date(Date.parse(o.start) - 3600000).toISOString(),
  });
  assert.equal(
    JSON.stringify([o.routes, o.carpools, o.people, o.revision]),
    before,
  );
});

test("inviting another person never re-accepts a declined organizer", async (t) => {
  const f = await fixture(t),
    o = await outing(f, { maxPeople: 3 });
  await publish(f, o);
  await f.hub.respond(f.owner.id, {
    outingId: o.id,
    response: "declined",
    revision: o.revision,
  });
  await f.hub.circleInvite(f.owner.id, { email: f.guest.email });
  await f.hub.circleRespond(f.guest.id, {
    invitationId: f.hub.data.connections[0].id,
    accept: true,
  });
  await f.hub.invite(f.owner.id, {
    outingId: o.id,
    participantIds: [f.guest.id],
  });
  assert.equal(
    o.people.find((p) => p.userId === f.owner.id).response,
    "declined",
  );
  assert.notEqual(o.status, "confirmed");
});

test("Maybe after the response deadline keeps an accepted guest's place until the start", async (t) => {
  const f = await fixture(t),
    o = await outing(f);
  await publish(f, o);
  await f.hub.join(f.guest.id, { outingId: o.id });
  o.deadline = new Date(Date.now() - 60000).toISOString();
  await f.hub.respond(f.guest.id, {
    outingId: o.id,
    response: "tentative",
    revision: o.revision,
  });
  assert.equal(o.people[1].response, "tentative");
  assert.equal(f.hub.capacity(o), 2);
  await f.hub.respond(f.guest.id, {
    outingId: o.id,
    response: "accepted",
    revision: o.revision,
  });
  assert.equal(o.status, "confirmed");
});

test("decliners cannot read or post comments, and cancellation closes comments", async (t) => {
  const f = await fixture(t),
    o = await outing(f);
  await publish(f, o);
  await f.hub.join(f.guest.id, { outingId: o.id });
  await f.hub.comment(f.owner.id, {
    outingId: o.id,
    text: "A private discussion",
  });
  await f.hub.respond(f.guest.id, {
    outingId: o.id,
    response: "declined",
    revision: o.revision,
  });
  assert.deepEqual(f.hub.view(o.id, f.guest.id).comments, []);
  await assert.rejects(
    f.hub.comment(f.guest.id, {
      outingId: o.id,
      text: "No longer attending",
    }),
    /Only invited/,
  );
  await f.hub.cancel(f.owner.id, {
    outingId: o.id,
    reason: "Cancelled",
  });
  await assert.rejects(
    f.hub.comment(f.owner.id, { outingId: o.id, text: "Closed" }),
    /Only invited/,
  );
});

test("comment email uses the author's identity or the system sender, never the organizer's Gmail", async (t) => {
  const f = await fixture(t),
    o = await outing(f);
  await publish(f, o);
  await f.hub.join(f.guest.id, { outingId: o.id });
  await f.hub.comment(f.guest.id, {
    outingId: o.id,
    text: "Participant-authored content",
  });
  const m = f.hub.data.messages[0];
  assert.equal(m.senderId, f.guest.id);
  assert.notEqual(m.senderId, f.owner.id);
  assert.ok(!m.text.includes("Participant-authored content"));
});

test("Calendar invitations fail clearly before reserving places when the organizer is disconnected", async (t) => {
  const f = await fixture(t);
  f.guest.preferences.channel = "calendar";
  await f.hub.circleInvite(f.owner.id, { email: f.guest.email });
  await f.hub.circleRespond(f.guest.id, {
    invitationId: f.hub.data.connections[0].id,
    accept: true,
  });
  const o = await outing(f);
  f.providers.status = () => ({ googleConnected: false });
  const before = f.hub.data.messages.length;
  await assert.rejects(publish(f, o, [f.guest.id]), /connect Google/);
  assert.equal(o.status, "draft");
  assert.equal(f.hub.data.messages.length, before);
});

test("sign-in delivery is bounded across aliases and expired links are cleaned up", async (t) => {
  const f = await fixture(t);
  for (let i = 0; i < 3; i++)
    await f.hub.identity.request(`victim+${i}@fixture.test`);
  for (let i = 3; i < 300; i++)
    await assert.rejects(
      f.hub.identity.request(`victim+${i}@fixture.test`),
      (error) => error.status === 429,
    );
  assert.equal(f.hub.data.messages.length, 3);
  for (let i = 0; i < 100; i++)
    await f.hub.identity.request(
      `other${i}@fixture.test`,
      "/",
      `client-${i}`,
    );
  assert.equal(f.hub.data.messages.length, 103);
  f.hub.identity.cleanup(Date.now() + 16 * 60000);
  assert.equal(f.hub.data.tokens.length, 0);
  assert.equal(f.hub.data.messages.length, 0);
});

test("a repeated unreadable Calendar conflict stops after bounded attempts; recovery is explicit", async (t) => {
  const f = await fixture(t),
    v = await f.hub.createTest(f.owner.id, {
      guestEmail: f.guest.email,
      start,
      timezone: "UTC",
      channel: "calendar",
    }),
    o = f.hub.outing(v.id);
  let writes = 0;
  f.providers.calendar = async (_u, method) => {
    if (method === "GET")
      throw Object.assign(Error("Missing"), { status: 404 });
    writes++;
    throw Object.assign(Error("Conflict"), { status: 409 });
  };
  for (let i = 0; i < 10; i++) {
    await deliverCalendar(f.hub, o.id);
    f.hub.queueCalendar(o);
  }
  assert.equal(writes, 5);
  assert.equal(o.calendar.state, "failed");
  await deliverCalendar(f.hub, o.id, { retry: true });
  assert.equal(writes, 6);
});

test("missing Calendar authorization does not retry every pump", async (t) => {
  const f = await fixture(t),
    v = await f.hub.createTest(f.owner.id, {
      guestEmail: f.guest.email,
      start,
      timezone: "UTC",
      channel: "calendar",
    }),
    o = f.hub.outing(v.id);
  f.providers.status = () => ({ googleConnected: false });
  await deliverCalendar(f.hub, o.id);
  await pump(f.hub);
  await pump(f.hub);
  assert.equal(o.calendar.state, "needs_connection");
  assert.equal(f.providers.calls.length, 0);
});

test("a previously delivered event that disappears is not recreated, and cancellation can still complete", async (t) => {
  const f = await fixture(t);
  const v = await f.hub.createTest(f.owner.id, {
    guestEmail: f.guest.email,
    start,
    timezone: "UTC",
    channel: "calendar",
  });
  const o = f.hub.outing(v.id);
  await deliverCalendar(f.hub, o.id);
  f.providers.events.delete(o.calendar.id);
  f.providers.calls.length = 0;
  o.title = "Revised invitation";
  f.hub.queueCalendar(o);
  await deliverCalendar(f.hub, o.id);
  await deliverCalendar(f.hub, o.id);
  assert.equal(o.calendar.state, "failed");
  assert.deepEqual(
    f.providers.calls.map((c) => c.method),
    ["GET"],
  );
  await f.hub.cancel(f.owner.id, {
    outingId: o.id,
    reason: "Cancelled",
  });
  await deliverCalendar(f.hub, o.id);
  assert.equal(o.calendar.state, "sent");
  assert.ok(f.providers.calls.every((c) => c.method === "GET"));
});

test("inviting an extra guest reconfirms changed pickup times for existing riders and drivers", async (t) => {
  const f = await fixture(t);
  f.guest.preferences.travel = ["ride"];
  const o = await outing(f, { maxPeople: 4 });
  await publish(f, o);
  await f.hub.join(f.guest.id, { outingId: o.id });
  for (const p of o.people)
    await f.hub.respond(p.userId, {
      outingId: o.id,
      response: "accepted",
      revision: o.revision,
    });
  await f.hub.circleInvite(f.owner.id, { email: f.other.email });
  await f.hub.circleRespond(f.other.id, {
    invitationId: f.hub.data.connections[0].id,
    accept: true,
  });
  const original = f.hub.routesFor.bind(f.hub);
  f.hub.routesFor = async (...args) => {
    const travel = await original(...args);
    for (const car of travel.carpools)
      for (const pickup of car.pickups)
        pickup.pickupAt = new Date(
          Date.parse(pickup.pickupAt) - 60000,
        ).toISOString();
    return travel;
  };
  const revision = o.revision;
  await f.hub.invite(f.owner.id, {
    outingId: o.id,
    participantIds: [f.other.id],
  });
  assert.ok(o.revision > revision);
  for (const uid of [f.owner.id, f.guest.id]) {
    const p = o.people.find((p) => p.userId === uid);
    assert.equal(p.response, "pending");
    assert.equal(p.journeyReview, true);
  }
  assert.equal(o.status, "needs_review");
});

test("legacy Calendar tests never invent a real starting point, travel method or availability", async (t) => {
  const { migrateLegacy } = await import('../web/server/migrate.js');
  const f = await fixture(t);
  f.guest.preferences = null;
  f.store.state.outings = [{
    id:'old-test', savedAt:start,
    plan:{
      mode:'calendar_test',
      request:{timezone:'Europe/Prague',organizerId:'guest',minPeople:1,maxPeople:2,target:'stargazing'},
      participants:[{id:'guest',name:'Guest',email:f.guest.email,transport:'walk'}],
      site, observingStart:start, observingEnd:end, meetingStart:start, meetingEnd:end,
    },
    invitation:{eventId:'keep-test-event'},
  }];
  await migrateLegacy(f.hub);
  assert.equal(f.guest.preferences.origin, undefined);
  assert.equal(f.guest.preferences.slots, undefined);
  assert.equal(f.guest.preferences.travel, undefined);
  assert.equal(f.hub.outing('old-test').calendar.id, 'keep-test-event');
  assert.equal(f.hub.data.legacyImportVersion, 3);
  assert.equal(f.providers.calls.length, 0);
});

test("migration repairs exact v2 test defaults, preserves edited profiles, and is idempotent", async (t) => {
  const { migrateLegacy } = await import('../web/server/migrate.js');
  const f = await fixture(t);
  const generated = {
    name:'Guest', avatar:'star', timezone:'Europe/Prague', interests:['Stargazing'],
    interestNote:'', experience:'beginner', happyToTeach:false, equipment:[],
    shareEquipment:false, channel:'email',
    origin:{name:'Public meeting point',location:site.meetingPoint},
    slots:[{date:'2030-11-17',from:'18:00',until:'18:30',weekly:false}],
    travel:['walk'], maxTravelMinutes:60, maxWalkMinutes:20, preference:'balanced',
  };
  f.guest.preferences=structuredClone(generated);
  f.other.preferences={...structuredClone(generated),origin:{name:'My chosen place',location:{lat:49.16,lon:16.88}}};
  const edited=structuredClone(f.other.preferences);
  f.store.state.outings=[{
    id:'v2-test', savedAt:start, plan:{mode:'calendar_test',request:{timezone:'Europe/Prague'},site,
      meetingStart:'2030-11-17T17:00:00Z',meetingEnd:'2030-11-17T17:30:00Z',
      participants:[f.guest,f.other].map(u=>({id:u.id,email:u.email,name:'Guest',transport:'walk'})),
    },
  }];
  f.hub.data.legacyImportVersion=2;
  await migrateLegacy(f.hub);
  assert.equal(f.guest.preferences.origin,undefined);
  assert.equal(f.guest.preferences.slots,undefined);
  assert.equal(f.guest.preferences.travel,undefined);
  assert.deepEqual(f.other.preferences,edited);
  const after=JSON.stringify(f.hub.data);
  await migrateLegacy(f.hub);
  assert.equal(JSON.stringify(f.hub.data),after);
  assert.equal(f.providers.calls.length,0);
});

test("migration keeps pre-coordination outings and Calendar IDs without automatic messages or writes", async (t) => {
  const { migrateLegacy } = await import("../web/server/migrate.js");
  const f = await fixture(t),
    o = await outing(f);
  const old = (id, withCoord) => ({
    id,
    savedAt: new Date().toISOString(),
    plan: {
      status: "proposal",
      participants: o.people.map((p) => ({
        id: p.userId,
        email: f.hub.user(p.userId).email,
        ...p.preferences,
        origin: p.preferences.origin.location,
        transport: p.transport,
      })),
      request: {
        ...o.limits,
        organizerId: f.owner.id,
        timezone: o.timezone,
        minPeople: 2,
        maxPeople: 4,
        target: o.target,
      },
      site: o.site,
      meetingStart: o.start,
      meetingEnd: o.end,
      observingStart: o.start,
      observingEnd: o.end,
      routes: o.routes,
    },
    invitation: { status: "sent", eventId: `preserved-${id}` },
    ...(withCoord
      ? {
          coordination: {
            status: "invited",
            revision: 1,
            deadline: new Date(Date.now() - 86400000).toISOString(),
            people: [
              {
                id: f.owner.id,
                email: f.owner.email,
                response: "accepted",
                channel: "calendar",
              },
            ],
            comments: [],
          },
        }
      : {}),
  });
  f.store.state.outings = [old("v02", false), old("v03", true)];
  f.hub.data.legacyImported = true;
  const count = f.hub.data.messages.length;
  await migrateLegacy(f.hub);
  for (const id of ["v02", "v03"]) {
    const migrated = f.hub.outing(id);
    assert.equal(migrated.calendar.id, `preserved-${id}`);
    assert.equal(migrated.migrationPaused, true);
  }
  await pump(f.hub, { sync: true });
  await pump(f.hub, { sync: true });
  assert.equal(f.hub.data.messages.length, count);
  assert.equal(f.providers.calls.length, 0);
  assert.equal(f.hub.outing("v03").status, "invited");
  await migrateLegacy(f.hub);
  assert.equal(f.hub.data.outings.filter((o) => o.legacy).length, 2);
});

test("DST repeated and missing hours keep recurring slots and quick joins usable", async (t) => {
  const { prepareJoin } = await import("../web/server/join.js");
  const f = await fixture(t),
    o = await outing(f);
  o.start = "2027-10-30T18:00:00Z";
  o.end = "2027-10-30T19:00:00Z";
  f.guest.preferences.slots = [
    {
      date: "2027-10-23",
      from: "20:00",
      until: "02:30",
      weekly: true,
    },
  ];
  assert.doesNotThrow(() => f.hub.state(f.guest.id));
  const windows = expandSlots(
    f.guest.preferences.slots,
    "Europe/Prague",
    "2027-10-23T00:00:00Z",
    "2027-11-08T00:00:00Z",
  );
  assert.ok(windows.length >= 3);
  for (const mode of ["drive", "ride"]) {
    const prepared = prepareJoin(
      f.guest,
      o,
      {
        name: "DST traveler",
        mode,
        confirmed: true,
        origin: f.guest.preferences.origin,
        car: f.guest.preferences.car,
      },
      { pickups: [] },
    );
    assert.doesNotThrow(() =>
      expandSlots(
        prepared.preferences.slots,
        "Europe/Prague",
        o.start,
        "2027-10-31T12:00:00Z",
      ),
    );
  }
});

test("a spring clock jump omits an eliminated short window and preserves following weeks", () => {
  const windows = expandSlots(
    [
      {
        date: "2027-03-28",
        from: "02:30",
        until: "03:00",
        weekly: true,
      },
    ],
    "Europe/Prague",
    "2027-03-28T00:00:00Z",
    "2027-04-06T00:00:00Z",
  );
  assert.equal(windows.length, 1);
  assert.equal(windows[0].start, "2027-04-04T00:30:00Z");
  assert.ok(Date.parse(windows[0].end) > Date.parse(windows[0].start));
});

test("malformed request targets return 400 and leave the server responsive", async (t) => {
  const { request } = await import("node:http");
  const directory = await mkdtemp(join(tmpdir(), "sg-http-regression-"));
  const app = await createHub({
    solver: "deterministic",
    directory,
    port: 0,
    providers: provider(),
  });
  t.after(async () => {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  });
  const status = await new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: "127.0.0.1",
        port: app.server.address().port,
        path: "//",
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode));
      },
    );
    req.on("error", reject);
    req.end();
  });
  assert.equal(status, 400);
  assert.equal((await fetch(app.url + "/api/bootstrap")).status, 200);
});

test("hosted startup fails with an actionable message when sign-in email is missing", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "sg-hosted-regression-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const smtp = process.env.SMTP_URL,
    from = process.env.MAIL_FROM;
  delete process.env.SMTP_URL;
  delete process.env.MAIL_FROM;
  try {
    await assert.rejects(
      createHub({
        solver: "deterministic",
        directory,
        port: 0,
        baseUrl: "https://stargazer.example",
      }),
      /Hosted sign-in requires SMTP_URL and MAIL_FROM/,
    );
  } finally {
    if (smtp !== undefined) process.env.SMTP_URL = smtp;
    if (from !== undefined) process.env.MAIL_FROM = from;
  }
});

test("the seed command ignores the main database environment setting", async (t) => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { access } = await import("node:fs/promises");
  const directory = await mkdtemp(join(tmpdir(), "sg-seed-regression-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const main = join(directory, "web"),
    demo = join(directory, "community-demo");
  await promisify(execFile)(
    process.execPath,
    ["scripts/seed-community.js"],
    {
      env: {
        ...process.env,
        STAR_GAZER_DATA_DIR: main,
        STAR_GAZER_DEMO_DATA_DIR: demo,
      },
    },
  );
  await assert.rejects(access(join(main, "stargazer.sqlite")));
  await access(join(demo, "stargazer.sqlite"));
});

test("organizer dates override a short remembered slot for this outing only", async (t) => {
  const f = await fixture(t);
  f.owner.preferences.slots = [
    { date: day, from: "19:00", until: "19:30", weekly: false },
  ];
  const saved = structuredClone(f.owner.preferences.slots);
  const o = await outing(f);
  const member = o.people.find((p) => p.userId === f.owner.id);
  assert.equal(member.availability.length, 1);
  assert.deepEqual(f.owner.preferences.slots, saved);
  for (const route of o.routes) {
    assert.ok(
      Date.parse(route.departAt) >=
        Date.parse(member.availability[0].start),
    );
    assert.ok(
      Date.parse(route.homeBy) <= Date.parse(member.availability[0].end),
    );
  }
  await publish(f, o);
  assert.notEqual(o.status, "draft");
  assert.deepEqual(f.owner.preferences.slots, saved);
});

test("invalid evening dates fail clearly before any geography or weather request", async (t) => {
  const f = await fixture(t);
  f.hub.geo.call = async () =>
    assert.fail("No provider call for invalid dates");
  f.hub.forecast = async () =>
    assert.fail("No forecast call for invalid dates");
  for (const [until, pattern] of [
    [
      new Date(Date.parse(start) - 6.5 * 3600000).toISOString(),
      /Home by must be after/,
    ],
    [
      new Date(Date.parse(start) + 30 * 60000).toISOString(),
      /30 minutes available.*60 minutes/,
    ],
    [
      new Date(Date.parse(start) + 8 * 86400000).toISOString(),
      /at most 7 days apart/,
    ],
  ])
    await assert.rejects(
      f.hub.plan(f.owner.id, {
        target: "stargazing",
        start,
        end: until,
      }),
      pattern,
    );
});

test("browsing other dates keeps availability matching strict and hides unavailable outings", async (t) => {
  const f = await fixture(t),
    o = await outing(f);
  await publish(f, o);
  f.guest.preferences.slots = [
    { date: day, from: "10:00", until: "10:30", weekly: false },
  ];
  assert.equal((await f.hub.discover(f.guest.id)).length, 0);
  const otherDates = await f.hub.discover(f.guest.id, {
    anyDate: true,
  });
  assert.equal(otherDates.length, 1);
  assert.ok(!otherDates[0].matchReasons.includes("Your evening overlaps"));
  o.visibility = "circle";
  assert.equal(
    (await f.hub.discover(f.guest.id, { anyDate: true })).length,
    0,
  );
  o.visibility = "open";
  o.weather.suitable = false;
  assert.equal(
    (await f.hub.discover(f.guest.id, { anyDate: true })).length,
    0,
  );
});
