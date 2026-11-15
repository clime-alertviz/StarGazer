import { randomUUID } from "node:crypto";
import { Temporal } from "@js-temporal/polyfill";
import { assessSky } from "../../src/astronomy.js";
import { request as requestSchema } from "../../src/schema.js";
import { preferencesSchema } from "./availability.js";

export async function seedCommunity(hub) {
  if (hub.data.seedVersion) return { alreadySeeded: true };
  const timezone = "Europe/Prague",
    today = Temporal.Now.plainDateISO(timezone),
    date = today.add({ days: 1 }).toString();
  const points = [
    { name: "Ládví metro station", location: { lat: 50.1267, lon: 14.469 } },
    { name: "Nádraží Holešovice", location: { lat: 50.1089, lon: 14.439 } },
    {
      name: "Dejvická metro station",
      location: { lat: 50.1002, lon: 14.3932 },
    },
  ];
  const specs = [
    ["Tereza", "moon", "experienced", ["telescope"], true],
    ["Adam", "saturn", "experienced", ["telescope", "camera"], true],
    ["Eliška", "star", "beginner", ["binoculars"], false],
    ["David", "comet", "experienced", ["camera", "tripod"], true],
    ["Nina", "moon", "beginner", [], false],
    ["Jakub", "star", "experienced", ["telescope"], true],
    ["Sofie", "comet", "beginner", ["camera"], false],
    ["Martin", "saturn", "experienced", ["binoculars"], true],
  ];
  const users = specs.map(
    ([name, avatar, experience, equipment, driver], i) => {
      const u = hub.identity.user(
        `${name
          .normalize("NFD")
          .replace(/\p{Diacritic}/gu, "")
          .toLowerCase()}@stargazer.test`,
      );
      u.seed = true;
      u.preferences = preferencesSchema.parse({
        name,
        avatar,
        timezone,
        interests:
          i === 3 ? ["Photography"] : ["Planets", "Stargazing", "Learning"],
        interestNote:
          i === 3
            ? "Quiet evenings with a tripod. Happy to share a few photography tips."
            : "",
        experience,
        happyToTeach: experience === "experienced",
        equipment,
        shareEquipment: true,
        channel: "email",
        origin: points[i % 3],
        slots: Array.from({ length: 7 }, (_, n) => ({
          date: today.add({ days: n + 1 }).toString(),
          from: "16:00",
          until: "03:00",
          weekly: true,
        })),
        travel: driver ? ["drive", "ride"] : ["ride", "bicycle"],
        ...(driver
          ? {
              car: {
                available: true,
                offerRides: true,
                passengerSeats: 2,
                maxDetourMinutes: 25,
                pickupPoints: [points[i % 3]],
              },
            }
          : {}),
        maxTravelMinutes: 120,
        maxWalkMinutes: 35,
        preference: "balanced",
      });
      return u;
    },
  );
  for (let i = 1; i < users.length; i++)
    hub.data.connections.push({
      id: randomUUID(),
      from: users[0].id,
      to: users[i].id,
      status: "accepted",
      seed: true,
    });
  const configs = [
    {
      title: "Your first look at Saturn",
      target: "Saturn",
      name: "Ďáblice observatory meadow",
      lat: 50.1436,
      lon: 14.4677,
      owner: 1,
      members: [2],
      max: 4,
      min: 2,
      day: 1,
      walk: 5,
    },
    {
      title: "Moonlight, binoculars & good company",
      target: "Moon",
      name: "Letná garden viewpoint",
      lat: 50.0957,
      lon: 14.4154,
      owner: 0,
      members: [4],
      max: 5,
      min: 2,
      day: 2,
      walk: 3,
    },
    {
      title: "A quiet night behind the lens",
      target: "stargazing",
      name: "Kozákov viewpoint",
      lat: 50.5938,
      lon: 15.2638,
      owner: 3,
      members: [],
      max: 3,
      min: 2,
      day: 3,
      walk: 5,
      tags: ["Photography"],
    },
    {
      title: "Autumn skies above Prague",
      target: "stargazing",
      name: "Točná airfield meeting point",
      lat: 49.9854,
      lon: 14.4257,
      owner: 5,
      members: [6],
      max: 5,
      min: 2,
      day: 2,
      walk: 5,
    },
    {
      title: "An evening with old friends",
      target: "Moon",
      name: "Petřín hill",
      lat: 50.0835,
      lon: 14.3941,
      owner: 0,
      members: [1],
      max: 4,
      min: 2,
      day: 3,
      walk: 10,
      visibility: "circle",
    },
    {
      title: "Jupiter & a full constellation",
      target: "Jupiter",
      name: "Ďáblice observatory meadow",
      lat: 50.1436,
      lon: 14.4677,
      owner: 1,
      members: [2, 4],
      max: 3,
      min: 2,
      day: 4,
      walk: 5,
    },
    {
      title: "Bring your bike, bring your curiosity",
      target: "Moon",
      name: "Stromovka meeting point",
      lat: 50.1046,
      lon: 14.4213,
      owner: 7,
      members: [],
      max: 4,
      min: 2,
      day: 1,
      walk: 0,
      noSeats: true,
    },
    {
      title: "Watching the forecast together",
      target: "stargazing",
      name: "Jizerka village meeting point",
      lat: 50.8196,
      lon: 15.3467,
      owner: 3,
      members: [5],
      max: 4,
      min: 2,
      day: 5,
      walk: 10,
      bad: true,
    },
  ];
  for (const [i, c] of configs.entries()) {
    const day = today.add({ days: c.day }),
      loc = { lat: c.lat, lon: c.lon };
    let start = Temporal.ZonedDateTime.from(`${day}T19:00[${timezone}]`)
        .toInstant()
        .toString(),
      end = new Date(Date.parse(start) + 3600000).toISOString();
    for (let h = 18; h <= 25; h++) {
      const time = Temporal.ZonedDateTime.from(
        `${day.add({ days: h >= 24 ? 1 : 0 })}T${String(h % 24).padStart(2, "0")}:00[${timezone}]`,
      )
        .toInstant()
        .toString();
      if (
        assessSky(loc, Date.parse(time), Date.parse(time) + 3600000, c.target)
          .suitable
      ) {
        start = time;
        end = new Date(Date.parse(time) + 3600000).toISOString();
        break;
      }
    }
    const owner = users[c.owner],
      members = [owner, ...c.members.map((n) => users[n])];
    const site = {
      id: `seed-site-${i}`,
      name: c.name,
      location: loc,
      meetingPoint: loc,
      walkMinutes: c.walk,
      access: "confirmed",
      accessNote:
        "Meet at the public entrance. Bring warm layers and a red light; leave the area as you found it.",
      accessWindows: [
        {
          start: new Date(Date.parse(start) - 8 * 3600000).toISOString(),
          end: new Date(Date.parse(end) + 8 * 3600000).toISOString(),
        },
      ],
      bortle: null,
      skyQualitySource: null,
    };
    const limits = requestSchema.parse({
      organizerId: owner.id,
      target: c.target,
      start,
      end,
      timezone,
      minPeople: c.min,
      maxPeople: c.max,
      durationMinutes: 60,
    });
    const people = members.map((u) => ({
      userId: u.id,
      preferences: structuredClone(u.preferences),
      response: "accepted",
      revision: 1,
      channel: "email",
      source: "app",
      transport: u.preferences.travel[0],
    }));
    for (const p of people.filter((p) => p.transport === "ride"))
      p.preferences.origin = structuredClone(owner.preferences.origin);
    if (c.noSeats) people[0].preferences.car.offerRides = false;
    const o = {
      id: randomUUID(),
      seed: true,
      organizerId: owner.id,
      title: c.title,
      target: c.target,
      visibility: c.visibility || "open",
      status: c.bad
        ? "needs_review"
        : members.length >= c.min
          ? "confirmed"
          : "invited",
      everConfirmed: members.length >= c.min,
      confirmationNotified: true,
      revision: 1,
      version: 1,
      start,
      end,
      timezone,
      site,
      minPeople: c.min,
      maxPeople: c.max,
      deadline: new Date(Date.parse(start) - 1800000).toISOString(),
      invitationHoldHours: 24,
      people,
      comments: [],
      routes: [],
      carpools: [],
      limits,
      tags: c.tags || [],
      equipment:
        c.target === "stargazing"
          ? ["Bring warm layers, a red light and your curiosity."]
          : [
              `${owner.preferences.name} is bringing a telescope and is happy to show beginners.`,
            ],
      astronomy: assessSky(loc, Date.parse(start), Date.parse(end), c.target),
      weather: {
        suitable: !c.bad,
        maxCloudCover: c.bad ? 82 : 12 + i * 3,
        maxWindKmh: 8 + i,
        minTemperatureC: 3,
        maxPrecipitationProbability: c.bad ? 65 : 5,
        fetchedAt: new Date().toISOString(),
        source: "Open-Meteo",
        fixture: true,
      },
      traffic: {
        model: "approximated",
        description:
          "Approximate traffic, with a 10-minute driving buffer each way. Not live congestion or a departure-time forecast.",
      },
      createdAt: new Date().toISOString(),
    };
    // Seed content is isolated from real provider sends; live joining still checks Geoapify journeys.
    hub.data.outings.push(o);
  }
  hub.data.seedVersion = 1;
  await hub.store.persist();
  return { users: users.length, outings: configs.length };
}
