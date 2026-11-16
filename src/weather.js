export const weatherFields = ['cloud_cover', 'cloud_cover_low', 'cloud_cover_mid', 'cloud_cover_high', 'precipitation_probability', 'precipitation', 'wind_speed_10m', 'temperature_2m', 'visibility'];

export async function fetchForecast(location, { fetchImpl = fetch, apiKey = process.env.OPEN_METEO_API_KEY, now = Date.now() } = {}) {
  const url = new URL(apiKey ? 'https://customer-api.open-meteo.com/v1/forecast' : 'https://api.open-meteo.com/v1/forecast');
  const params = { latitude: location.lat, longitude: location.lon, hourly: weatherFields.join(','), forecast_days: 16, timezone: 'GMT', timeformat: 'unixtime', wind_speed_unit: 'kmh', temperature_unit: 'celsius', precipitation_unit: 'mm' };
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  if (apiKey) url.searchParams.set('apikey', apiKey);
  let response;
  try { response = await fetchImpl(url, { signal: AbortSignal.timeout(20000) }); }
  catch { throw new Error('Open-Meteo could not be reached. Retry later; no forecast was assumed.'); }
  if (!response.ok) throw new Error(`Open-Meteo returned HTTP ${response.status}. Check service availability and subscription configuration.`);
  let raw;
  try { raw = await response.json(); }
  catch { throw new Error('Open-Meteo returned invalid JSON. Retry later; the response body was not logged.'); }
  if (!Array.isArray(raw.hourly?.time)) throw new Error('Open-Meteo response has no hourly forecast');
  const expected = { cloud_cover: '%', precipitation_probability: '%', precipitation: 'mm', wind_speed_10m: 'km/h', temperature_2m: '°C', visibility: 'm' };
  for (const [field, unit] of Object.entries(expected)) {
    if (raw.hourly_units?.[field] !== unit) throw new Error(`Unexpected Open-Meteo unit for ${field}`);
  }
  return {
    source: 'Open-Meteo', fetchedAt: new Date(now).toISOString(),
    hours: raw.hourly.time.map((t, i) => Object.fromEntries([
      ['at', new Date(t * 1000).toISOString()], ...weatherFields.map(k => [k, raw.hourly[k]?.[i] ?? null]),
    ])),
  };
}

export function assessWeather(forecast, start, end, request) {
  const hours = [];
  for (let t = Math.floor(start / 3600000) * 3600000; t < end; t += 3600000) {
    const hour = forecast.hours.find(h => Date.parse(h.at) === t);
    const ranges = { cloud_cover: [0, 100], precipitation_probability: [0, 100], precipitation: [0, 1000], wind_speed_10m: [0, 500], temperature_2m: [-100, 70], visibility: [0, 1000000] };
    if (!hour || Object.entries(ranges).some(([k, [min, max]]) => !Number.isFinite(hour[k]) || hour[k] < min || hour[k] > max)) return { suitable: false, reason: 'missing_weather' };
    hours.push(hour);
  }
  const cloud = Math.max(...hours.map(h => h.cloud_cover));
  const wind = Math.max(...hours.map(h => h.wind_speed_10m));
  const temperature = Math.min(...hours.map(h => h.temperature_2m));
  const precipitationProbability = Math.max(...hours.map(h => h.precipitation_probability));
  const rain = Math.max(...hours.map(h => h.precipitation));
  const visibility = Math.min(...hours.map(h => h.visibility));
  const checks = [
    ['cloud_cover', 'Cloud cover', cloud, request.maxCloudCover, '%', 'max'],
    ['wind_speed_10m', 'Wind', wind, request.maxWindKmh, 'km/h', 'max'],
    ['temperature_2m', 'Temperature', temperature, request.minTemperatureC, '°C', 'min'],
    ['precipitation_probability', 'Chance of rain', precipitationProbability, request.maxPrecipitationProbability, '%', 'max'],
    ['precipitation', 'Rainfall', rain, 0, 'mm', 'max'],
    ['visibility', 'Visibility', visibility, 5000, 'm', 'min'],
  ];
  const failures = checks.filter(([, , value, limit, , bound]) => bound === 'max' ? value > limit : value < limit)
    .map(([field, label, value, limit, unit, bound]) => ({ field, label, value, limit, unit, bound, at: hours.find(h => h[field] === value).at }));
  return {
    suitable: cloud <= request.maxCloudCover && wind <= request.maxWindKmh && temperature >= request.minTemperatureC && precipitationProbability <= request.maxPrecipitationProbability && rain === 0 && visibility >= 5000,
    maxCloudCover: cloud, maxWindKmh: wind, minTemperatureC: temperature,
    maxPrecipitationProbability: precipitationProbability, minVisibilityM: visibility,
    maxPrecipitationMm: rain, failures,
    source: forecast.source, fetchedAt: forecast.fetchedAt,
  };
}
