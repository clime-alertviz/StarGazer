import test from 'node:test';
import assert from 'node:assert/strict';
import { demoScenario, demoForecast, demoNow } from '../src/demo-data.js';
import { planOuting } from '../src/planner.js';
import { planInput, profile } from '../src/schema.js';
import { prepareInvitation } from '../src/calendar.js';
import { createTransport, describeTransport, journeyFits } from '../src/transport.js';

const A = { lat: 50.1, lon: 14.1 }, B = { lat: 50.2, lon: 14.2 }, C = { lat: 50.3, lon: 14.3 }, S = { lat: 49.913, lon: 14.699 };
const P = { lat: 50.21, lon: 14.21 }, E = { lat: 50.31, lon: 14.31 };
const k = p => `${p.lat}/${p.lon}`;
const edgeKey = (mode, a, b) => `${mode}:${k(a)}>${k(b)}`;
const allNight = [{ start: '2026-11-20T15:00:00Z', end: '2026-11-21T02:00:00Z' }];

async function scenario() {
  const s = await demoScenario();
  s.request.start = '2026-11-20T19:00:00Z'; s.request.end = '2026-11-20T20:00:00Z';
  s.sites = [s.sites[0]];
  s.participants = s.participants.filter(p => p.id !== 'lukas');
  const [anna, eva, petr] = s.participants;
  anna.origin = A; anna.car = { available: true, offerRides: true, passengerSeats: 2, maxDetourMinutes: 20 };
  for (const [p, origin, point, name] of [[petr, P, B, 'Library entrance'], [eva, E, C, 'Station forecourt']]) {
    p.origin = origin; p.transport = 'ride'; delete p.car; p.pickup = { name, location: point };
  }
  s.participants.forEach(p => { p.maxTravelMinutes = 100; p.maxWalkMinutes = 20; p.availability = structuredClone(allNight); });
  return s;
}

function graphGeo({ changeRoute = null, editEdges = null, calls = [] } = {}) {
  const edges = new Map();
  const put = (mode, a, b, minutes) => edges.set(edgeKey(mode, a, b), minutes);
  for (const [a,b,m] of [[A,B,8],[B,C,6],[C,S,20],[S,C,22],[C,B,7],[B,A,9],[A,S,30],[S,A,35],[A,C,30],[C,A,30],[B,S,30],[S,B,30]]) put('drive',a,b,m);
  for (const [a,b,m] of [[P,B,3],[B,P,4],[E,C,2],[C,E,3]]) put('walk',a,b,m);
  if (editEdges) editEdges(put);
  const cell = (mode,a,b,traffic) => {
    const m = k(a) === k(b) ? 0 : edges.get(edgeKey(mode,a,b));
    return m === undefined || m === null ? null : { time: m * 60 * (mode === 'drive' && traffic === 'free_flow' ? 0.8 : 1), distance: m * 500 };
  };
  return { call: async (name,args) => {
    calls.push({ name,args });
    const units = { units: 'metric', time_units: 'seconds', distance_units: 'meters' };
    if (name === 'calculate_route_matrix') return { ...units, sources_to_targets: args.sources.map(a => args.targets.map(b => cell(args.mode,a,b,args.traffic))) };
    const legs = args.waypoints.slice(1).map((b,i) => cell(args.mode,args.waypoints[i],b,args.traffic));
    assert.ok(legs.every(Boolean), 'Planner must not validate an unreachable itinerary');
    const route = { ...units, legs, time: legs.reduce((s,l)=>s+l.time,0), distance: legs.reduce((s,l)=>s+l.distance,0) };
    if (changeRoute) changeRoute(route,args);
    return route;
  } };
}
const deps = geo => ({ geo, forecast: demoForecast, now: demoNow, demo: true });

test('one driver takes two riders, including the telescope owner, with exact pickup/drop-off timing', async () => {
  const s = await scenario(), plan = await planOuting(s, deps(graphGeo()));
  assert.equal(plan.status, 'proposal'); assert.equal(plan.carpools.length, 1);
  const car = plan.carpools[0];
  assert.equal(car.driverId, 'anna'); assert.deepEqual(car.passengerIds, ['petr','eva']); assert.deepEqual(car.returnOrder, ['eva','petr']);
  assert.equal(car.detourOutMinutes, 10); assert.equal(car.detourBackMinutes, 9);
  assert.equal(car.pickups[0].pickupAt, '2026-11-20T17:53:00.000Z');
  assert.equal(car.pickups[1].pickupAt, '2026-11-20T18:02:00.000Z');
  assert.equal(car.pickups[0].dropoffAt, '2026-11-20T21:07:00.000Z');
  assert.equal(car.pickups[1].dropoffAt, '2026-11-20T20:57:00.000Z');
  const driver = plan.routes.find(p=>p.participantId==='anna'), rider=plan.routes.find(p=>p.participantId==='petr');
  assert.equal(driver.departAt,'2026-11-20T17:45:00.000Z'); assert.equal(driver.homeBy,'2026-11-20T21:19:00.000Z');
  assert.equal(rider.departAt,'2026-11-20T17:50:00.000Z'); assert.equal(rider.homeBy,'2026-11-20T21:11:00.000Z');
  assert.equal(new URL(car.outboundNavigationUrl).searchParams.get('waypoints'), '50.2,14.2|50.3,14.3');
  assert.equal(new URL(car.returnNavigationUrl).searchParams.get('destination'), '50.2,14.2');
  const description=prepareInvitation(plan).arguments.description;
  assert.match(description,/Library entrance/); assert.match(description,/Station forecourt/); assert.match(description,/not live traffic/);
  for(const point of [A,P,E]) assert.ok(!description.includes(`${point.lat},${point.lon}`) && !description.includes(`${point.lat}, ${point.lon}`));
});

test('missing seats, unwilling drivers and unavailable cars never create a ride', async () => {
  for (const change of [c=>{c.passengerSeats=1;},c=>{c.offerRides=false;},c=>{c.available=false;c.offerRides=false;}]) {
    const s=await scenario(); change(s.participants.find(p=>p.id==='anna').car);
    assert.equal((await planOuting(s,deps(graphGeo()))).status,'no_match');
  }
});

test('driver detours, rider limits and walks to/from pickup points are hard constraints', async () => {
  for (const change of [s=>{s.participants[0].car.maxDetourMinutes=5;},s=>{s.participants[0].maxTravelMinutes=63;},s=>{s.participants.find(p=>p.id==='petr').maxTravelMinutes=55;},s=>{s.participants.find(p=>p.id==='petr').maxWalkMinutes=13;}]) {
    const s=await scenario(); change(s);
    assert.equal((await planOuting(s,deps(graphGeo()))).status,'no_match');
  }
});

test('availability covers pickup departure and return home for drivers AND passengers', async () => {
  for (const [id, boundary, time] of [['anna','start','2026-11-20T18:00:00Z'],['anna','end','2026-11-20T21:00:00Z'],['petr','start','2026-11-20T18:00:00Z'],['petr','end','2026-11-20T20:55:00Z']]) {
    const s=await scenario();s.participants.find(p=>p.id===id).availability[0][boundary]=time;
    assert.equal((await planOuting(s,deps(graphGeo()))).status,'no_match');
  }
});

test('unreachable walking access or return drop-off cannot be replaced by zero minutes', async () => {
  for (const [mode,a,b] of [['walk',B,P],['drive',B,A]]) {
    const s=await scenario();const geo=graphGeo({editEdges:put=>put(mode,a,b,null)});
    assert.equal((await planOuting(s,deps(geo))).status,'no_match');
  }
});

test('uses approximated traffic for every driving call and never for walking/bicycling', async () => {
  const s=await scenario(),calls=[];
  const plan=await planOuting(s,deps(graphGeo({calls})));
  assert.equal(plan.traffic.model,'approximated'); assert.equal(plan.traffic.departureTimePrediction,false);
  assert.equal(plan.traffic.drivingBufferMinutes,10);
  assert.ok(calls.some(c=>c.name==='calculate_route' && c.args.waypoints.length===4));
  for(const c of calls) {
    if(c.args.mode==='drive') assert.equal(c.args.traffic,'approximated'); else assert.equal(c.args.traffic,undefined);
    if(c.name==='calculate_route') {assert.equal(c.args.waypoint_mode,'stopover');assert.equal(c.args.optimize_stops,false);}
  }
  s.request.trafficModel='free_flow';s.request.drivingBufferMinutes=0;
  const free=await planOuting(s,deps(graphGeo()));
  assert.ok(free.routes.find(p=>p.participantId==='anna').outbound.minutes < plan.routes.find(p=>p.participantId==='anna').outbound.minutes);
  assert.equal(free.traffic.model,'free_flow');
});

test('detailed pickup route estimates can reject an optimistic matrix', async () => {
  const s=await scenario();
  const geo=graphGeo({changeRoute:(r,a)=>{if(a.mode==='drive' && a.waypoints.length>2)r.time+=7200;}});
  assert.equal((await planOuting(s,deps(geo))).status,'no_match');
});

test('tries the next pickup order when detailed validation invalidates the first one', async () => {
  const s=await scenario();s.participants.forEach(p=>{p.maxTravelMinutes=200;});s.participants[0].car.maxDetourMinutes=100;
  const geo=graphGeo({changeRoute:(r,a)=>{if(a.waypoints.length===4 && k(a.waypoints[0])===k(A) && k(a.waypoints[1])===k(B))r.time+=7200;}});
  const plan=await planOuting(s,deps(geo));
  assert.equal(plan.status,'proposal');assert.deepEqual(plan.carpools[0].passengerIds,['eva','petr']);
});

test('assigns multiple cars jointly rather than giving the first rider the only feasible seat', async () => {
  const s=await scenario(), D={lat:50.4,lon:14.4};
  const eva=s.participants.find(p=>p.id==='eva');eva.transport='drive';eva.origin=C;delete eva.pickup;
  eva.car={available:true,offerRides:true,passengerSeats:1,maxDetourMinutes:100};s.participants[0].car.passengerSeats=1;s.participants[0].car.maxDetourMinutes=100;
  const petr=s.participants.find(p=>p.id==='petr');petr.origin=B;
  const lukas=structuredClone(petr);lukas.id='lukas';lukas.name='Lukáš';lukas.email='lukas@example.test';lukas.origin=D;lukas.pickup={name:'Square',location:D};
  s.participants.push(lukas);s.request.minPeople=4;s.request.maxPeople=4;
  s.participants.forEach(p=>{p.maxTravelMinutes=200;});
  const geo=graphGeo({editEdges:put=>{for(const [a,b,m]of[[A,D,5],[D,A,5],[D,S,20],[S,D,22],[C,D,null],[D,C,null]])put('drive',a,b,m);}});
  const plan=await planOuting(s,deps(geo));
  assert.equal(plan.status,'proposal');
  assert.deepEqual(plan.carpools.find(c=>c.driverId==='anna').passengerIds,['lukas']);
  assert.deepEqual(plan.carpools.find(c=>c.driverId==='eva').passengerIds,['petr']);
});

test('co-located pickups retain separate seat/dwell accounting and produce a valid detailed path', async () => {
  const s=await scenario(),petr=s.participants.find(p=>p.id==='petr'),eva=s.participants.find(p=>p.id==='eva');
  petr.origin=B;eva.origin=B;eva.pickup={name:'Library entrance',location:B};s.participants[0].car.maxDetourMinutes=100;
  const plan=await planOuting(s,deps(graphGeo()));
  assert.equal(plan.status,'proposal');
  const pickups=plan.carpools[0].pickups;
  assert.equal(Math.abs(Date.parse(pickups[0].pickupAt)-Date.parse(pickups[1].pickupAt)),180000);
});

test('walkers and cyclists get neither a car nor a driving buffer', async () => {
  for(const mode of ['walk','bicycle']) {
    const s=await scenario();s.participants=[s.participants[0]];s.request.minPeople=1;s.request.maxPeople=1;s.request.needsGuide=false;s.request.target='stargazing';
    const p=s.participants[0];p.transport=mode;delete p.car;p.groupSize.min=1;p.maxWalkMinutes=60;
    const calls=[],geo=graphGeo({calls,editEdges:put=>{put(mode,A,S,15);put(mode,S,A,16);}});
    const plan=await planOuting(s,deps(geo));
    assert.equal(plan.status,'proposal');assert.equal(plan.routes[0].outbound.minutes,15);assert.deepEqual(plan.carpools,[]);
    assert.ok(calls.every(c=>!('traffic' in c.args)));
  }
});

test('requires explicit car details, permits riders without a pickup preference, and validates optional driver points', async () => {
  const s=await scenario();delete s.participants[0].car;assert.equal(planInput.safeParse(s).success,false);
  const rider=(await scenario()).participants.find(p=>p.id==='petr');delete rider.pickup;assert.equal(profile.safeParse(rider).success,true);
  const driver=(await scenario()).participants[0];
  driver.car.pickupPoints=[{name:'Station',location:B}];assert.equal(profile.safeParse(driver).success,true);
  driver.car.pickupPoints=Array(4).fill(driver.car.pickupPoints[0]);assert.equal(profile.safeParse(driver).success,false);
  const noSeats=(await scenario()).participants[0];noSeats.car.passengerSeats=0;assert.equal(profile.safeParse(noSeats).success,false);
});

test('one-way-only driver availability cannot hide behind the passenger schedule', async () => {
  const input=planInput.parse(await scenario()),transport=await createTransport(input.participants,input.sites,input.request,graphGeo());
  const choice=transport.options(input.participants,input.sites[0])[0];
  const details=await transport.validate(choice,input.participants,input.sites[0]);
  const described=describeTransport(details,input.participants,input.sites[0],Date.parse(input.request.start),Date.parse(input.request.end));
  assert.ok(Date.parse(described.routes.find(p=>p.participantId==='anna').homeBy)>Date.parse(described.carpools[0].pickups[0].dropoffAt));
});

test('selects driver pickup points for riders with no preference and uses the chosen points in directions and Calendar', async () => {
  const s=await scenario();
  const driver=s.participants[0];
  driver.car.pickupPoints=[{name:'Driver library',location:B},{name:'Driver station',location:C}];
  for(const p of s.participants.filter(p=>p.transport==='ride')) delete p.pickup;
  const plan=await planOuting(s,deps(graphGeo()));
  assert.equal(plan.status,'proposal');
  assert.deepEqual(plan.carpools[0].pickups.map(p=>p.pickup.name),['Driver library','Driver station']);
  assert.equal(new URL(plan.routes.find(p=>p.participantId==='petr').pickupNavigationUrl).searchParams.get('destination'),'50.2,14.2');
  const description=prepareInvitation(plan).arguments.description;
  assert.match(description,/Driver library/);assert.match(description,/Driver station/);
  assert.ok(!description.includes('50.21,14.21'));
});

test('checks walking in both directions when choosing among driver points', async () => {
  const s=await scenario();s.participants=s.participants.filter(p=>p.id!=='eva');s.request.minPeople=2;
  const rider=s.participants.find(p=>p.id==='petr');delete rider.pickup;
  s.participants[0].car.pickupPoints=[{name:'Too far on return',location:C},{name:'Library',location:B}];
  const geo=graphGeo({editEdges:put=>{put('walk',P,C,2);put('walk',C,P,11);}});
  const plan=await planOuting(s,deps(geo));
  assert.equal(plan.status,'proposal');assert.equal(plan.carpools[0].pickups[0].pickup.name,'Library');
  rider.maxWalkMinutes=13;
  assert.equal((await planOuting(s,deps(geo))).status,'no_match');
});

test('prefers a driver point when it fits, and falls back to the passenger point when the detour does not', async () => {
  const s=await scenario();s.participants=s.participants.filter(p=>p.id!=='eva');s.request.minPeople=2;
  s.participants[0].car.pickupPoints=[{name:'Driver station',location:C}];
  const geo=graphGeo({editEdges:put=>{put('walk',P,C,5);put('walk',C,P,5);}});
  s.participants[0].car.maxDetourMinutes=30;
  const preferred=await planOuting(s,deps(geo));
  assert.equal(preferred.status,'proposal');assert.equal(preferred.carpools[0].pickups[0].pickup.name,'Driver station');
  s.participants[0].car.maxDetourMinutes=20;
  const fallback=await planOuting(s,deps(geo));
  assert.equal(fallback.status,'proposal');assert.equal(fallback.carpools[0].pickups[0].pickup.name,'Library entrance');
});

test('tries another pickup location when detailed walking exceeds the matrix estimate', async () => {
  const s=await scenario();s.participants=s.participants.filter(p=>p.id!=='eva');s.request.minPeople=2;
  s.participants[0].car.pickupPoints=[{name:'Driver station',location:C}];
  s.participants[0].car.maxDetourMinutes=30;
  const geo=graphGeo({editEdges:put=>{put('walk',P,C,5);put('walk',C,P,5);},changeRoute:(r,a)=>{
    if(a.mode==='walk'&&k(a.waypoints[0])===k(C)&&k(a.waypoints[1])===k(P))r.time+=1800;
  }});
  const plan=await planOuting(s,deps(geo));
  assert.equal(plan.status,'proposal');assert.equal(plan.carpools[0].pickups[0].pickup.name,'Library entrance');
  assert.ok(plan.exclusions.detailed_route_conflict>0);
});

test('missing public pickup candidates never exposes a private origin as a pickup', async () => {
  const s=await scenario();
  for(const p of s.participants.filter(p=>p.transport==='ride'))delete p.pickup;
  assert.equal((await planOuting(s,deps(graphGeo()))).status,'no_match');
});

test('packing up consumes availability after observing, before the return walk and drive', () => {
  const start=Date.parse('2026-11-20T19:00:00Z'),end=start+3600000;
  const p={maxTravelMinutes:60,maxWalkMinutes:20,availability:[{start:'2026-11-20T18:00:00Z',end:'2026-11-20T20:40:00Z'}]};
  const journey={outbound:{minutes:20},return:{minutes:20},walkOutMinutes:0,walkBackMinutes:0};
  assert.equal(journeyFits(p,journey,{walkMinutes:10},start,end),false);
  p.availability[0].end='2026-11-20T20:45:00Z';assert.equal(journeyFits(p,journey,{walkMinutes:10},start,end),true);
});

test('a selected ride keeps its driver and pickup instead of silently substituting another offer', async () => {
  const input=planInput.parse(await scenario());
  const rider=input.participants.find(p=>p.id==='petr');
  rider.fixedPickup=true;rider.requiredDriverId='anna';
  input.participants[0].car.pickupPoints=[{name:'Other stop',location:C}];
  const transport=await createTransport(input.participants,input.sites,input.request,graphGeo());
  const choices=transport.options(input.participants,input.sites[0]);assert.ok(choices.length);
  const checked=await transport.validate(choices[0],input.participants,input.sites[0]);
  const report=describeTransport(checked,input.participants,input.sites[0],Date.parse(input.request.start),Date.parse(input.request.end));
  assert.equal(report.carpools[0].driverId,'anna');
  assert.equal(report.carpools[0].pickups.find(p=>p.participantId==='petr').pickup.name,'Library entrance');
  rider.requiredDriverId='unavailable-driver';
  const changed=await createTransport(input.participants,input.sites,input.request,graphGeo());
  assert.equal(changed.options(input.participants,input.sites[0]).length,0);
});

test('failed travel limits include actionable minutes and the affected participant',async()=>{
  const input=planInput.parse(await scenario());
  input.participants.find(p=>p.id==='petr').maxTravelMinutes=10;
  const transport=await createTransport(input.participants,input.sites,input.request,graphGeo());
  assert.equal(transport.options(input.participants,input.sites[0]).length,0);
  assert.ok(transport.failures.some(f=>f.participantId==='petr'&&f.kind==='journey'&&f.limit===10&&f.minutes>10));
});
