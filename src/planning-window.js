import { setupMinutes, packUpMinutes } from "./timing.js";

const minute = 60000;
const day = 86400000;

// Shared by the form and the service so the same dates get the same explanation.
export function planningWindowProblem(
  { start, end, durationMinutes = 60 },
  { preparation = false } = {},
) {
  const from = +new Date(start),
    until = +new Date(end);
  if (!Number.isFinite(from) || !Number.isFinite(until))
    return {
      field: "end",
      message:
        "Choose a valid date and time for Available from and Home by.",
    };
  if (until <= from)
    return {
      field: "end",
      message:
        "Home by must be after Available from. For after midnight, choose the following date and an AM time.",
    };
  const minutes = (until - from) / minute;
  const minimum =
    durationMinutes + (preparation ? setupMinutes + packUpMinutes : 0);
  if (minutes < minimum)
    return {
      field: "end",
      message: `You have ${Math.floor(minutes)} minutes available, but need ${durationMinutes} minutes for observing${preparation ? ` plus ${setupMinutes + packUpMinutes} minutes for setup and packing up` : ""}. Choose a later Home by or fewer observing minutes, and leave time for travel both ways.`,
    };
  if (minutes > 7 * 24 * 60)
    return {
      field: "end",
      message:
        "Available from and Home by can be at most 7 days apart. Choose a shorter date range.",
    };
  return null;
}

export function defaultPlanningWindow(
  windows = [],
  preferences = {},
  now = Date.now(),
) {
  const durationMinutes = 60;
  // A suggested evening, not a promise that the sky, weather or routes will fit.
  const budget = Math.max(
    6 * 60,
    durationMinutes +
      setupMinutes +
      packUpMinutes +
      2 * (preferences.maxTravelMinutes ?? 60) +
      2 * (preferences.maxWalkMinutes ?? 20) +
      20,
  );
  const earliest =
    Math.ceil((now + 15 * minute) / (30 * minute)) * 30 * minute;
  const candidates = windows
    .map((w) => ({
      start: Math.max(+new Date(w.start), earliest),
      end: +new Date(w.end),
    }))
    .filter((w) => w.end > w.start)
    .sort((a, b) => a.start - b.start);
  const suitable = candidates.find(
    (w) => w.end - w.start >= budget * minute && w.end - w.start <= 7 * day,
  );
  if (suitable) return { ...suitable, durationMinutes, adjusted: false };
  if (candidates.length)
    return {
      start: candidates[0].start,
      end: candidates[0].start + budget * minute,
      durationMinutes,
      adjusted: true,
    };
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(17, 0, 0, 0);
  return {
    start: +tomorrow,
    end: +tomorrow + Math.max(9 * 60, budget) * minute,
    durationMinutes,
    adjusted: false,
  };
}
