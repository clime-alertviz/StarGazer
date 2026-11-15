import { mkdir, writeFile } from 'node:fs/promises';
import { Geoapify, matrixCell, routeSummary } from '../src/geoapify.js';
import { fetchForecast } from '../src/weather.js';
import { skyAt } from '../src/astronomy.js';
import { connectLocal, call } from './mcp-client.js';

const report = { checkedAt: new Date().toISOString(), checks: [], calendar: 'NOT RUN BY THIS SCRIPT: Calendar write tests use the connected plugin and are recorded separately.' };
let failures = 0;
try {
  const f = await fetchForecast({ lat: 50.0755, lon: 14.4378 });
  report.checks.push({ service: 'Open-Meteo', status: 'passed', hourlyRecords: f.hours.length, fetchedAt: f.fetchedAt, missingCloudHours: f.hours.filter(h => h.cloud_cover === null).length });
} catch (error) { failures++; report.checks.push({ service: 'Open-Meteo', status: 'failed', reason: error.message }); }
report.checks.push({ service: 'Astronomy Engine', status: 'passed', sample: skyAt({ lat: 50.0755, lon: 14.4378 }, Date.now(), 'Saturn') });
const client = await connectLocal({ demo: false });
try {
  const today = new Date();
  const start = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + 1, 19));
  const args = { location: { lat: 50.0755, lon: 14.4378 }, start: start.toISOString(), end: new Date(+start + 3600000).toISOString(), target: 'Saturn' };
  const result = await call(client, 'get_observing_conditions', args);
  const evidence = { provenance: { recordedAt: new Date().toISOString(), mode: 'live-read-only', coordinates: 'Public central Prague coordinate; not a participant home or approved observing site', weather: 'Actual Open-Meteo response', astronomy: 'Actual Astronomy Engine calculation', redaction: 'No credentials, personal profiles or attendee addresses were collected', calendarWrite: false }, calls: [{ tool: 'get_observing_conditions', arguments: args, result }] };
  await mkdir(new URL('../examples/generated', import.meta.url), { recursive: true });
  await writeFile(new URL('../examples/generated/live-weather-trace.json', import.meta.url), JSON.stringify(evidence, null, 2) + '\n');
  report.checks.push({ service: 'Live local MCP conditions tool', status: 'passed', weatherSuitable: result.weather.suitable, skySuitable: result.astronomy.suitable });
} catch (error) { failures++; report.checks.push({ service: 'Live local MCP conditions tool', status: 'failed', reason: error.message }); }
finally { await client.close(); }
if (!process.env.GEOAPIFY_API_KEY) report.checks.push({ service: 'Geoapify MCP', status: 'not_run', reason: 'GEOAPIFY_API_KEY is not set' });
else {
  try {
    const trace = [];
    const geo = new Geoapify({ trace: entry => trace.push(entry) });
    const list = await geo.list();
    trace.push({ provider: 'Geoapify MCP', method: 'tools/list', result: list });
    const required = ['geocode_address', 'list_place_categories', 'search_places', 'calculate_route_matrix', 'calculate_route'];
    if (required.some(name => !list.tools.some(t => t.name === name))) throw new Error('A required upstream MCP tool is missing');
    const result = await geo.call('geocode_address', { query: 'Prague, Czechia' });
    await geo.call('list_place_categories', {});
    const a = { lat: 50.0755, lon: 14.4378 }, b = { lat: 50.078, lon: 14.44 };
    await geo.call('search_places', { category: 'parking', lat: a.lat, lon: a.lon, radius_meters: 1000, limit: 1 });
    const matrix = await geo.call('calculate_route_matrix', { sources: [a], targets: [b], mode: 'walk', units: 'metric' });
    const route = await geo.call('calculate_route', { waypoints: [a, b], mode: 'walk', units: 'metric', geometry_scope: 'none' });
    const cell = matrixCell(matrix, 0, 0);
    if (!cell || cell.minutes <= 0) throw new Error('Expected a reachable walking journey between the two public test coordinates');
    const detailed = routeSummary(route);
    if (detailed.minutes <= 0) throw new Error('Expected a positive detailed walking time');
    const evidence = { provenance: { recordedAt: new Date().toISOString(), mode: 'live-read-only', provider: 'Authenticated Geoapify MCP', locations: 'Public central Prague coordinates; no private participant origins', redaction: 'Request headers are excluded; configured key values are removed from all strings' }, calls: trace };
    let text = JSON.stringify(evidence, null, 2);
    for (const key of [process.env.GEOAPIFY_API_KEY, process.env.OPEN_METEO_API_KEY].filter(Boolean)) text = text.replaceAll(key, '[REDACTED]');
    await writeFile(new URL('../examples/generated/live-geoapify-trace.json', import.meta.url), text + '\n');
    report.checks.push({ service: 'Geoapify MCP', status: 'passed', toolNames: list.tools.map(t => t.name), geocodingReturnedData: Boolean(result), matrixTimeUnits: matrix.time_units, routeTimeUnits: route.time_units, matrixMinutes: cell.minutes, detailedRouteMinutes: detailed.minutes });
  } catch (error) { failures++; report.checks.push({ service: 'Geoapify MCP', status: 'failed', reason: error.message }); }
}
await mkdir(new URL('../output', import.meta.url), { recursive: true });
await writeFile(new URL('../output/live-checks.json', import.meta.url), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
process.exitCode = failures ? 1 : 0;
