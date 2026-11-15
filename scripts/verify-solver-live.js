import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { solverFixture } from "../test/helpers/solver-fixture.js";
import { CodexRuntime } from "../web/server/solvers/index.js";
import { rankWithCodex } from "../web/server/solvers/codex.js";

const runtime = new CodexRuntime({
  directory: "private/solver-check",
});
const f = await solverFixture(runtime);
try {
  const teacher = f.hub.identity.user("teacher@solver.test");
  const companion = f.hub.identity.user("companion@solver.test");
  for (const u of [teacher, companion]) {
    await f.hub.saveProfile(u.id, {
      ...structuredClone(f.owner.preferences),
      name: u === teacher ? "Sam" : "Jamie",
      travel: ["walk", "bicycle"],
      experience: u === teacher ? "experienced" : "beginner",
      happyToTeach: u === teacher,
      interestNote:
        u === teacher
          ? "Happy to teach quiet night photography."
          : "I like lively social evenings.",
    });
    f.hub.data.connections.push({
      from: f.owner.id,
      to: u.id,
      status: "accepted",
    });
  }
  const result = await f.hub.plan(
    f.owner.id,
    {
      ...f.input,
      visibility: "circle",
      needsGuide: true,
      maxPeople: 2,
      participantIds: [companion.id, teacher.id],
    },
    {
      onProgress: (message) => console.log(message),
    },
  );
  assert.notEqual(result.status, "no_match", JSON.stringify(result));
  assert.equal(result.solver.backend, "codex");
  assert.equal(result.status, "draft");
  assert.ok(
    result.solver.trace.some((t) => t.tool === "evaluate_candidate"),
  );
  assert.ok(result.solver.trace.some((t) => t.tool === "finish_plan"));
  assert.equal(f.hub.data.outings.length, 1);
  assert.deepEqual(
    result.people.map((p) => p.id).sort(),
    [f.owner.id, teacher.id].sort(),
  );
  for (const name of [
    "search_places",
    "get_weather_forecast",
    "calculate_astronomy",
    "register_site",
  ])
    assert.ok(
      result.solver.trace.some((t) => t.tool === name),
      `Missing direct provider call: ${name}`,
    );
  assert.ok(
    result.solver.trace.some((t) =>
      ["calculate_route_matrix", "calculate_route"].includes(t.tool),
    ),
  );
  const matches = await rankWithCodex(runtime, f.owner.preferences, [
    {
      id: "social",
      title: "Lively social evening",
      target: "stargazing",
      site: { name: "Public meadow" },
      people: [],
      remaining: 2,
      matchReasons: ["Social evenings"],
    },
    {
      id: "photo",
      title: "Quiet night photography",
      target: "stargazing",
      site: { name: "Public meadow" },
      people: [],
      remaining: 2,
      matchReasons: ["Photography"],
    },
  ]);
  assert.equal(matches[0].id, "photo");
  const alias = (id) =>
    id === f.owner.id
      ? "organizer"
      : id === teacher.id
        ? "teacher"
        : "companion";
  const report = {
    checkedAt: new Date().toISOString(),
    status: "passed",
    provenance:
      "Real Codex app-server model turn; deterministic weather and Geoapify fixtures, real Astronomy Engine, temporary SQLite database.",
    selected: {
      site: result.site.name,
      start: result.start,
      end: result.end,
      transport: result.people[0].transport,
      participants: result.people.map((p) => ({
        id: alias(p.id),
        transport: p.transport,
      })),
    },
    matching: matches,
    summary: result.solver.summary,
    trace: result.solver.trace.map((t) => ({
      ...t,
      ...(t.arguments
        ? {
            arguments: {
              ...t.arguments,
              participantIds: t.arguments.participantIds.map(alias),
              transports: Object.fromEntries(
                Object.entries(t.arguments.transports).map(
                  ([id, transport]) => [alias(id), transport],
                ),
              ),
            },
          }
        : {}),
    })),
  };
  await mkdir("examples/generated", { recursive: true });
  await writeFile(
    "examples/generated/solver-live-check.json",
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  await f.close();
}
