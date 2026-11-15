import { mkdir, writeFile } from 'node:fs/promises';
import { connectLocal, call } from './mcp-client.js';
import { routeLegSummaries, matrixCell } from '../src/geoapify.js';

if (!process.env.GEOAPIFY_API_KEY) throw new Error('Export GEOAPIFY_API_KEY for the read-only traffic/carpool check.');
const client = await connectLocal({ demo: false });
const calls = [];
const invoke = async (tool, args) => {
  const result = await call(client, tool, args); calls.push({ tool, arguments: args, result }); return result;
};
try {
  const a = { lat: 50.0755, lon: 14.4378 }, b = { lat: 50.078, lon: 14.44 }, site = { lat: 50.064, lon: 14.4184 };
  const models = {};
  for (const traffic of ['free_flow', 'approximated']) {
    const matrix = await invoke('geoapify_call', { tool: 'calculate_route_matrix', arguments: { sources: [a,b,site], targets: [a,b,site], mode: 'drive', units: 'metric', traffic } });
    if (!matrixCell(matrix,0,1) || !matrixCell(matrix,1,2)) throw new Error('Public test pickup is unreachable');
    const route = await invoke('geoapify_call', { tool: 'calculate_route', arguments: { waypoints: [a,b,site], mode: 'drive', units: 'metric', traffic, waypoint_mode: 'stopover', optimize_stops: false, geometry_scope: 'none' } });
    models[traffic] = { minutes: routeLegSummaries(route,2).reduce((sum,leg)=>sum+leg.minutes,0), pickupLegs: route.legs.length };
  }
  const now = new Date(), start = new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),now.getUTCDate()+1,17)), end = new Date(+start+5*3600000);
  const availability = [{ start: new Date(+start-2*3600000).toISOString(), end: new Date(+end+2*3600000).toISOString() }];
  const base = { timezone: 'Europe/Prague', interests: ['Saturn'], maxTravelMinutes: 120, maxWalkMinutes: 30, groupSize: { min: 2, max: 2 }, preference: 'balanced', availability };
  const input = {
    request: { organizerId: 'driver', target: 'Saturn', start: start.toISOString(), end: end.toISOString(), timezone: 'Europe/Prague', durationMinutes: 30, minPeople: 2, maxPeople: 2, needsGuide: true },
    participants: [
      { ...base, id: 'driver', name: 'Synthetic driver', email: 'driver@example.test', origin: a, experience: 'beginner', happyToTeach: false, equipment: [], shareEquipment: false, transport: 'drive', car: { available: true, offerRides: true, passengerSeats: 1, maxDetourMinutes: 30 } },
      { ...base, id: 'rider', name: 'Synthetic telescope owner', email: 'rider@example.test', origin: b, experience: 'experienced', happyToTeach: true, equipment: ['telescope'], shareEquipment: true, transport: 'ride', pickup: { name: 'Public test pickup; not an agreed real meeting', location: b } },
    ],
    sites: [{ id: 'public-test', name: 'Vyšehrad — access unverified', location: site, meetingPoint: site, walkMinutes: 0, access: 'unverified', accessNote: 'Synthetic participant test only; no actual night access or pickup agreement established.', accessWindows: availability, bortle: null, skyQualitySource: null }],
  };
  const plan = await invoke('plan_outing',input);
  if (!['needs_access_check','no_match'].includes(plan.status)) throw new Error('Unverified site must not become an invitation-ready outing');
  if (plan.status === 'needs_access_check' && (plan.carpools.length !== 1 || plan.carpools[0].passengerIds[0] !== 'rider')) throw new Error('Expected one available car carrying the telescope owner');
  const evidence = { provenance: { recordedAt: new Date().toISOString(), mode: 'live-providers-synthetic-participants', coordinates: 'Public Prague test points; no participant home', siteAccess: 'Unverified; no real outing or ride agreement', calendarWrite: false, redaction: 'Synthetic emails removed and credential values excluded' }, checks: { models, planStatus: plan.status, carpoolCount: plan.carpools?.length ?? 0, liveTraffic: false, departureTimePrediction: false }, calls };
  let text = JSON.stringify(evidence, null, 2).replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email redacted]');
  for (const value of [process.env.GEOAPIFY_API_KEY,process.env.OPEN_METEO_API_KEY].filter(Boolean)) text=text.replaceAll(value,'[REDACTED]');
  await mkdir(new URL('../examples/generated',import.meta.url),{recursive:true});
  await writeFile(new URL('../examples/generated/live-transport-trace.json',import.meta.url),text+'\n');
  console.log(JSON.stringify(evidence.checks,null,2));
} finally { await client.close(); }
