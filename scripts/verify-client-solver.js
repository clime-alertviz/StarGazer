import assert from "node:assert/strict";
import { mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { solverFixture } from "../test/helpers/solver-fixture.js";
import { CodexRuntime } from "../web/server/solvers/index.js";
import { geoapifyTools, skyTools } from "../src/providers/tools.js";
import { createHub } from "../web/hub.js";

let backendCalls = 0;
const f = await solverFixture({
  run: async () => {
    backendCalls++;
    throw new Error("Backend LLM must not run in client mode");
  },
  close() {},
});
for (const [name, note, guide] of [
  ["Sam", "Happy to teach quiet night photography.", true],
  ["Jamie", "I prefer lively social evenings.", false],
]) {
  const u = f.hub.identity.user(`${name.toLowerCase()}@fixture.test`);
  await f.hub.saveProfile(u.id, {
    ...f.owner.preferences,
    name,
    interestNote: note,
    experience: guide ? "experienced" : "beginner",
    happyToTeach: guide,
  });
  f.hub.data.connections.push({
    from: f.owner.id,
    to: u.id,
    status: "accepted",
  });
}
await f.store.persist();
f.store.close();
const app = await createHub({
  directory: f.directory,
  port: 0,
  geo: f.geo,
  forecast: f.forecast,
  solvers: f.solvers,
  providers: {
    status: () => ({ googleConnected: false }),
    mail: async () => ({ delivery: "local_only" }),
  },
});
const { token } = await app.hub.identity.issue(f.owner.id);
const runtime = new CodexRuntime({
  directory: "private/client-solver-check",
});
const trace = [];
let saved;
async function rpc(method, params) {
  const r = await fetch(app.url + "/mcp", {
    method: "POST",
    headers: {
      Origin: app.url,
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  assert.equal(r.status, 200);
  const result = await r.json();
  assert.ok(!result.error, JSON.stringify(result.error));
  return result.result;
}
try {
  const allowed = [
    "get_state",
    "begin_planning",
    "register_planning_site",
    "check_plan_candidate",
    "save_plan_candidate",
  ];
  const tools = (await rpc("tools/list", {})).tools
    .filter((t) => allowed.includes(t.name))
    .map(({ name, description, inputSchema }) => ({
      name,
      description,
      inputSchema,
    }));
  const providers = [
    geoapifyTools(f.geo),
    skyTools({ forecast: f.forecast }),
  ];
  const providerByTool = new Map(
    providers.flatMap((p) => p.tools.map((t) => [t.name, p])),
  );
  tools.push(...providers.flatMap((p) => p.tools));
  const skill = await readFile("skills/star-gazer/SKILL.md", "utf8");
  await runtime.run({
    tools,
    onProgress: console.log,
    prompt: `${skill}\n\nTEST REQUEST: You are the user's local Codex client. Use the exposed HTTP MCP tools to organize a quiet photography evening with a teacher. Compare at least two candidates; choose companions using their interests. Do not send invitations. The service has no working backend LLM. Request parameters: ${JSON.stringify({ ...f.input, visibility: "circle", participantIds: app.hub.friends(f.owner.id), needsGuide: true, maxPeople: 2 })}`,
    callTool: async (name, args) => {
      console.log(name);
      if (providerByTool.has(name)) {
        const value = await providerByTool.get(name).callTool(name, args);
        trace.push({
          tool: name,
          status: "ok",
          group:
            name.includes("weather") || name.includes("astronomy")
              ? "sky"
              : "geoapify",
        });
        return value;
      }
      const result = await rpc("tools/call", { name, arguments: args });
      if (result.isError) {
        trace.push({ tool: name, status: "rejected" });
        throw new Error(result.content[0].text);
      }
      const value = JSON.parse(result.content[0].text);
      trace.push({
        tool: name,
        status: "ok",
        ...(name === "check_plan_candidate"
          ? { siteId: args.siteId, start: args.start, result: value.status }
          : {}),
      });
      if (name === "save_plan_candidate") saved = value;
      return value;
    },
  });
  assert.ok(saved, "Client must save a draft");
  assert.equal(saved.solver.execution, "client");
  assert.equal(backendCalls, 0);
  assert.equal(app.hub.data.outings.length, 1);
  assert.equal(saved.status, "draft");
  assert.deepEqual(saved.people.map((p) => p.name).sort(), ["Alex", "Sam"]);
  assert.ok(
    trace.filter(
      (t) => t.tool === "check_plan_candidate" && t.status === "ok",
    ).length >= 2,
  );
  for (const name of [
    "search_places",
    "get_weather_forecast",
    "calculate_astronomy",
    "register_planning_site",
  ])
    assert.ok(
      trace.some((t) => t.tool === name),
      `Missing direct provider step: ${name}`,
    );
  assert.ok(
    trace.some((t) =>
      ["calculate_route_matrix", "calculate_route"].includes(t.tool),
    ),
  );
  const report = {
    checkedAt: new Date().toISOString(),
    status: "passed",
    provenance:
      "Actual Codex client model uses StarGazer HTTP MCP plus independent Geoapify and sky tool groups. Backend model throws if invoked. Fixture Geoapify/weather; real Astronomy Engine; temporary SQLite.",
    backendModelCalls: backendCalls,
    selected: {
      site: saved.site.name,
      start: saved.start,
      people: saved.people.map((p) => ({
        name: p.name,
        transport: p.transport,
      })),
    },
    summary: saved.solver.summary,
    trace,
  };
  await mkdir("examples/generated", { recursive: true });
  await writeFile(
    "examples/generated/client-solver-live-check.json",
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  runtime.close();
  await app.close();
  await rm(f.directory, { recursive: true, force: true });
}
