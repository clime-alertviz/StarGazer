import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { loadProfiles } from './profiles.js';
import { weatherFields } from './weather.js';

export const demoNow = Date.parse('2026-11-15T12:00:00Z');
export async function demoScenario() {
  const scenario = JSON.parse(await readFile(new URL('../examples/scenario.json', import.meta.url), 'utf8'));
  return { ...scenario, participants: await loadProfiles(fileURLToPath(new URL('../examples/profiles', import.meta.url))) };
}

export function carpoolScenario(scenario) {
  const input = structuredClone(scenario);
  const driver = input.participants.find(p => p.id === 'anna');
  driver.car = { available: true, offerRides: true, passengerSeats: 2, maxDetourMinutes: 25 };
  driver.maxTravelMinutes = 100;
  for (const id of ['petr', 'eva']) {
    const p = input.participants.find(p => p.id === id);
    p.transport = 'ride'; delete p.car;
    p.pickup = { name: id === 'petr' ? 'Demo library entrance' : 'Demo station forecourt', location: { lat: p.origin.lat + 0.001, lon: p.origin.lon } };
  }
  return input;
}

export function demoForecast(location) {
  const ridge = location.lat < 49.95;
  const hours = [];
  for (let hour = 0; hour < 48; hour++) {
    const at = new Date(Date.parse('2026-11-20T00:00:00Z') + hour * 3600000).toISOString();
    hours.push({ at, cloud_cover: ridge ? 12 : 35, cloud_cover_low: 5, cloud_cover_mid: 5, cloud_cover_high: 2,
      precipitation_probability: 5, precipitation: 0, wind_speed_10m: 8, temperature_2m: 4, visibility: 24000 });
  }
  return { source: 'Synthetic Open-Meteo-shaped fixture (not a forecast)', fetchedAt: new Date(demoNow).toISOString(), hours };
}

function minutesFor(a, b, mode, traffic) {
  if (a.lat === b.lat && a.lon === b.lon) return 0;
  const separation = Math.hypot(a.lat - b.lat, a.lon - b.lon);
  if (mode === 'walk') return separation < 0.01 ? Math.max(1, Math.round(separation * 1200)) : 210;
  const isSite = p => p.lat === 49.913 || p.lat === 50.012;
  let minutes;
  if (isSite(a) !== isSite(b)) {
    const site = isSite(a) ? a : b;
    const origin = site === a ? b : a;
    const ridge = site.lat < 49.95;
    minutes = (origin.lat > 50.05 ? (ridge ? 40 : 28) : origin.lat > 50.02 ? (ridge ? 30 : 18) : (ridge ? 20 : 12)) + (site === a ? 2 : 0);
  } else minutes = Math.max(3, Math.round(separation * 140));
  return Math.ceil(minutes * (mode === 'drive' && traffic === 'approximated' ? 1.1 : 1));
}

export function demoGeo(trace = () => {}) {
  return {
    async list() { return { demo: true, tools: ['geocode_address', 'list_place_categories', 'search_places', 'calculate_route_matrix', 'calculate_route'].map(name => ({ name, description: 'Synthetic fixture tool; use live tools/list for upstream schemas.' })) }; },
    async call(name, args) {
      let result;
      if (name === 'calculate_route_matrix') result = {
        sources: args.sources, targets: args.targets, units: 'metric', distance_units: 'meters', time_units: 'seconds',
        sources_to_targets: args.sources.map(a => args.targets.map(b => ({ time: minutesFor(a, b, args.mode, args.traffic) * 60, distance: minutesFor(a, b, args.mode) * 600 }))),
      };
      else if (name === 'calculate_route') {
        const legs = args.waypoints.slice(1).map((b, i) => ({ time: minutesFor(args.waypoints[i], b, args.mode, args.traffic) * 60, distance: minutesFor(args.waypoints[i], b, args.mode) * 600 }));
        result = { time: legs.reduce((sum, leg) => sum + leg.time, 0), distance: legs.reduce((sum, leg) => sum + leg.distance, 0), time_units: 'seconds', distance_units: 'meters', waypoints: args.waypoints, legs };
      } else if (name === 'geocode_address') result = { results: [{ formatted: 'Prague, Czechia (fixture)', lat: 50.0755, lon: 14.4378 }] };
      else if (name === 'list_place_categories') result = { categories: ['tourism.attraction.viewpoint', 'parking'] };
      else if (name === 'search_places') result = { category: args.category, coordinates: { lat: args.lat, lon: args.lon }, count: 1, results: [{ name: 'Demo meeting point (fictional access)', lat: 49.913, lon: 14.699 }] };
      else throw new Error('Unsupported demo tool');
      trace({ provider: 'Geoapify MCP fixture — NO NETWORK', tool: name, arguments: args, result });
      return result;
    },
  };
}

export function demoWeatherResponse(location) {
  const forecast = demoForecast(location);
  return { hourly_units: { cloud_cover: '%', precipitation_probability: '%', precipitation: 'mm', wind_speed_10m: 'km/h', temperature_2m: '°C', visibility: 'm' }, hourly: {
    time: forecast.hours.map(h => Date.parse(h.at) / 1000),
    ...Object.fromEntries(weatherFields.map(k => [k, forecast.hours.map(h => h[k])])),
  } };
}
