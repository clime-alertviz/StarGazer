import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectLocal, call } from './mcp-client.js';
import { carpoolScenario } from '../src/demo-data.js';

const out = fileURLToPath(new URL('../examples/generated', import.meta.url));
await mkdir(out, { recursive: true });
const client = await connectLocal();
const trace = [];
async function invoke(name, args = {}) {
  const result = await call(client, name, args);
  trace.push({ tool: name, arguments: args, result });
  return result;
}
try {
  const list = await client.listTools();
  trace.push({ method: 'tools/list', result: list.tools.map(t => ({ name: t.name, description: t.description })) });
  await invoke('get_geoapify_tools');
  await invoke('geoapify_call', { tool: 'geocode_address', arguments: { query: 'Prague, Czechia' } });
  await invoke('geoapify_call', { tool: 'list_place_categories', arguments: {} });
  await invoke('geoapify_call', { tool: 'search_places', arguments: { category: 'tourism.attraction.viewpoint', lat: 50.0755, lon: 14.4378, radius_meters: 50000, limit: 5 } });
  const scenario = await invoke('load_demo_scenario');
  await invoke('load_profiles');
  const plan = await invoke('plan_outing', scenario);
  if (plan.status !== 'proposal') throw new Error('Demo did not produce the expected proposal');
  const invitation = await invoke('prepare_calendar_invitation', { planId: plan.planId });
  const shortest = structuredClone(scenario);
  shortest.participants.forEach(p => { p.preference = 'shortest_journey'; });
  const nearby = await invoke('plan_outing', shortest);
  const noTelescope = structuredClone(scenario);
  noTelescope.participants.forEach(p => { p.shareEquipment = false; });
  const rejected = await invoke('plan_outing', noTelescope);
  const sharedInput = carpoolScenario(scenario);
  const shared = await invoke('plan_outing', sharedInput);
  if (shared.status !== 'proposal' || shared.carpools.length !== 1) throw new Error('Carpool demo did not produce the expected shared ride');
  const sharedInvitation = await invoke('prepare_calendar_invitation', { planId: shared.planId });
  const noSeats = structuredClone(sharedInput);
  noSeats.participants.find(p => p.id === 'anna').car.passengerSeats = 1;
  const rejectedRide = await invoke('plan_outing', noSeats);
  const summary = {
    label: 'OFFLINE DEMO — not a real forecast or invitation',
    recordedAt: new Date().toISOString(),
    selectedSite: plan.site.name, selectedPeople: plan.participants.map(p => p.name),
    observingStart: plan.observingStart, observingEnd: plan.observingEnd,
    timezone: plan.request.timezone, meetingStart: plan.meetingStart, meetingEnd: plan.meetingEnd,
    cloudCover: plan.weather.maxCloudCover, targetAltitude: Math.floor(plan.astronomy.minTargetAltitude),
    equipment: plan.equipment, routes: plan.routes, invitationStatus: invitation.status,
    shortestJourneySite: nearby.site.name, noSharedTelescope: rejected.status,
    carpools: shared.carpools, carpoolSite: shared.site.name, carpoolTraffic: shared.traffic, insufficientSeats: rejectedRide.status,
  };
  const redact = (_key, value) => typeof value === 'string' ? value.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email redacted]') : value;
  const provenance = { recordedAt: summary.recordedAt, mode: 'offline-fixture', network: 'none', astronomy: 'Astronomy Engine 2.1.19 — real calculations', weather: 'synthetic', geoapify: 'synthetic responses; actual stdio MCP calls to the local server', calendar: 'payload only; no Google Calendar write', redaction: 'Email addresses removed; remaining names and coordinates are fictional/public fixture data.' };
  for (const [name, data] of [['plan.json', plan], ['calendar-draft.json', invitation], ['carpool-plan.json', shared], ['carpool-calendar-draft.json', sharedInvitation], ['demo-summary.json', summary], ['trace.json', { provenance, calls: trace }]]) {
    await writeFile(join(out, name), JSON.stringify(data, name === 'trace.json' ? redact : null, 2) + '\n');
  }
  console.log('Star Gazer · offline MCP demo');
  console.log(`People: ${summary.selectedPeople.join(', ')}`);
  const local = at => new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: summary.timezone }).format(new Date(at));
  console.log(`Observe: ${local(plan.observingStart)}–${local(plan.observingEnd)} (${summary.timezone})`);
  console.log(`Site: ${summary.selectedSite}`);
  console.log(`Equipment: ${summary.equipment[0]}`);
  console.log(`Shortest journey chooses: ${summary.shortestJourneySite}`);
  console.log(`No shared telescope: ${summary.noSharedTelescope}`);
  console.log(`Carpool: ${shared.carpools[0].driverName} drives ${shared.carpools[0].pickups.map(p => p.name).join(', ')}; ${shared.traffic.model} traffic + ${shared.traffic.drivingBufferMinutes} min buffer each way.`);
  console.log(`Insufficient passenger seats: ${rejectedRide.status}`);
  console.log('Calendar: draft prepared; no invitation sent.');
  console.log(`Evidence: ${out}`);
} finally { await client.close(); }
