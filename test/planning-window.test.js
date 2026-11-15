import test from "node:test";
import assert from "node:assert/strict";
import {
  defaultPlanningWindow,
  planningWindowProblem,
} from "../src/planning-window.js";
import { request } from "../src/schema.js";
const now = +new Date("2026-11-15T16:00:00Z");
const short = {
  start: "2026-11-17T18:00:00Z",
  end: "2026-11-17T18:30:00Z",
};

test("a short inherited slot gets a useful evening including travel and preparation", () => {
  const result = defaultPlanningWindow([short], {}, now);
  assert.equal(result.start, Date.parse(short.start));
  assert.ok(result.end - result.start >= 6 * 3600000);
  assert.equal(result.adjusted, true);
  assert.equal(planningWindowProblem(result, { preparation: true }), null);
  assert.equal(short.end, "2026-11-17T18:30:00Z");
});

test("valid saved evenings are retained and fallback defaults pass validation", () => {
  const long = { ...short, end: "2026-11-18T01:00:00Z" };
  const result = defaultPlanningWindow([short, long], {}, now);
  assert.equal(result.end, Date.parse(long.end));
  assert.equal(result.adjusted, false);
  for (const windows of [
    [],
    [{ start: "2026-11-14T18:00:00Z", end: "2026-11-14T19:00:00Z" }],
  ]) {
    const fallback = defaultPlanningWindow(
      windows,
      { maxTravelMinutes: 240 },
      now,
    );
    assert.ok(fallback.start > now);
    assert.equal(
      planningWindowProblem(fallback, { preparation: true }),
      null,
    );
  }
});

test("reversed dates, short evenings and excessive ranges have distinct messages", () => {
  const input = { ...short, durationMinutes: 60 };
  assert.match(
    planningWindowProblem({ ...input, end: "2026-11-17T11:30:00Z" })
      .message,
    /following date and an AM time/,
  );
  assert.match(
    planningWindowProblem(input, { preparation: true }).message,
    /30 minutes available.*60 minutes.*30 minutes for setup/,
  );
  assert.match(
    planningWindowProblem({ ...input, end: "2026-11-25T18:00:00Z" })
      .message,
    /at most 7 days apart/,
  );
  assert.equal(
    planningWindowProblem(
      { ...input, end: "2026-11-18T00:30:00Z" },
      { preparation: true },
    ),
    null,
  );
  const parsed = request.safeParse({
    organizerId: "a",
    target: "stargazing",
    timezone: "Europe/Prague",
    ...input,
  });
  assert.equal(parsed.success, false);
  assert.match(parsed.error.issues[0].message, /30 minutes available/);
});
