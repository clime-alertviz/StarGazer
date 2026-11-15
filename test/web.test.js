import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../web/server/store.js';
import { StargazerService } from '../web/server/service.js';
import { createApp } from '../web/server.js';
import { loadDatabaseProfiles } from '../src/profile-database.js';
import { demoScenario, carpoolScenario, demoGeo, demoNow, demoForecast } from '../src/demo-data.js';
import { planOuting } from '../src/planner.js';

async function setup(t, { busy = [], uncertain = false, duplicate = null } = {}) {
  const directory = await mkdtemp(join(tmpdir(),'stargazer-web-'));
  const store = await new Store(directory).load();
  t.after(async()=>{store.close();await rm(directory,{recursive:true,force:true});});
  const calls = [];
  const bridge = { status:{state:'ready',signedIn:true,calendar:true}, calendar: async (tool,args) => {
    calls.push({tool,args});
    if(tool==='get_profile')return {email:'anna@test-fixture.org'};
    if(tool==='search_events')return {events:duplicate?[duplicate]:[],next_page_token:null};
    if(tool==='get_availability')return {calendars:{primary:{busy}}};
    if(tool==='create_event'){if(uncertain)throw new Error('Connection lost after dispatch');return{id:'test-event',url:'https://calendar.google.com/calendar/event?eid=test'};}
    throw new Error('Unexpected Calendar tool');
  }};
  const service = new StargazerService({store,bridge});
  const input=carpoolScenario(await demoScenario());
  const plan=await planOuting(input,{geo:demoGeo(),now:demoNow,demo:true,forecast:demoForecast});
  plan.mode='live';plan.createdAt=new Date().toISOString();
  // Freeze test planning in the future independently of the wall-clock date.
  const shift=Date.now()+86400000-Date.parse(plan.meetingStart);
  for(const field of ['meetingStart','meetingEnd','observingStart','observingEnd'])plan[field]=new Date(Date.parse(plan[field])+shift).toISOString();
  for(const route of plan.routes)for(const field of ['departAt','homeBy'])route[field]=new Date(Date.parse(route[field])+shift).toISOString();
  plan.participants.forEach(p=>{p.email=p.id+'@test-fixture.org';});
  const outing=await store.addOuting(plan,input,'Fixture for invitation contract testing only');
  return {store,service,calls,outing,bridge,directory};
}

test('SQLite stores profiles and outings durably; the MCP reader sees the same records', async t=>{
  const {store,directory}=await setup(t);
  const p=(await demoScenario()).participants[0];
  await store.saveProfile({profile:p,displayPlace:'Public fixture point',avatar:'star'});
  assert.equal(loadDatabaseProfiles(store.path)[0].name,p.name);
  const another=await new Store(directory).load();
  assert.equal(another.state.profiles[0].profile.id,p.id);assert.equal(another.state.outings.length,1);another.close();
  await assert.rejects(()=>store.saveProfile({profile:{...p,id:'duplicate'},displayPlace:'Duplicate'}),/email already/);
  await store.removeProfile(p.id);assert.equal(store.state.profiles.length,0);assert.equal(store.state.organizerId,null);
});

test('driver pickup suggestions and a rider without a preference survive SQLite and MCP reads', async t=>{
  const {store,directory}=await setup(t);
  const input=carpoolScenario(await demoScenario());
  const driver=input.participants.find(p=>p.transport==='drive'), rider=input.participants.find(p=>p.transport==='ride');
  driver.car.pickupPoints=[structuredClone(rider.pickup)];delete rider.pickup;
  for(const p of [driver,rider])await store.saveProfile({profile:p,displayPlace:'Public fixture point'});
  const read=loadDatabaseProfiles(store.path);
  assert.deepEqual(read.find(p=>p.id===driver.id).car.pickupPoints,driver.car.pickupPoints);
  assert.equal(read.find(p=>p.id===rider.id).pickup,undefined);
  const reopened=await new Store(directory).load();
  try {assert.deepEqual(reopened.state.profiles.find(p=>p.profile.id===driver.id).profile.car.pickupPoints,driver.car.pickupPoints);}
  finally {reopened.close();}
});

test('Invite uses the reviewed payload, requests notification, checks whole-trip availability and is idempotent',async t=>{
 const {service,calls,outing}=await setup(t);
 const preview=await service.previewInvitation(outing.id);
 const result=await service.sendInvitation(outing.id,preview.token);
 assert.equal(result.status,'sent');
 const create=calls.find(c=>c.tool==='create_event');assert.deepEqual(create.args,preview.arguments);
 assert.equal(create.args.notify,true);assert.equal(create.args.add_google_meet,false);assert.equal(create.args.visibility,'private');
 const availability=calls.find(c=>c.tool==='get_availability');assert.equal(availability.args.time_min,outing.plan.routes.find(r=>r.participantId===outing.plan.request.organizerId).departAt);
 await assert.rejects(()=>service.sendInvitation(outing.id,preview.token),/Reopen/);
 const second=await service.previewInvitation(outing.id);await service.sendInvitation(outing.id,second.token);
 assert.equal(calls.filter(c=>c.tool==='create_event').length,1);
});

test('Demo, stale previews and modified payloads cannot send',async t=>{
 const {service,outing,calls}=await setup(t);
 outing.plan.mode='demo';const demo=await service.previewInvitation(outing.id);
 await assert.rejects(()=>service.sendInvitation(outing.id,demo.token),/Demo invitations/);
 outing.plan.mode='live';const stale=await service.previewInvitation(outing.id);service.inviteTokens.get(stale.token).expires=0;
 await assert.rejects(()=>service.sendInvitation(outing.id,stale.token),/Reopen/);
 const changed=await service.previewInvitation(outing.id);outing.plan.site.name='Changed after preview';
 await assert.rejects(()=>service.sendInvitation(outing.id,changed.token),/outing changed/);assert.equal(calls.length,0);
});

test('A Calendar conflict stops before any write',async t=>{
 const {service,outing,calls}=await setup(t,{busy:[{start:'2026-11-20T18:00:00Z',end:'2026-11-20T19:00:00Z'}]});
 const preview=await service.previewInvitation(outing.id);await assert.rejects(()=>service.sendInvitation(outing.id,preview.token),/conflict/);
 assert.ok(!calls.some(c=>c.tool==='create_event'));
});

test('An ambiguous send is persisted and cannot automatically send a second invitation',async t=>{
 const {service,outing,calls,directory}=await setup(t,{uncertain:true});
 const preview=await service.previewInvitation(outing.id);await assert.rejects(()=>service.sendInvitation(outing.id,preview.token),/Connection lost/);
 assert.equal(outing.invitation.status,'uncertain');
 const second=await service.previewInvitation(outing.id);await assert.rejects(()=>service.sendInvitation(outing.id,second.token),/uncertain result/);
 assert.equal(calls.filter(c=>c.tool==='create_event').length,1);
 const loaded=await new Store(directory).load();assert.equal(loaded.state.outings[0].invitation.status,'uncertain');loaded.close();
});

test('Duplicate recovery finds an existing plan marker without creating or notifying again',async t=>{
 const duplicate={id:'existing',description:'',url:'https://calendar.google.com/calendar/event?eid=existing'};
 const {service,outing,calls}=await setup(t,{duplicate});duplicate.description=`Star Gazer plan: ${outing.plan.planId}`;
 const preview=await service.previewInvitation(outing.id),result=await service.sendInvitation(outing.id,preview.token);
 assert.equal(result.eventId,'existing');assert.equal(result.recovered,true);assert.deepEqual(calls.map(c=>c.tool),['get_profile','search_events']);
});

test('Parallel Invite clicks produce one write even with separate valid preview tokens',async t=>{
 const {service,outing,calls}=await setup(t);
 const a=await service.previewInvitation(outing.id),b=await service.previewInvitation(outing.id);
 const results=await Promise.allSettled([service.sendInvitation(outing.id,a.token),service.sendInvitation(outing.id,b.token)]);
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(calls.filter(c=>c.tool==='create_event').length,1);
});

test('HTTP API protects profiles and invitations against cross-origin and missing-token requests',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'stargazer-http-'));
 const app=await createApp({directory,port:0,bridge:{status:{state:'ready',signedIn:true,calendar:true}}});
 t.after(async()=>{app.close();await rm(directory,{recursive:true,force:true});});
 const root=await fetch(app.url),cookie=root.headers.get('set-cookie').split(';')[0];assert.equal(root.status,200);
 const timeModule=await fetch(app.url+'/planning-time.js');
 assert.equal(timeModule.status,200);assert.match(timeModule.headers.get('content-type'),/text\/javascript/);
 assert.equal((await fetch(app.url+'/api/state')).status,401);
 const state=await(await fetch(app.url+'/api/state',{headers:{cookie}})).json();assert.ok(state.csrf);
 const bad=await fetch(app.url+'/api/match',{method:'POST',headers:{cookie,Origin:'https://evil.example','Content-Type':'application/json','X-Stargazer-Csrf':state.csrf},body:JSON.stringify({mode:'demo',useAgent:false})});assert.equal(bad.status,403);
 const missing=await fetch(app.url+'/api/match',{method:'POST',headers:{cookie,Origin:app.url,'Content-Type':'application/json'},body:'{}'});assert.equal(missing.status,403);
 const traversal=await fetch(app.url+'/private/web/stargazer.sqlite',{headers:{cookie}});assert.equal(traversal.status,404);
 const good=await fetch(app.url+'/api/match',{method:'POST',headers:{cookie,Origin:app.url,'Content-Type':'application/json','X-Stargazer-Csrf':state.csrf},body:JSON.stringify({mode:'demo',useAgent:false})});assert.equal(good.status,202);
 const job=await good.json();
 for(let i=0;i<30&&app.service.jobs.get(job.id).status==='running';i++)await new Promise(r=>setTimeout(r,10));
 assert.equal(app.service.jobs.get(job.id).status,'completed');assert.equal(app.store.state.outings[0].plan.carpools.length,1);
});

test('Agent flow uses the advertised Geoapify category and only selected database profiles',async t=>{
 const {store}=await setup(t);const participants=(await demoScenario()).participants;
 for(const p of participants)await store.saveProfile({profile:p,displayPlace:'Public fixture point'});
 const previousKey=process.env.GEOAPIFY_API_KEY;process.env.GEOAPIFY_API_KEY='unit-test-placeholder';
 t.after(()=>{if(previousKey===undefined)delete process.env.GEOAPIFY_API_KEY;else process.env.GEOAPIFY_API_KEY=previousKey;});
 const calls=[];
 const geo={call:async(name,args)=>{calls.push(name);if(name==='list_place_categories')return{categories:['tourism.attraction.viewpoint']};assert.equal(args.category,'tourism.attraction.viewpoint');return{results:[{name:'Fixture viewpoint',lat:50,lon:14}]};}};
 const bridge={run:async({callTool})=>{await callTool('read_circle');await callTool('discover_spots');await callTool('match_outing');return'No suitable weather in this fixture.';}};
 const service=new StargazerService({store,bridge,geo,planner:async input=>{assert.deepEqual(input.participants.map(p=>p.id),['anna']);assert.equal(input.sites[0].access,'unverified');return{status:'no_match',reason:'Fixture weather'};}});
 const input=await demoScenario();const job=service.match({mode:'live',participantIds:['anna'],request:{...input.request,minPeople:1,maxPeople:1}});
 for(let i=0;i<30&&service.jobs.get(job.id).status==='running';i++)await new Promise(r=>setTimeout(r,10));
 assert.equal(service.jobs.get(job.id).status,'completed');assert.deepEqual(calls,['list_place_categories','search_places']);assert.equal(store.state.outings[0].plan.mode,'live');
});

test('Invite verifies the organizer owns the connected Calendar before using their travel interval',async t=>{
 const {service,outing,calls}=await setup(t);
 outing.plan.participants.find(p=>p.id===outing.plan.request.organizerId).email='someone-else@test-fixture.org';
 const preview=await service.previewInvitation(outing.id);
 await assert.rejects(()=>service.sendInvitation(outing.id,preview.token),/organizer profile email/);
 assert.deepEqual(calls.map(c=>c.tool),['get_profile']);
});
