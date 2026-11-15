import { setupMinutes, packUpMinutes } from './timing.js';
import { matrixCell, navigationLink, routeLegSummaries } from './geoapify.js';

const key = p => `${p.lat},${p.lon}`;
const legKey = (mode, a, b) => `${mode}:${key(a)}>${key(b)}`;
const unique = points => [...new Map(points.map(p => [key(p), p])).values()];
const zero = () => ({ minutes: 0, distanceMeters: 0 });
const sum = legs => legs.reduce((s, leg) => ({ minutes: s.minutes + leg.minutes, distanceMeters: s.distanceMeters + leg.distanceMeters }), zero());
const plus = (leg, minutes) => ({ ...leg, minutes: leg.minutes + minutes });
function* permutations(items) {
  if (!items.length) { yield []; return; }
  for (let i = 0; i < items.length; i++) for (const rest of permutations(items.filter((_, j) => i !== j))) yield [items[i], ...rest];
}
const covered = (windows, start, end) => windows.some(w => Date.parse(w.start) <= start && Date.parse(w.end) >= end);

export function journeyFits(p, journey, site, start, end) {
  if (!journey) return false;
  return Math.max(journey.outbound.minutes, journey.return.minutes) + site.walkMinutes <= p.maxTravelMinutes &&
    Math.max(journey.walkOutMinutes, journey.walkBackMinutes) + site.walkMinutes <= p.maxWalkMinutes &&
    covered(p.availability,
      start - (journey.outbound.minutes + site.walkMinutes + setupMinutes) * 60000,
      end + (journey.return.minutes + site.walkMinutes + packUpMinutes) * 60000);
}

// Every rider travels with the same consenting driver both ways. Return stops
// reverse the pickup order. Enumerating small groups avoids greedy seat matching.
function* layoutsFor(group, site, getLeg) {
  const drivers = group.filter(p => p.transport === 'drive');
  if (drivers.some(p => !p.car.available)) return;
  const riders = group.filter(p => p.transport === 'ride');
  const choices = drivers.map(driver => riders.map(rider => {
    // Only explicitly supplied public points are shared. Never turn a private
    // origin into a pickup just because the rider omitted their preference.
    if (rider.requiredDriverId && rider.requiredDriverId !== driver.id) return [];
    const points = rider.fixedPickup ? [rider.pickup] : [...(driver.car.pickupPoints ?? []), ...(rider.pickup ? [rider.pickup] : [])];
    return [...new Map(points.map(p => [key(p.location), p])).values()].filter(p => {
      const out = getLeg('walk', rider.origin, p.location), back = getLeg('walk', p.location, rider.origin);
      return out && back && Math.max(out.minutes, back.minutes) + site.walkMinutes <= rider.maxWalkMinutes;
    });
  }));
  function* assign(index, assignments) {
    if (index === riders.length) {
      function* combine(di, layout) {
        if (di === drivers.length) { yield layout; return; }
        for (const ordered of permutations(assignments[di])) yield* combine(di + 1, [...layout, { driver: drivers[di], riders: ordered }]);
      }
      yield* combine(0, []);
      return;
    }
    for (const [di, driver] of drivers.entries()) {
      if (driver.car.offerRides && assignments[di].length < driver.car.passengerSeats) {
        for (const pickup of choices[di][index]) {
          assignments[di].push({ ...riders[index], pickup });
          yield* assign(index + 1, assignments);
          assignments[di].pop();
        }
      }
    }
  }
  yield* assign(0, drivers.map(() => []));
}

function buildOption(group, site, layout, request, getLeg, reject = () => {}) {
  const journeys = {}, carpools = [], paths = [];
  const assignedRiders = layout.flatMap(car => car.riders);
  const pair = (mode, a, b) => [getLeg(mode, a, b), getLeg(mode, b, a)];
  for (const p of [...group.filter(p => ['walk', 'bicycle'].includes(p.transport)), ...assignedRiders]) {
    const mode = p.transport === 'ride' ? 'walk' : p.transport;
    const destination = p.transport === 'ride' ? p.pickup.location : site.meetingPoint;
    const [outbound, back] = pair(mode, p.origin, destination);
    if (!outbound || !back) return null;
    journeys[p.id] = { outbound, return: back, walkOutMinutes: mode === 'walk' ? outbound.minutes : 0, walkBackMinutes: mode === 'walk' ? back.minutes : 0 };
    paths.push({ mode, points: [p.origin, destination] }, { mode, points: [destination, p.origin] });
  }
  for (const { driver, riders } of layout) {
    const points = [driver.origin, ...riders.map(p => p.pickup.location), site.meetingPoint];
    const reverse = [...points].reverse();
    const out = points.slice(1).map((p, i) => getLeg('drive', points[i], p));
    const back = reverse.slice(1).map((p, i) => getLeg('drive', reverse[i], p));
    const [directOut, directBack] = pair('drive', driver.origin, site.meetingPoint);
    if (!directOut || !directBack || [...out, ...back].some(p => !p)) return null;
    const dwell = riders.length * request.pickupStopMinutes;
    const detourOut = Math.max(0, sum(out).minutes + dwell - directOut.minutes);
    const detourBack = Math.max(0, sum(back).minutes + dwell - directBack.minutes);
    if (Math.max(detourOut, detourBack) > driver.car.maxDetourMinutes) { reject({ participantId: driver.id, kind: 'detour', minutes: Math.ceil(Math.max(detourOut, detourBack)), limit: driver.car.maxDetourMinutes }); return null; }
    const buffer = request.drivingBufferMinutes;
    journeys[driver.id] = { outbound: plus(sum(out), dwell + buffer), return: plus(sum(back), dwell + buffer), walkOutMinutes: 0, walkBackMinutes: 0 };
    paths.push({ mode: 'drive', points }, { mode: 'drive', points: reverse });
    if (riders.length) paths.push({ mode: 'drive', points: [driver.origin, site.meetingPoint] }, { mode: 'drive', points: [site.meetingPoint, driver.origin] });
    const pickups = riders.map((rider, i) => {
      const walking = journeys[rider.id];
      // Outbound buffer is after the last pickup; return buffer is before the
      // first drop-off, so every occupant's availability includes the allowance.
      const remaining = plus(sum(out.slice(i + 1)), (riders.length - i) * request.pickupStopMinutes + buffer);
      const returnIndex = riders.length - 1 - i;
      const untilDrop = plus(sum(back.slice(0, returnIndex + 1)), returnIndex * request.pickupStopMinutes + buffer);
      journeys[rider.id] = { outbound: sum([walking.outbound, remaining]), return: sum([untilDrop, walking.return]), walkOutMinutes: walking.outbound.minutes, walkBackMinutes: walking.return.minutes, driverId: driver.id };
      return { participantId: rider.id, name: rider.name, pickup: rider.pickup, beforeMeetingMinutes: remaining.minutes, afterMeetingMinutes: untilDrop.minutes };
    });
    if (riders.length) carpools.push({ driverId: driver.id, driverName: driver.name, passengerIds: riders.map(p => p.id), passengerSeats: driver.car.passengerSeats, detourOutMinutes: detourOut, detourBackMinutes: detourBack, pickups });
  }
  // Prune time-independent constraints before checking every observing window.
  let rejected = false;
  for (const p of group) {
    const j = journeys[p.id];
    if (!j) { rejected = true; continue; }
    const travel = Math.max(j.outbound.minutes, j.return.minutes) + site.walkMinutes;
    const walk = Math.max(j.walkOutMinutes, j.walkBackMinutes) + site.walkMinutes;
    if (travel > p.maxTravelMinutes) { reject({ participantId: p.id, kind: 'journey', minutes: Math.ceil(travel), limit: p.maxTravelMinutes }); rejected = true; }
    if (walk > p.maxWalkMinutes) { reject({ participantId: p.id, kind: 'walking', minutes: Math.ceil(walk), limit: p.maxWalkMinutes }); rejected = true; }
  }
  if (rejected) return null;
  const pickupPreferenceMisses = layout.reduce((total, { driver, riders }) => total + riders.filter(rider =>
    driver.car.pickupPoints?.length && !driver.car.pickupPoints.some(p => key(p.location) === key(rider.pickup.location))).length, 0);
  return { layout, journeys, carpools, paths, pickupPreferenceMisses };
}

export async function createTransport(people, sites, request, geo) {
  const matrices = new Map(), cache = new Map(), optionsCache = new Map(), failures = [];
  const reject = failure => { if (failures.length < 100) failures.push(failure); };
  const meetings = sites.map(s => s.meetingPoint);
  const drivers = people.filter(p => p.transport === 'drive' && p.car.available);
  const riders = people.filter(p => p.transport === 'ride');
  const pickups = [...drivers.flatMap(p => p.car.pickupPoints ?? []), ...riders.flatMap(p => p.pickup ? [p.pickup] : [])].map(p => p.location);
  const modePoints = {
    drive: drivers.length ? [...drivers.map(p => p.origin), ...pickups, ...meetings] : [],
    walk: people.some(p => p.transport === 'walk') || riders.length ? [...people.filter(p => p.transport === 'walk').map(p => p.origin), ...riders.map(p => p.origin), ...pickups, ...meetings] : [],
    bicycle: people.some(p => p.transport === 'bicycle') ? [...people.filter(p => p.transport === 'bicycle').map(p => p.origin), ...meetings] : [],
  };
  for (const [mode, rawPoints] of Object.entries(modePoints)) {
    const points = unique(rawPoints);
    if (!points.length) continue;
    const result = await geo.call('calculate_route_matrix', { sources: points, targets: points, mode, units: 'metric', ...(mode === 'drive' ? { traffic: request.trafficModel } : {}) });
    points.forEach((a, i) => points.forEach((b, j) => matrices.set(legKey(mode, a, b), matrixCell(result, i, j))));
  }
  const matrixLeg = (mode, a, b) => key(a) === key(b) ? zero() : matrices.get(legKey(mode, a, b)) ?? null;
  const detailPath = async ({ mode, points }) => {
    // Co-located stops still need dwell but do not need a zero-distance API call.
    const clean = points.filter((p, i) => i === 0 || key(p) !== key(points[i - 1]));
    if (clean.length < 2) return new Map();
    const id = JSON.stringify([mode, clean]);
    if (!cache.has(id)) cache.set(id, (async () => {
      const data = await geo.call('calculate_route', { waypoints: clean, mode, units: 'metric', geometry_scope: 'none', include_instructions: true, waypoint_mode: 'stopover', optimize_stops: false, ...(mode === 'drive' ? { traffic: request.trafficModel } : {}) });
      const legs = routeLegSummaries(data, clean.length - 1);
      return new Map(legs.map((leg, i) => {
        const estimate = matrixLeg(mode, clean[i], clean[i + 1]);
        return [legKey(mode, clean[i], clean[i + 1]), { ...leg, minutes: Math.max(leg.minutes, estimate?.minutes ?? 0) }];
      }));
    })());
    return cache.get(id);
  };
  return {
    failures,
    options(group, site) {
      const id = `${group.map(p => p.id).join(',')}/${site.id}`;
      if (!optionsCache.has(id)) {
        const options = [];
        let checked = 0;
        for (const layout of layoutsFor(group, site, matrixLeg)) {
          if (++checked > 20000) throw new Error('Too many pickup combinations. Select fewer participants or fewer preferred pickup points and try again.');
          const option = buildOption(group, site, layout, request, matrixLeg, reject);
          if (option) options.push(option);
        }
        optionsCache.set(id, options);
      }
      return optionsCache.get(id);
    },
    async validate(option, group, site) {
      const details = new Map();
      for (const path of option.paths) for (const [id, leg] of await detailPath(path)) {
        const previous = details.get(id);
        if (!previous || leg.minutes > previous.minutes) details.set(id, leg);
      }
      return buildOption(group, site, option.layout, request, (mode, a, b) => key(a) === key(b) ? zero() : details.get(legKey(mode, a, b)) ?? null, reject);
    },
  };
}

export function describeTransport(option, group, site, start, end) {
  const meeting = start - (setupMinutes + site.walkMinutes) * 60000, leaving = end + (packUpMinutes + site.walkMinutes) * 60000;
  const pickupsByRider = new Map(option.carpools.flatMap(car => car.pickups).map(p => [p.participantId, p.pickup]));
  const routes = group.map(p => ({ participantId: p.id, name: p.name, mode: p.transport, ...option.journeys[p.id],
    departAt: new Date(meeting - option.journeys[p.id].outbound.minutes * 60000).toISOString(),
    homeBy: new Date(leaving + option.journeys[p.id].return.minutes * 60000).toISOString(),
    navigationUrl: navigationLink(site, p.transport),
    ...(p.transport === 'ride' ? { pickupNavigationUrl: navigationLink({ meetingPoint: pickupsByRider.get(p.id).location }, 'walk') } : {}),
  }));
  const carpools = option.carpools.map(car => {
    const pickups = car.pickups.map(p => ({ participantId: p.participantId, name: p.name, pickup: p.pickup, pickupAt: new Date(meeting - p.beforeMeetingMinutes * 60000).toISOString(), dropoffAt: new Date(leaving + p.afterMeetingMinutes * 60000).toISOString() }));
    const points = pickups.map(p => p.pickup.location);
    const back = new URL(navigationLink({ meetingPoint: points[0] }, 'drive', [...points].reverse().slice(0, -1)));
    back.searchParams.set('origin', key(site.meetingPoint));
    return { ...car, pickups, outboundNavigationUrl: navigationLink(site, 'drive', points), returnNavigationUrl: back.href, returnOrder: [...car.passengerIds].reverse(), status: 'proposed_confirm_with_driver_and_riders' };
  });
  return { routes, carpools };
}
