import test from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { solverFixture } from "./helpers/solver-fixture.js";
import { SolverBackends } from "../web/server/solvers/index.js";
import { rankWithCodex } from "../web/server/solvers/codex.js";
import { createHub } from "../web/hub.js";
import { defaultPlanningWindow } from "../src/planning-window.js";
import { expandSlots } from "../web/server/availability.js";

const candidate = (id, start, siteId = "spot-1") => ({
  siteId,
  start,
  participantIds: [id],
  transports: { [id]: "walk" },
});
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

test("both agents receive the confirmed evening instead of a short saved slot, and an open draft can start alone", async (t) => {
  let f;
  const runtime = {
    run: async ({ callTool }) => {
      const ctx = await callTool("read_planning_context", {});
      assert.deepEqual(ctx.organizer.availability, [
        { start: input.start, end: input.end },
      ]);
      assert.equal(
        ctx.organizer.availabilitySource,
        "confirmed_for_this_outing",
      );
      assert.equal(ctx.organizer.slots, undefined);
      assert.deepEqual(
        ctx.people.find((p) => p.id === f.owner.id),
        ctx.organizer,
      );
      assert.equal(ctx.groupGoal.minimumToConfirm, 2);
      assert.equal(ctx.groupGoal.canStartWithOrganizerOnly, true);
      assert.equal(ctx.siteSearch.walkingOnly, true);
      assert.equal(ctx.siteSearch.initialRadiusMeters, 1600);
      assert.ok(
        ctx.siteSearch.suggestedCategories.includes("leisure.park"),
      );
      const other = ctx.people.find((p) => p.id === friend.id);
      assert.deepEqual(other.availability, [
        { start: `${f.day}T18:00:00Z`, end: `${f.day}T18:30:00Z` },
      ]);
      await callTool("discover_sites", {});
      const at = `${f.day}T20:00:00Z`;
      const unavailableFriend = await callTool("evaluate_candidate", {
        ...candidate(f.owner.id, at),
        participantIds: [f.owner.id, friend.id],
        transports: { [f.owner.id]: "walk", [friend.id]: "walk" },
      });
      assert.equal(unavailableFriend.status, "no_match");
      const alone = await callTool(
        "evaluate_candidate",
        candidate(f.owner.id, at),
      );
      assert.ok(alone.candidateId);
      await callTool("finish_plan", {
        candidateId: alone.candidateId,
        explanation:
          "A nearby walking draft within your confirmed evening; another person can join the open place.",
      });
    },
  };
  f = await solverFixture(runtime);
  t.after(f.close);
  const shortSlots = [
    { date: f.day, from: "19:00", until: "19:30", weekly: false },
  ];
  await f.hub.saveProfile(f.owner.id, {
    ...f.owner.preferences,
    maxWalkMinutes: 20,
    slots: shortSlots,
  });
  const friend = f.hub.identity.user("friend@solver.test");
  await f.hub.saveProfile(friend.id, {
    ...structuredClone(f.owner.preferences),
    name: "Friend",
  });
  f.hub.data.connections.push({
    from: f.owner.id,
    to: friend.id,
    status: "accepted",
  });
  const proposed = defaultPlanningWindow(
    expandSlots(shortSlots, "Europe/Prague", f.start, f.end),
    f.owner.preferences,
  );
  const input = {
    ...f.input,
    start: new Date(proposed.start).toISOString(),
    end: new Date(proposed.end).toISOString(),
    participantIds: [friend.id],
  };
  const client = await f.hub.clientPlanning.begin(f.owner.id, input);
  assert.equal(client.organizer.slots, undefined);
  assert.deepEqual(client.organizer.availability, [
    { start: input.start, end: input.end },
  ]);
  assert.equal(
    Date.parse(input.end) - Date.parse(input.start),
    6 * 3600000,
  );
  const result = await f.hub.plan(f.owner.id, input);
  assert.equal(result.status, "draft");
  assert.equal(result.minPeople, 2);
  assert.equal(result.people.length, 1);
  assert.equal(result.people[0].transport, "walk");
  assert.equal(result.pendingTransport.length, 0);
  assert.ok(Date.parse(result.routes[0].homeBy) <= Date.parse(input.end));
  assert.deepEqual(f.owner.preferences.slots, shortSlots);
  assert.equal(f.hub.data.messages.length, 0);
});

test("the agent chooses circle members and an offered travel mode, with guide checks enforced", async (t) => {
  let f, teacher, companion;
  const runtime = {
    run: async ({ callTool }) => {
      const context = await callTool("read_planning_context", {});
      assert.equal(context.people.length, 3);
      assert.match(
        context.people.find((p) => p.id === teacher.id).interestNote,
        /teach photography/,
      );
      await callTool("discover_sites", {});
      const proposal = {
        siteId: "spot-1",
        start: `${f.day}T20:00:00Z`,
        participantIds: [f.owner.id, companion.id],
        transports: {
          [f.owner.id]: "walk",
          [companion.id]: "bicycle",
        },
      };
      const failed = await callTool("evaluate_candidate", proposal);
      assert.equal(failed.status, "no_match");
      const passed = await callTool("evaluate_candidate", {
        ...proposal,
        participantIds: [f.owner.id, teacher.id],
        transports: { [f.owner.id]: "walk", [teacher.id]: "bicycle" },
      });
      assert.ok(passed.candidateId);
      await callTool("finish_plan", {
        candidateId: passed.candidateId,
        explanation:
          "The photography teacher offers the requested guidance and can cycle within the journey limits.",
      });
    },
  };
  f = await solverFixture(runtime);
  t.after(f.close);
  teacher = f.hub.identity.user("teacher@solver.test");
  companion = f.hub.identity.user("companion@solver.test");
  for (const u of [teacher, companion]) {
    await f.hub.saveProfile(u.id, {
      ...structuredClone(f.owner.preferences),
      name: u === teacher ? "Sam" : "Jamie",
      travel: ["walk", "bicycle"],
      experience: u === teacher ? "experienced" : "beginner",
      happyToTeach: u === teacher,
      interestNote:
        u === teacher
          ? "I can teach photography."
          : "A social evening would be lovely.",
    });
    f.hub.data.connections.push({
      from: f.owner.id,
      to: u.id,
      status: "accepted",
    });
  }
  const plan = await f.hub.plan(f.owner.id, {
    ...f.input,
    visibility: "circle",
    needsGuide: true,
    maxPeople: 2,
    participantIds: [companion.id, teacher.id],
  });
  assert.deepEqual(
    plan.people.map((p) => p.id).sort(),
    [f.owner.id, teacher.id].sort(),
  );
  assert.equal(
    plan.people.find((p) => p.id === teacher.id).transport,
    "bicycle",
  );
  assert.ok(plan.alternatives.some((p) => p.id === companion.id));
  assert.equal(f.hub.data.messages.length, 0);
});

test("background planning tools work over authenticated HTTP MCP and hide other users' jobs", async (t) => {
  const f = await solverFixture({
    run: async ({ signal }) =>
      new Promise((resolve, reject) => {
        if (signal.aborted) return reject(new Error("Stopped"));
        signal.addEventListener(
          "abort",
          () => reject(new Error("Stopped")),
          {
            once: true,
          },
        );
      }),
  });
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
  t.after(async () => {
    await app.close();
    await rm(f.directory, { recursive: true, force: true });
  });
  const ownerToken = (await app.hub.identity.issue(f.owner.id)).token;
  const other = app.hub.identity.user("other@solver.test");
  const otherToken = (await app.hub.identity.issue(other.id)).token;
  let sequence = 0;
  const call = async (name, args, token = ownerToken) => {
    const res = await fetch(`${app.url}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: ++sequence,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    return {
      error: body.result.isError,
      value: body.result.isError
        ? body.result.content[0].text
        : JSON.parse(body.result.content[0].text),
    };
  };
  const started = await call("start_plan", f.input);
  assert.equal(started.value.status, "running");
  const jobId = started.value.id;
  assert.equal((await call("get_plan_job", { jobId })).value.id, jobId);
  assert.equal(
    (await call("get_plan_job", { jobId }, otherToken)).error,
    true,
  );
  assert.equal(
    (await call("cancel_plan_job", { jobId }, otherToken)).error,
    true,
  );
  assert.equal(
    (await call("cancel_plan_job", { jobId })).value.status,
    "cancelled",
  );
  assert.equal(app.hub.data.outings.length, 0);
});

test("Codex is the default backend and selects an evaluated alternative, not a deterministic winner", async (t) => {
  let f;
  const runtime = {
    run: async ({ callTool }) => {
      const ctx = await callTool("read_planning_context", {});
      assert.match(ctx.organizer.interestNote, /quiet photography/);
      assert.equal(
        JSON.stringify(ctx).includes("owner@solver.test"),
        false,
      );
      await callTool("discover_sites", {});
      const windows = await callTool("inspect_conditions", {
        siteId: "spot-1",
      });
      assert.ok(windows.windows.length);
      const first = await callTool(
        "evaluate_candidate",
        candidate(f.owner.id, `${f.day}T19:00:00Z`, "spot-0"),
      );
      const second = await callTool(
        "evaluate_candidate",
        candidate(f.owner.id, `${f.day}T20:00:00Z`),
      );
      assert.ok(first.candidateId && second.candidateId);
      await callTool("finish_plan", {
        candidateId: second.candidateId,
        explanation:
          "The quiet hill fits the photography preference; access still needs checking.",
      });
      return "Done";
    },
  };
  f = await solverFixture(runtime);
  t.after(f.close);
  assert.equal(f.solvers.defaultBackend, "codex");
  const result = await f.hub.plan(f.owner.id, f.input);
  assert.equal(result.site.name, "Quiet hill");
  assert.equal(result.start, `${f.day}T20:00:00.000Z`);
  assert.equal(result.solver.backend, "codex");
  assert.equal(result.solver.checkedCandidates, 2);
  assert.equal(f.hub.data.outings.length, 1);
  assert.equal(result.status, "draft");
  assert.equal(f.hub.data.messages.length, 0);
});

test("invented candidates, outsiders, unavailable modes and out-of-window times cannot bypass checks", async (t) => {
  let f;
  const runtime = {
    run: async ({ callTool }) => {
      await callTool("read_planning_context", {});
      await callTool("discover_sites", {});
      const valid = candidate(f.owner.id, `${f.day}T20:00:00Z`);
      await assert.rejects(
        callTool("evaluate_candidate", {
          ...valid,
          siteId: "invented",
        }),
        /site ID/,
      );
      await assert.rejects(
        callTool("evaluate_candidate", {
          ...valid,
          participantIds: [f.owner.id, "outsider"],
        }),
        /allowed group/,
      );
      await assert.rejects(
        callTool("evaluate_candidate", {
          ...valid,
          transports: { [f.owner.id]: "drive" },
        }),
        /participant offered/,
      );
      await assert.rejects(
        callTool("evaluate_candidate", {
          ...valid,
          start: `${f.day}T05:00:00Z`,
        }),
        /outside/,
      );
      const evaluated = await callTool("evaluate_candidate", valid);
      await assert.rejects(
        callTool("finish_plan", {
          candidateId: "invented",
          explanation: "Pretend success",
        }),
        /candidate ID/,
      );
      await callTool("finish_plan", {
        candidateId: evaluated.candidateId,
        explanation: "A checked walking plan.",
      });
    },
  };
  f = await solverFixture(runtime);
  t.after(f.close);
  const result = await f.hub.plan(f.owner.id, f.input);
  assert.ok(
    result.solver.trace.filter((e) => e.status === "rejected").length >= 5,
  );
  assert.equal(result.people[0].transport, "walk");
});

test("agent failure and incomplete output create no draft; deterministic backend is an explicit alternative", async (t) => {
  let calls = 0;
  const f = await solverFixture({
    run: async () => {
      calls++;
      throw new Error("Model unavailable");
    },
  });
  t.after(f.close);
  await assert.rejects(
    f.hub.plan(f.owner.id, f.input),
    /Model unavailable/,
  );
  assert.equal(f.hub.data.outings.length, 0);
  const rule = await f.hub.plan(f.owner.id, {
    ...f.input,
    solver: "deterministic",
  });
  assert.equal(rule.solver.backend, "deterministic");
  assert.equal(calls, 1);
  f.solvers.runtime = {
    run: async () => "An invented plan without a tool result.",
  };
  await assert.rejects(
    f.hub.plan(f.owner.id, f.input),
    /did not select a validated plan/,
  );
  assert.equal(f.hub.data.outings.length, 1);
});

test("background planning cannot save stale choices after a profile changes during the model turn", async (t) => {
  let f;
  f = await solverFixture({
    run: async ({ callTool }) => {
      await callTool("discover_sites", {});
      const result = await callTool(
        "evaluate_candidate",
        candidate(f.owner.id, `${f.day}T20:00:00Z`),
      );
      await callTool("finish_plan", {
        candidateId: result.candidateId,
        explanation: "A checked walking plan.",
      });
      await f.hub.saveProfile(f.owner.id, {
        ...f.owner.preferences,
        maxWalkMinutes: 0,
        channel: "calendar",
      });
    },
  });
  t.after(f.close);
  await assert.rejects(
    f.hub.plan(f.owner.id, f.input),
    /changed while planning/,
  );
  assert.equal(f.hub.data.outings.length, 0);
  assert.equal(f.hub.data.messages.length, 0);
});

test("hard journey constraints are checked before a Codex candidate can be selected", async (t) => {
  let f;
  const runtime = {
    run: async ({ callTool }) => {
      await callTool("discover_sites", {});
      // Observing right at Available from leaves no time for outward travel/setup.
      const rejected = await callTool(
        "evaluate_candidate",
        candidate(f.owner.id, f.start),
      );
      assert.equal(rejected.status, "no_match");
      assert.equal(rejected.candidateId, undefined);
      await callTool("finish_plan", {
        candidateId: null,
        explanation:
          "The tested time leaves no room for the journey. Try a later observing start.",
      });
    },
  };
  f = await solverFixture(runtime);
  t.after(f.close);
  const result = await f.hub.plan(f.owner.id, f.input);
  assert.equal(result.status, "no_match");
  assert.equal(f.hub.data.outings.length, 0);
});

test("cancelled agent jobs cannot persist a draft, and jobs are scoped to their user", async (t) => {
  let entered, release;
  const reached = new Promise((r) => {
    entered = r;
  });
  const blocked = new Promise((r) => {
    release = r;
  });
  const f = await solverFixture({
    run: async ({ signal }) => {
      entered();
      await blocked;
      signal.throwIfAborted();
    },
  });
  t.after(f.close);
  const job = f.hub.planningJobs.start(f.owner.id, f.input);
  assert.equal(f.hub.planningJobs.start(f.owner.id, f.input).id, job.id);
  assert.throws(
    () => f.hub.planningJobs.view("another-user", job.id),
    /not found/,
  );
  assert.throws(
    () => f.hub.planningJobs.view(f.owner.id, "missing"),
    /not found/,
  );
  await reached;
  f.hub.planningJobs.cancel(f.owner.id, job.id);
  release();
  await f.hub.planningJobs.jobs.get(job.id).task;
  assert.equal(
    f.hub.planningJobs.view(f.owner.id, job.id).status,
    "cancelled",
  );
  assert.equal(f.hub.data.outings.length, 0);
});

test("matching calls use free text and require exactly the authorized candidate IDs", async () => {
  const candidates = ["a", "b"].map((id) => ({
    id,
    title: id,
    site: { name: "Meadow" },
    matchReasons: [],
    people: [],
    remaining: 2,
  }));
  const choices = await rankWithCodex(
    {
      run: async ({ prompt, callTool }) => {
        assert.match(prompt, /quiet photography/);
        await assert.rejects(
          callTool("rank_outings", {
            choices: [
              { id: "a", reason: "a" },
              { id: "secret", reason: "b" },
            ],
          }),
          /supplied outing ID/,
        );
        await callTool("rank_outings", {
          choices: [
            { id: "b", reason: "Fits photography." },
            { id: "a", reason: "Another option." },
          ],
        });
      },
    },
    { interestNote: "quiet photography" },
    candidates,
  );
  assert.equal(choices[0].id, "b");
});

test("background matching coalesces identical requests and exposes failures without claiming an agent match", async (t) => {
  let count = 0;
  const solvers = new SolverBackends({
    rankingDelay: 0,
    runtime: {
      run: async ({ callTool }) => {
        count++;
        await callTool("rank_outings", {
          choices: [
            { id: "b", reason: "Fits." },
            { id: "a", reason: "Also possible." },
          ],
        });
      },
    },
  });
  t.after(() => solvers.close());
  const candidates = ["a", "b"].map((id) => ({
    id,
    title: id,
    site: { name: "Meadow" },
  }));
  assert.equal(
    solvers.rank("owner", {}, candidates)[0].matching.status,
    "pending",
  );
  solvers.rank("owner", {}, candidates);
  await tick();
  assert.equal(count, 1);
  const ready = solvers.rank("owner", {}, candidates);
  assert.equal(ready[0].id, "b");
  assert.equal(ready[0].matching.status, "ready");
  solvers.runtime = {
    run: async () => {
      throw new Error("Offline");
    },
  };
  solvers.rank("other", {}, candidates);
  await tick();
  const failed = solvers.rank("other", {}, candidates);
  assert.equal(failed[0].matching.status, "error");
  assert.equal(failed[0].matching.error, "Offline");
  assert.equal(failed[0].agentReason, undefined);
});
