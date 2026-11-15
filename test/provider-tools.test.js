import test from "node:test";
import assert from "node:assert/strict";
import { geoapifyTools, skyTools } from "../src/providers/tools.js";
import { solverFixture } from "./helpers/solver-fixture.js";
import { operations } from "../web/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { resolve } from "node:path";

const at = new Date(Date.now() + 86400000).toISOString(),
  end = new Date(Date.parse(at) + 3600000).toISOString();
const location = { lat: 50.1, lon: 14.4 };

test("Geoapify exposes separate upstream tools and forwards the agent arguments unchanged", async () => {
  const calls = [],
    provider = geoapifyTools({
      call: async (name, args) => {
        calls.push({ name, args });
        return { source: "upstream", name };
      },
    });
  assert.deepEqual(
    provider.tools.map((t) => t.name).sort(),
    [
      "geocode_address",
      "list_place_categories",
      "search_places",
      "calculate_route",
      "calculate_route_matrix",
    ].sort(),
  );
  const args = {
    sources: [location],
    targets: [{ lat: 50.2, lon: 14.5 }],
    mode: "drive",
    traffic: "approximated",
  };
  assert.equal(
    (await provider.callTool("calculate_route_matrix", args)).source,
    "upstream",
  );
  assert.deepEqual(calls, [{ name: "calculate_route_matrix", args }]);
  await assert.rejects(provider.callTool("unknown", {}), /Unknown/);
});

test("sky tools return raw weather with units and coverage, and compute astronomy without weather", async () => {
  const f = await solverFixture();
  try {
    const p = skyTools({ forecast: f.forecast });
    const forecast = await p.callTool("get_weather_forecast", {
      location,
      start: at,
      end,
    });
    assert.equal(forecast.complete, true);
    assert.equal(forecast.units.wind_speed_10m, "km/h");
    assert.ok(forecast.hours.length);
    const sky = await skyTools({
      forecast: () => assert.fail("Astronomy must not need a forecast"),
    }).callTool("calculate_astronomy", {
      location,
      start: at,
      end,
      target: "Saturn",
    });
    assert.equal(sky.samples.length, 5);
    assert.ok(Number.isFinite(sky.samples[0].targetAltitude));
    assert.ok(Number.isFinite(sky.samples[0].moonIllumination));
    assert.equal(sky.source, "Astronomy Engine");
    assert.ok(Number.isFinite(sky.samples[0].moonAzimuth));
    assert.ok(Number.isFinite(sky.samples[0].sunAzimuth));
    await assert.rejects(
      p.callTool("get_weather_forecast", { location, start: end, end: at }),
      /End must/,
    );
    await assert.rejects(
      p.callTool("calculate_astronomy", {
        location,
        start: at,
        end: new Date(Date.parse(at) + 3 * 86400000).toISOString(),
        target: "Moon",
      }),
      /two|2 days/,
    );
    const missing = await skyTools({
      forecast: async () => ({
        source: "fixture",
        fetchedAt: at,
        hours: [],
      }),
    }).callTool("get_weather_forecast", { location, start: at, end });
    assert.equal(missing.complete, false);
  } finally {
    await f.close();
  }
});

test("a client can validate and save its own researched site without using site discovery or a backend model", async (t) => {
  const f = await solverFixture({
    run: async () => assert.fail("No backend model"),
  });
  t.after(f.close);
  const call = (name, args) => {
    const op = operations(f.hub, f.owner.id)[name];
    return op.run(op.schema.parse(args));
  };
  const s = await call("begin_planning", f.input);
  const registered = await call("register_planning_site", {
    planningId: s.planningId,
    name: "Independently found meadow",
    location,
    meetingPoint: location,
    walkMinutes: 5,
    source: "Geoapify search_places result",
  });
  assert.equal(registered.site.access, "unverified");
  assert.equal(registered.site.bortle, null);
  const candidate = await call("check_plan_candidate", {
    planningId: s.planningId,
    siteId: registered.site.id,
    start: `${f.day}T20:00:00Z`,
    participantIds: [f.owner.id],
    transports: { [f.owner.id]: "walk" },
  });
  assert.ok(candidate.candidateId);
  const saved = await call("save_plan_candidate", {
    planningId: s.planningId,
    candidateId: candidate.candidateId,
    explanation: "Chosen after independently comparing provider data.",
  });
  assert.equal(saved.site.name, registered.site.name);
  assert.equal(saved.site.access, "unverified");
  await assert.rejects(
    f.hub.invite(f.owner.id, { outingId: saved.id, participantIds: [] }),
    /access/i,
  );
});

test("the background agent can call each provider itself and commit its researched site", async (t) => {
  let f;
  const runtime = {
    run: async ({ tools, callTool }) => {
      for (const name of [
        "search_places",
        "calculate_route_matrix",
        "calculate_route",
        "get_weather_forecast",
        "calculate_astronomy",
        "register_site",
      ])
        assert.ok(tools.some((t) => t.name === name));
      const ctx = await callTool("read_planning_context", {});
      await callTool("list_place_categories", {});
      const found = await callTool("search_places", {
        category: "tourism.attraction.viewpoint",
        lat: location.lat,
        lon: location.lon,
      });
      const { lat, lon, name } = found.features[1].properties;
      await callTool("calculate_route_matrix", {
        sources: [location],
        targets: [{ lat, lon }],
        mode: "walk",
      });
      await callTool("calculate_route", {
        waypoints: [location, { lat, lon }],
        mode: "walk",
      });
      const start = `${f.day}T20:00:00Z`,
        until = `${f.day}T21:00:00Z`;
      await callTool("get_weather_forecast", {
        location: { lat, lon },
        start,
        end: until,
      });
      await callTool("calculate_astronomy", {
        location: { lat, lon },
        start,
        end: until,
        target: "stargazing",
      });
      const { site } = await callTool("register_site", {
        name,
        location: { lat, lon },
        meetingPoint: { lat, lon },
        walkMinutes: 5,
        source: "Geoapify result",
      });
      const choice = await callTool("evaluate_candidate", {
        siteId: site.id,
        start,
        participantIds: [ctx.organizer.id],
        transports: { [ctx.organizer.id]: "walk" },
      });
      await callTool("finish_plan", {
        candidateId: choice.candidateId,
        explanation:
          "Compared the provider evidence; access remains unverified.",
      });
    },
  };
  f = await solverFixture(runtime);
  t.after(f.close);
  const result = await f.hub.plan(f.owner.id, f.input);
  assert.equal(result.site.name, "Quiet hill");
  assert.equal(result.solver.execution, "server");
  assert.ok(result.solver.trace.some((t) => t.tool === "calculate_route"));
});

test("standalone provider MCPs work without the database or StarGazer token", async (t) => {
  for (const group of ["geoapify", "sky"]) {
    const client = new Client({ name: "provider-test", version: "1" });
    t.after(() => client.close());
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [resolve("src/provider-server.js"), group],
        env: { PATH: process.env.PATH },
        stderr: "pipe",
      }),
    );
    const names = (await client.listTools()).tools.map((t) => t.name);
    assert.equal(names.length, group === "geoapify" ? 5 : 2);
    if (group === "sky") {
      const result = await client.callTool({
        name: "calculate_astronomy",
        arguments: { location, start: at, end, target: "Moon" },
      });
      assert.equal(Boolean(result.isError), false);
      assert.equal(result.structuredContent.source, "Astronomy Engine");
    } else {
      const result = await client.callTool({
        name: "geocode_address",
        arguments: { query: "Prague" },
      });
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /GEOAPIFY_API_KEY/);
    }
  }
});

test("existing-outing matching has direct research tools without permission to save or invite", async () => {
  const { rankWithCodex } = await import("../web/server/solvers/codex.js");
  const calls = [];
  const results = await rankWithCodex(
    {
      run: async ({ tools, callTool }) => {
        assert.ok(tools.some((t) => t.name === "calculate_route_matrix"));
        assert.ok(tools.some((t) => t.name === "calculate_astronomy"));
        assert.ok(!tools.some((t) => t.name === "invite_outing"));
        await callTool("calculate_route_matrix", {
          sources: [location],
          targets: [location],
          mode: "walk",
        });
        await callTool("rank_outings", {
          choices: [
            { id: "a", reason: "The public meeting point is nearby." },
          ],
        });
      },
    },
    { origin: { location } },
    [{ id: "a", site: { name: "Park", location }, remaining: 2 }],
    undefined,
    {
      geo: {
        call: async (name, args) => {
          calls.push({ name, args });
          return {
            time_units: "seconds",
            sources_to_targets: [[{ time: 0 }]],
          };
        },
      },
    },
  );
  assert.equal(results[0].id, "a");
  assert.equal(calls.length, 1);
});
