import { routeSummary } from "../../src/geoapify.js";

const active = (p) =>
  !["declined", "expired", "withdrawn"].includes(p.response);
export const trafficDescription =
  "Geoapify approximated traffic compared with free-flow driving. These are general estimates, not live congestion or a forecast for your departure time. Pickup stops are included; waiting and safety buffers are excluded.";

// Coordinates stay on the server. Cache by the complete route, not merely the
// outing id: a changed driver or pickup must invalidate the comparison.
export class Traffic {
  constructor(geo) {
    this.geo = geo;
    this.cache = new Map();
  }
  async report(o) {
    const drivers = o.people.filter(
      (p) => active(p) && p.transport === "drive" && !p.selfArranged,
    );
    if (!drivers.length || o.kind === "connection_test") return null;
    const paths = drivers.map((p) => {
      const car = o.carpools?.find((c) => c.driverId === p.userId);
      const pickups = (car?.pickups || []).filter((stop) =>
        o.people.some(
          (person) => person.userId === stop.participantId && active(person),
        ),
      );
      const outward = [
        p.preferences.origin.location,
        ...pickups.map((s) => s.pickup.location),
        o.site.meetingPoint,
      ];
      return {
        driverId: p.userId,
        name: p.preferences.name,
        outward,
        homeward: [...outward].reverse(),
      };
    });
    const key = JSON.stringify(paths),
      now = Date.now();
    if (this.cache.get(key)?.until > now) return this.cache.get(key).promise;
    const entry = { until: now + 15 * 60000 };
    entry.promise = Promise.all(
      paths.map(async (path) => {
        const estimate = async (points, traffic) => {
          const waypoints = points.filter(
            (p, i) =>
              !i || p.lat !== points[i - 1].lat || p.lon !== points[i - 1].lon,
          );
          if (waypoints.length < 2) return { minutes: 0, distanceMeters: 0 };
          return routeSummary(
            await this.geo.call("calculate_route", {
              waypoints,
              mode: "drive",
              units: "metric",
              geometry_scope: "none",
              waypoint_mode: "stopover",
              optimize_stops: false,
              include_instructions: false,
              traffic,
            }),
          );
        };
        const values = await Promise.allSettled([
          estimate(path.outward, "approximated"),
          estimate(path.outward, "free_flow"),
          estimate(path.homeward, "approximated"),
          estimate(path.homeward, "free_flow"),
        ]);
        const direction = (offset) => {
          const approx = values[offset],
            free = values[offset + 1];
          return {
            minutes:
              approx.status === "fulfilled" ? approx.value.minutes : null,
            freeFlowMinutes:
              free.status === "fulfilled" ? free.value.minutes : null,
            differenceMinutes:
              approx.status === "fulfilled" && free.status === "fulfilled"
                ? approx.value.minutes - free.value.minutes
                : null,
          };
        };
        return {
          driverId: path.driverId,
          name: path.name,
          outward: direction(0),
          homeward: direction(2),
          unavailable: values.some((v) => v.status === "rejected"),
        };
      }),
    ).then((drivers) => {
      if (drivers.some((d) => d.unavailable)) entry.until = Date.now() + 30000;
      return {
        provider: "Geoapify MCP",
        model: "approximated",
        checkedAt: new Date().toISOString(),
        description: trafficDescription,
        drivers,
      };
    });
    this.cache.set(key, entry);
    if (this.cache.size > 100)
      this.cache.delete(this.cache.keys().next().value);
    return entry.promise;
  }
}
