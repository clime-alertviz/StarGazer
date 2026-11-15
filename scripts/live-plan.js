import { mkdir, writeFile } from 'node:fs/promises';
import { connectLocal, call } from './mcp-client.js';

if (!process.env.GEOAPIFY_API_KEY) throw new Error('Export GEOAPIFY_API_KEY before this live, read-only test.');
const client = await connectLocal({ demo: false });
const trace = [];
const invoke = async (tool, args = {}) => {
  const result = await call(client, tool, args);
  trace.push({ tool, arguments: args, result });
  return result;
};
try {
  await invoke('get_geoapify_tools');
  const geocoded = await invoke('geoapify_call', { tool: 'geocode_address', arguments: { query: 'Vyšehrad, Prague, Czechia' } });
  // Public coordinates are supplied explicitly; no participant's home is inferred.
  const today = new Date();
  const start = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + 1, 17));
  const end = new Date(+start + 5 * 3600000);
  const available = { start: new Date(+start - 2 * 3600000).toISOString(), end: new Date(+end + 2 * 3600000).toISOString() };
  const scenario = {
    request: { organizerId: 'reviewer', target: 'stargazing', start: start.toISOString(), end: end.toISOString(), timezone: 'Europe/Prague', durationMinutes: 30, minPeople: 1, maxPeople: 1 },
    participants: [{ id: 'reviewer', name: 'Synthetic reviewer', email: 'reviewer@example.test', origin: { lat: 50.0755, lon: 14.4378 }, timezone: 'Europe/Prague', interests: ['stargazing'], experience: 'beginner', happyToTeach: false, equipment: [], shareEquipment: false, transport: 'walk', maxTravelMinutes: 90, maxWalkMinutes: 30, groupSize: { min: 1, max: 1 }, preference: 'balanced', availability: [available] }],
    sites: [{ id: 'vysehrad-candidate', name: 'Vyšehrad — unverified observing candidate', location: { lat: 50.064, lon: 14.4184 }, meetingPoint: { lat: 50.064, lon: 14.4184 }, walkMinutes: 0, access: 'unverified', accessNote: 'Read-only integration test. Night access and a clear horizon have not been checked; this is not a recommendation to visit.', accessWindows: [available], bortle: null, skyQualitySource: null }],
  };
  const plan = await invoke('plan_outing', scenario);
  if (plan.status === 'proposal') throw new Error('Unverified access must never produce an invitation-ready proposal');
  let invitationBlocked = null;
  if (plan.planId) {
    const blocked = await client.callTool({ name: 'prepare_calendar_invitation', arguments: { planId: plan.planId } });
    invitationBlocked = blocked.isError === true;
    trace.push({ tool: 'prepare_calendar_invitation', arguments: { planId: plan.planId }, result: blocked });
    if (!invitationBlocked) throw new Error('Expected invitation preparation to reject unverified access');
  }
  const evidence = { provenance: { recordedAt: new Date().toISOString(), mode: 'live-providers-synthetic-profile', weatherAndJourneys: 'Actual network responses', participant: 'Fictional profile; public starting point, no real recipient', siteAccess: 'Unverified; window is a test assumption, not opening-hours evidence', calendarWrite: false, redaction: 'Credentials excluded; synthetic email redacted' }, calls: trace };
  let serialized = JSON.stringify(evidence, null, 2).replaceAll('reviewer@example.test', '[email redacted]');
  for (const key of [process.env.GEOAPIFY_API_KEY, process.env.OPEN_METEO_API_KEY].filter(Boolean)) serialized = serialized.replaceAll(key, '[REDACTED]');
  await mkdir(new URL('../examples/generated', import.meta.url), { recursive: true });
  await writeFile(new URL('../examples/generated/live-plan-trace.json', import.meta.url), serialized + '\n');
  console.log(JSON.stringify({ status: 'passed', planStatus: plan.status, selectedWindow: plan.observingStart ?? null, invitationBlocked, geocodingReturnedData: Boolean(geocoded), calendarWrite: false }, null, 2));
} finally { await client.close(); }
