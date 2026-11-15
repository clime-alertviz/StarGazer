import { planOuting } from "../../../src/planner.js";
import { plannerPerson } from "../availability.js";
import { findOpportunity } from "../opportunity.js";

export async function discoverSites({ data, user, geo }) {
  // Strip UI-only keys before validating the strict planning schema.
  let sites = data.site ? [data.site] : [];
  if (!sites.length) {
    const origin = user.preferences.origin.location;
    const categories = await geo.call("list_place_categories", {});
    if (!categories.categories?.includes("tourism.attraction.viewpoint"))
      throw new Error(
        "The place provider does not advertise viewpoint search. Choose an observing site explicitly.",
      );
    const found = await geo.call("search_places", {
      category: "tourism.attraction.viewpoint",
      ...origin,
      radius_meters: Math.min(
        50000,
        user.preferences.maxTravelMinutes * 600,
      ),
      limit: 4,
    });
    sites = (found.features || found.results || found.places || []).map(
      (item, i) => {
        const p = item.properties || item,
          coords = {
            lat: p.lat ?? item.geometry?.coordinates[1],
            lon: p.lon ?? item.geometry?.coordinates[0],
          };
        return {
          id: `spot-${i}`,
          name: p.name || p.formatted || "Viewpoint",
          location: coords,
          meetingPoint: coords,
          walkMinutes: 10,
          access: "unverified",
          accessNote:
            "Confirm night access, parking and final walk before inviting.",
          accessWindows: [
            {
              start: new Date(
                Date.parse(data.start) - 86400000,
              ).toISOString(),
              end: new Date(Date.parse(data.end) + 86400000).toISOString(),
            },
          ],
          bortle: null,
          skyQualitySource: null,
        };
      },
    );
    if (!sites.length)
      throw new Error(
        "No viewpoints found. Choose a public observing site.",
      );
  }

  return sites;
}

export async function solveDeterministically(context) {
  const {
    data,
    user,
    users,
    request,
    id,
    availability,
    geo,
    forecast: fetchForecast,
    routesFor,
  } = context;
  const sites = context.sites || (await discoverSites(context));
  let result;
  const seenVariants = new Set(),
    forecasts = new Map();
  const forecast = (point) => {
    const key = JSON.stringify(point);
    if (!forecasts.has(key)) forecasts.set(key, fetchForecast(point));
    return forecasts.get(key);
  };
  const attempts =
    request.minPeople > 1 && data.visibility === "open" ? 8 : 4;
  // Prefer each person's first travel choice, then try a shared drive/lift alternative.
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt === 4) request.minPeople = 1;
    const participants = users
      .map((u, index) => ({
        ...plannerPerson(
          u,
          u.preferences,
          u.preferences.travel[
            ((attempt % 4) + index * (attempt % 4 === 0 ? 0 : 1)) %
              u.preferences.travel.length
          ],
          data.start,
          data.end,
          data.target,
        ),
        ...(u.id === id ? { availability } : {}),
      }))
      .filter((p) => p.availability.length);
    if (!participants.some((p) => p.id === id))
      throw new Error(
        "None of your saved availability slots covers this search.",
      );
    const variantKey = JSON.stringify([
      request.minPeople,
      participants.map((p) => [p.id, p.transport]),
    ]);
    if (seenVariants.has(variantKey)) continue;
    seenVariants.add(variantKey);
    result = await planOuting(
      { request, participants, sites },
      { geo: geo, forecast },
    );
    if (result.status !== "no_match") break;
  }
  if (result.status === "no_match" && data.visibility === "open") {
    const opportunity = await findOpportunity(
      request,
      user.preferences,
      sites,
      forecast,
      availability,
    );
    if (opportunity) {
      const provisional = {
        start: new Date(opportunity.start).toISOString(),
        end: new Date(opportunity.end).toISOString(),
        site: opportunity.site,
        target: data.target,
        limits: request,
        visibility: "open",
      };
      const member = {
        userId: id,
        preferences: user.preferences,
        availability,
      };
      const travel = await routesFor(provisional, [member], {
        allowPending: true,
      });
      if (travel.pendingTransport.length && data.maxPeople < 2)
        throw new Error(
          "Leave at least one place for a driver, or arrange your own transport.",
        );
      result = {
        status: "needs_access_check",
        observingStart: provisional.start,
        observingEnd: provisional.end,
        site: opportunity.site,
        astronomy: opportunity.astronomy,
        weather: opportunity.weather,
        participants: [{ id, transport: travel.modes[id] }],
        equipment: [],
        ...travel,
      };
    }
  }

  return result;
}
