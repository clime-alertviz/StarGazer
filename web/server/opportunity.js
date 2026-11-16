import { assessSky } from "../../src/astronomy.js";
import { assessWeather } from "../../src/weather.js";
import { expandSlots } from "./availability.js";
import { setupMinutes, packUpMinutes } from "../../src/timing.js";

// A provisional observing opportunity: no invented driver, route or equipment.
export async function findOpportunity(
  request,
  preferences,
  sites,
  forecast,
  availability,
  { allowWeatherWarning = false } = {},
) {
  const now = Date.now(),
    from = Date.parse(request.start),
    until = Date.parse(request.end);
  if (from < now || until > now + 15 * 86400000)
    throw new Error(
      "Choose a future window ending within the next 15 days.",
    );
  const windows =
    availability ||
    expandSlots(
      preferences.slots,
      preferences.timezone,
      request.start,
      request.end,
    );
  const options = [];
  for (const site of sites.filter((s) => s.access !== "closed")) {
    const skyWindows = [];
    for (
      let start = Math.ceil(from / 1800000) * 1800000;
      start + request.durationMinutes * 60000 <= until;
      start += 1800000
    ) {
      const end = start + request.durationMinutes * 60000;
      // Reserve travel time inside this outing's confirmed availability even
      // when its driver will join later.
      const travelBudget = availability ? preferences.maxTravelMinutes : 0;
      const meet = start - (setupMinutes + site.walkMinutes) * 60000,
        leave = end + (packUpMinutes + site.walkMinutes) * 60000;
      const covers = (w) =>
        Date.parse(w.start) <= meet && Date.parse(w.end) >= leave;
      if (
        !windows.some(
          (w) =>
            Date.parse(w.start) <= meet - travelBudget * 60000 &&
            Date.parse(w.end) >= leave + travelBudget * 60000,
        ) ||
        !site.accessWindows.some(covers)
      )
        continue;
      const astronomy = assessSky(
        site.location,
        start,
        end,
        request.target,
      );
      if (astronomy.suitable) skyWindows.push({ start, end, astronomy });
    }
    if (!skyWindows.length) continue;
    const data = await forecast(site.location),
      fetched = Date.parse(data.fetchedAt);
    if (
      !Number.isFinite(fetched) ||
      Date.now() - fetched > 3600000 ||
      fetched > Date.now() + 60000
    )
      throw new Error(
        "A fresh forecast is needed before creating the outing.",
      );
    for (const candidate of skyWindows) {
      const weather = assessWeather(
        data,
        candidate.start,
        candidate.end,
        request,
      );
      if (weather.suitable || (allowWeatherWarning && !weather.reason && weather.failures?.length))
        options.push({ ...candidate, site, weather });
    }
  }
  options.sort(
    (a, b) =>
      Number(b.weather.suitable) - Number(a.weather.suitable) ||
      a.weather.maxCloudCover - b.weather.maxCloudCover ||
      a.start - b.start,
  );
  return options[0] || null;
}
