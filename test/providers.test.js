import test from 'node:test';
import assert from 'node:assert/strict';
import { Geoapify, matrixCell } from '../src/geoapify.js';
import { fetchForecast } from '../src/weather.js';
import { demoWeatherResponse, demoNow } from '../src/demo-data.js';

test('Geoapify uses MCP tools/call and an environment-supplied header, never a REST route URL', async () => {
  const requests = [];
  const geo = new Geoapify({ apiKey: 'test-secret', fetchImpl: async (url, options) => {
    requests.push({ url, options });
    return Response.json({ jsonrpc: '2.0', id: 1, result: { structuredContent: { sources_to_targets: [[{ time: 120, distance: 500 }]], time_units: 'seconds', distance_units: 'meters' } } });
  } });
  const matrix = await geo.call('calculate_route_matrix', { sources: [{ lat: 50, lon: 14 }], mode: 'drive' });
  assert.equal(matrixCell(matrix, 0, 0).minutes, 2);
  assert.equal(requests[0].url, 'https://api.geoapify.com/v1/mcp');
  assert.equal(requests[0].options.headers['x-api-key'], 'test-secret');
  const body = JSON.parse(requests[0].options.body);
  assert.equal(body.method, 'tools/call'); assert.equal(body.params.name, 'calculate_route_matrix');
  assert.ok(!requests[0].options.body.includes('test-secret'));
});

test('provider errors do not echo upstream bodies, credential URLs or secrets', async () => {
  const geo = new Geoapify({ apiKey: 'secret', fetchImpl: async () => new Response('secret', { status: 401 }) });
  await assert.rejects(geo.list(), e => e.message.includes('401') && !e.message.includes('secret'));
  const offline = new Geoapify({ apiKey: 'secret', fetchImpl: async () => { throw new Error('secret'); } });
  await assert.rejects(offline.list(), e => !e.message.includes('secret'));
  await assert.rejects(new Geoapify({ apiKey: '' }).list(), /GEOAPIFY_API_KEY is missing/);
  const malformed = new Geoapify({ apiKey: 'secret', fetchImpl: async () => new Response('secret is not JSON') });
  await assert.rejects(malformed.list(), e => e.message.includes('invalid JSON') && !e.message.includes('secret'));
});

test('MCP text JSON fallback is accepted, error results and unexpected units are rejected', async () => {
  const geo = new Geoapify({ apiKey: 'test', fetchImpl: async () => Response.json({ result: { content: [{ type: 'text', text: '{"ok":true}' }] } }) });
  assert.deepEqual(await geo.call('geocode_address', { query: 'Prague' }), { ok: true });
  const bad = new Geoapify({ apiKey: 'test', fetchImpl: async () => Response.json({ result: { isError: true, content: [{ type: 'text', text: 'secret' }] } }) });
  await assert.rejects(bad.call('geocode_address', {}), /could not complete this location request/);
  assert.throws(() => matrixCell({ time_units: 'minutes' }, 0, 0), /seconds and meters/);
});

test('route matrix distance limits explain the location conflict without exposing upstream secrets', async () => {
  const message = 'Route Matrix API request failed: Too long distance between locations. Distance should not exceed 100000 meters. https://example.test/?apiKey=secret';
  for (const body of [
    { result: { isError: true, content: [{ type: 'text', text: JSON.stringify({ statusCode: 400, message }) }] } },
    { error: { code: -32603, message } },
  ]) {
    const geo = new Geoapify({ apiKey: 'secret', fetchImpl: async () => Response.json(body) });
    await assert.rejects(geo.call('calculate_route_matrix', {}), error => {
      assert.match(error.message, /locations are too far apart/);
      assert.match(error.message, /starting points/);
      assert.doesNotMatch(error.message, /secret|apiKey|example\.test|get_geoapify_tools/);
      return true;
    });
  }
});

test('Open-Meteo requests explicit units and parses epoch seconds in UTC', async () => {
  let called;
  const forecast = await fetchForecast({ lat: 50, lon: 14 }, { now: demoNow, fetchImpl: async url => { called = url; return Response.json(demoWeatherResponse({ lat: 50 })); } });
  assert.equal(called.searchParams.get('timeformat'), 'unixtime');
  assert.equal(called.searchParams.get('wind_speed_unit'), 'kmh');
  assert.equal(forecast.hours[0].at, '2026-11-20T00:00:00.000Z');
  assert.equal(forecast.hours[0].temperature_2m, 4);
  const missing = demoWeatherResponse({ lat: 50 }); missing.hourly.visibility[0] = null;
  const parsed = await fetchForecast({ lat: 50, lon: 14 }, { fetchImpl: async () => Response.json(missing) });
  assert.equal(parsed.hours[0].visibility, null);
});

test('paid weather key selects customer endpoint but HTTP errors never expose it', async () => {
  const fetchImpl = async url => {
    assert.equal(url.hostname, 'customer-api.open-meteo.com'); assert.equal(url.searchParams.get('apikey'), 'secret');
    return new Response('secret', { status: 403 });
  };
  await assert.rejects(fetchForecast({ lat: 50, lon: 14 }, { apiKey: 'secret', fetchImpl }), e => e.message.includes('403') && !e.message.includes('secret'));
});
