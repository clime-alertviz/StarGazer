import test from "node:test";
import assert from "node:assert/strict";
import { Traffic } from "../web/server/traffic.js";
import { Addresses } from "../web/server/addresses.js";
const origin = { lat: 50, lon: 14 },
  pickup = { lat: 50.01, lon: 14.01 },
  site = { lat: 50.02, lon: 14.02 };
function outing() {
  return {
    site: { meetingPoint: site },
    people: [
      {
        userId: "driver",
        transport: "drive",
        response: "accepted",
        preferences: { name: "Driver", origin: { location: origin } },
      },
      { userId: "rider", transport: "ride", response: "accepted" },
    ],
    carpools: [
      {
        driverId: "driver",
        pickups: [{ participantId: "rider", pickup: { location: pickup } }],
      },
    ],
  };
}
test("traffic uses backend Geoapify MCP with pickups both ways and caches by actual route", async () => {
  const calls = [],
    traffic = new Traffic({
      call: async (tool, args) => {
        calls.push({ tool, args });
        return {
          time_units: "seconds",
          distance_units: "meters",
          time: args.traffic === "approximated" ? 900 : 600,
          distance: 5000,
        };
      },
    }),
    o = outing();
  const report = await traffic.report(o);
  assert.equal(calls.length, 4);
  assert.ok(
    calls.every((c) => c.tool === "calculate_route" && c.args.mode === "drive"),
  );
  assert.deepEqual(calls[0].args.waypoints, [origin, pickup, site]);
  assert.deepEqual(calls[2].args.waypoints, [site, pickup, origin]);
  assert.equal(report.drivers[0].outward.differenceMinutes, 5);
  assert.equal(report.drivers[0].homeward.minutes, 15);
  assert.equal(JSON.stringify(report).includes('"lat"'), false);
  await traffic.report(o);
  assert.equal(calls.length, 4);
  o.carpools[0].pickups[0].pickup.location = { lat: 50.005, lon: 14.005 };
  await traffic.report(o);
  assert.equal(calls.length, 8);
  o.people[0].response = "declined";
  assert.equal(await traffic.report(o), null);
  assert.equal(calls.length, 8);
});
test("driverless outings make no traffic calls and failures never become zero delays", async () => {
  const traffic = new Traffic({
      call: async () => {
        throw Error("offline");
      },
    }),
    o = outing();
  o.people[0].transport = "bicycle";
  assert.equal(await traffic.report(o), null);
  o.people[0].transport = "drive";
  const report = await traffic.report(o);
  assert.equal(report.drivers[0].outward.minutes, null);
  assert.equal(report.drivers[0].outward.differenceMinutes, null);
  assert.equal(report.drivers[0].unavailable, true);
});
test("address prefixes prioritize nearby places, complete addresses preserve town context and repeated searches are cached", async () => {
  const addresses = new Addresses({}),
    calls = [];
  addresses.request = async (endpoint, args) => {
    calls.push({ endpoint, args });
    return [
      {
        formatted: "Zlatá Hora, Slavkov u Brna",
        lat: 49.157528,
        lon: 16.8866311,
      },
    ];
  };
  const args = {
    query: "Zla",
    bias: { lat: 49.15, lon: 16.88 },
    country: "cz",
  };
  assert.equal(
    (await addresses.search(args))[0].name,
    "Zlatá Hora, Slavkov u Brna",
  );
  assert.equal(calls[0].args.filter, "circle:16.88,49.15,35000");
  await addresses.search(args);
  assert.equal(calls.length, 1);
  await addresses.search({ ...args, query: "Zlata Hora, Slavkov u Brna" });
  assert.equal(calls[1].args.filter, "countrycode:cz");
});
