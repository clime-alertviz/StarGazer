import test from 'node:test';
import assert from 'node:assert/strict';
import { planOuting } from '../src/planner.js';
import { prepareInvitation } from '../src/calendar.js';
import { demoScenario, demoGeo, demoForecast, demoNow } from '../src/demo-data.js';
import { assessWeather } from '../src/weather.js';
import { assessSky, skyAt } from '../src/astronomy.js';
import { planInput } from '../src/schema.js';

const deps = (extra = {}) => ({ geo: demoGeo(), forecast: demoForecast, now: demoNow, demo: true, ...extra });

test('Saturn outing selects a compatible group, supplies a telescope and checks return journeys', async () => {
  const plan = await planOuting(await demoScenario(), deps());
  assert.equal(plan.status, 'proposal');
  assert.deepEqual(plan.participants.map(p => p.id), ['anna', 'eva', 'petr']);
  assert.equal(plan.site.id, 'demo-ridge');
  assert.ok(plan.astronomy.minTargetAltitude >= 20);
  assert.ok(plan.equipment.some(s => s.includes('Petr')));
  assert.ok(plan.routes.every(r => r.return.minutes > r.outbound.minutes));
  assert.ok(plan.exclusions.travel_or_availability > 0);
  const invite = prepareInvitation(plan);
  assert.equal(invite.status, 'demo_do_not_send');
  assert.equal(invite.arguments.notify, true);
  assert.equal(invite.arguments.add_google_meet, false);
  assert.equal(invite.arguments.timezone_str, 'Europe/Prague');
  assert.equal(invite.arguments.start_time, '2026-11-20T18:35:00.000Z');
  assert.equal(invite.arguments.end_time, '2026-11-20T20:25:00.000Z');
  assert.ok(invite.arguments.description.includes(plan.planId));
  assert.ok(!invite.arguments.description.includes('50.0755')); // no home location in shared event
});

test('shortest-journey preferences change the destination', async () => {
  const input = await demoScenario();
  input.participants.forEach(p => { p.preference = 'shortest_journey'; });
  const plan = await planOuting(input, deps());
  assert.equal(plan.site.id, 'demo-meadow');
});

test('does not borrow unshared equipment or promise an unwilling guide', async () => {
  const input = await demoScenario();
  input.participants.find(p => p.id === 'petr').shareEquipment = false;
  assert.equal((await planOuting(input, deps())).status, 'no_match');
  input.participants.find(p => p.id === 'petr').shareEquipment = true;
  input.participants.find(p => p.id === 'petr').happyToTeach = false;
  assert.equal((await planOuting(input, deps())).status, 'no_match');
});

test('counts outbound, return travel, final walk and setup against availability', async () => {
  const input = await demoScenario();
  input.request.start = '2026-11-20T19:00:00Z'; input.request.end = '2026-11-20T20:00:00Z';
  input.participants.find(p => p.id === 'anna').availability = [{ start: input.request.start, end: input.request.end }];
  assert.equal((await planOuting(input, deps())).status, 'no_match');
});

test('closed sites and access windows are enforced, unverified access blocks invitations', async () => {
  const input = await demoScenario();
  input.sites.forEach(s => { s.access = 'closed'; });
  assert.equal((await planOuting(input, deps())).status, 'no_match');
  input.sites.forEach(s => { s.access = 'unverified'; });
  const plan = await planOuting(input, deps());
  assert.equal(plan.status, 'needs_access_check');
  assert.throws(() => prepareInvitation(plan), /confirmed night access/);
  input.sites.forEach(s => { s.accessWindows[0].end = '2026-11-20T18:00:00+01:00'; });
  assert.equal((await planOuting(input, deps())).status, 'no_match');
});

test('missing, rainy or completely cloudy forecasts never become recommendations', async () => {
  for (const change of [f => { f.hours = []; }, f => f.hours.forEach(h => { h.precipitation = 0.1; }), f => f.hours.forEach(h => { h.cloud_cover = 100; })]) {
    const forecast = location => { const f = demoForecast(location); change(f); return f; };
    assert.equal((await planOuting(await demoScenario(), deps({ forecast }))).status, 'no_match');
  }
});

test('missing routes are not zero-minute travel; detailed routes recheck constraints', async () => {
  const base = demoGeo();
  const geo = { call: async (name, args) => {
    const result = await base.call(name, args);
    if (name === 'calculate_route_matrix') result.sources_to_targets = result.sources_to_targets.map(row => row.map(() => null));
    return result;
  } };
  assert.equal((await planOuting(await demoScenario(), deps({ geo }))).status, 'no_match');
  const slow = { call: async (name, args) => {
    const result = await base.call(name, args); if (name === 'calculate_route') result.time = 18000; return result;
  } };
  assert.equal((await planOuting(await demoScenario(), deps({ geo: slow }))).status, 'no_match');
});

test('search accepts pairs and solo viewing when each profile allows the group size', async () => {
  const input = await demoScenario();
  input.request.minPeople = 2; input.request.maxPeople = 2;
  assert.equal((await planOuting(input, deps())).participants.length, 2);
  input.request.target = 'Moon'; input.request.needsGuide = false; input.request.minPeople = 1; input.request.maxPeople = 1;
  input.participants = [input.participants.find(p => p.id === 'anna')]; input.participants[0].groupSize.min = 1;
  assert.equal((await planOuting(input, deps())).participants.length, 1);
});

test('live mode refuses historical or distant windows and stale forecasts', async () => {
  const input = await demoScenario();
  await assert.rejects(planOuting(input, deps({ demo: false, now: Date.parse('2027-01-01T00:00:00Z') })), /future window/);
  await assert.rejects(planOuting(input, deps({ demo: false, now: Date.parse('2026-10-01T00:00:00Z') })), /15 days/);
  const forecast = location => ({ ...demoForecast(location), fetchedAt: '2026-11-01T00:00:00Z' });
  await assert.rejects(planOuting(input, deps({ demo: false, forecast })), /stale/);
});

test('live invitation rejects sample recipients and expires after one hour', async () => {
  const plan = await planOuting(await demoScenario(), deps()); plan.mode = 'live';
  assert.throws(() => prepareInvitation(plan, { now: demoNow }), /sample email/);
  plan.participants.forEach((p, i) => { p.email = `observer${i}@stargazer-demo.cz`; });
  assert.equal(prepareInvitation(plan, { now: demoNow }).status, 'ready_for_organizer');
  assert.throws(() => prepareInvitation(plan, { now: demoNow + 3600001 }), /one hour old/);
});

test('validates explicit offsets, unique identities and real IANA zones', async () => {
  const input = await demoScenario();
  input.request.start = '2026-11-20T19:00:00'; assert.equal(planInput.safeParse(input).success, false);
  input.request.start = '2026-11-20T19:00:00+01:00'; input.request.timezone = 'Europe/NotAPlace';
  assert.equal(planInput.safeParse(input).success, false);
  input.request.timezone = 'Europe/Prague'; input.participants[1].id = input.participants[0].id;
  assert.equal(planInput.safeParse(input).success, false);
});

test('hourly forecast coverage includes both sides of an hour boundary, including midnight', () => {
  const f = demoForecast({ lat: 49.9 });
  const limits = { maxCloudCover: 40, maxWindKmh: 25, minTemperatureC: -5, maxPrecipitationProbability: 20 };
  const start = Date.parse('2026-11-20T23:30:00Z'), end = Date.parse('2026-11-21T00:30:00Z');
  assert.equal(assessWeather(f, start, end, limits).suitable, true);
  f.hours.find(h => h.at === '2026-11-21T00:00:00.000Z').cloud_cover = null;
  assert.equal(assessWeather(f, start, end, limits).suitable, false);
});

test('astronomy distinguishes noon from night and samples the end of a session', () => {
  const loc = { lat: 50.0755, lon: 14.4378 };
  const noon = Date.parse('2026-11-20T11:00:00Z');
  assert.ok(skyAt(loc, noon, 'Saturn').sunAltitude > 0);
  assert.equal(assessSky(loc, noon, noon + 3600000, 'Saturn').suitable, false);
  const night = Date.parse('2026-11-20T19:00:00Z');
  const sky = assessSky(loc, night, night + 3600000, 'Saturn');
  assert.equal(sky.suitable, true);
  assert.equal(sky.sampleMinutes, 15);
  assert.ok(sky.moonIllumination >= 0 && sky.moonIllumination <= 1);
  const setting = Date.parse('2026-11-20T23:00:00Z');
  assert.ok(skyAt(loc, setting, 'Saturn').targetAltitude >= 20);
  assert.equal(assessSky(loc, setting, setting + 3600000, 'Saturn').suitable, false);
});

test('UTC timestamps preserve Prague DST change without ambiguous local times', () => {
  const a = new Date('2026-10-25T02:30:00+02:00');
  const b = new Date('2026-10-25T02:30:00+01:00');
  assert.equal(b - a, 3600000);
  const fmt = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', timeZoneName: 'shortOffset', timeZone: 'Europe/Prague' });
  assert.notEqual(fmt.format(a), fmt.format(b));
});


test('weather review identifies every failed limit and incomplete data cannot be overridden', () => {
  const f = demoForecast({ lat: 49.9 });
  const start = Date.parse('2026-11-20T19:00:00Z'), end = start + 3600000;
  const limits = { maxCloudCover:40, maxWindKmh:25, minTemperatureC:-5, maxPrecipitationProbability:20 };
  const h = f.hours.find(h => Date.parse(h.at) === start);
  Object.assign(h, { cloud_cover:45, wind_speed_10m:30, temperature_2m:-8, precipitation_probability:35, precipitation:0.1, visibility:4000 });
  const review = assessWeather(f, start, end, limits);
  assert.equal(review.suitable, false);
  assert.equal(review.failures.length, 6);
  assert.deepEqual(review.failures.find(x => x.field === 'cloud_cover'), {
    field:'cloud_cover', label:'Cloud cover', value:45, limit:40, unit:'%', bound:'max', at:h.at,
  });
  assert.equal(review.failures.find(x => x.field === 'temperature_2m').bound, 'min');
  h.visibility = null;
  assert.equal(assessWeather(f, start, end, limits).reason, 'missing_weather');
});
