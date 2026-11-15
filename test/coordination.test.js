import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../web/server/store.js';
import { StargazerService } from '../web/server/service.js';
import { Coordination } from '../web/server/coordination.js';
import { createApp } from '../web/server.js';

async function fixture(t, options={}) {
  const directory=await mkdtemp(join(tmpdir(),'stargazer-coordination-'));
  const store=await new Store(directory).load(), calls=[];
  const event={id:'fixture-event',url:'https://calendar.google.com/calendar/event?eid=fixture',attendees:[{email:'guest@fixture.org',responseStatus:'needsAction'}]};
  const bridge={status:{state:'ready',calendar:true},calendar:async(tool,args)=>{
    calls.push({tool,args});
    if(tool==='get_profile')return{email:'organizer@fixture.org'};
    if(tool==='search_events')return{events:[]};
    if(tool==='get_availability')return{calendars:{primary:{busy:[]}}};
    if(tool==='create_event')return event;
    if(tool==='read_event')return structuredClone(event);
    if(tool==='delete_event'){event.status='cancelled';return{};}
    if(tool==='update_event'){if(options.failUpdate)throw new Error('Timed out after dispatch');Object.assign(event,{summary:args.title,description:args.description});return event;}
    throw new Error('Unexpected tool '+tool);
  }};
  const service=new StargazerService({store,bridge}), coord=new Coordination(service);
  const created=await coord.createTest({guest:'guest@fixture.org',start:new Date(Date.now()+2*86400000).toISOString(),channel:options.channel||'calendar'});
  const outing=service.outing(created.id), c=outing.coordination;
  t.after(async()=>{store.close();await rm(directory,{recursive:true,force:true});});
  return{directory,store,service,coord,outing,c,calls,event,bridge};
}
async function invite(f){const p=await f.coord.preview(f.outing.id);await f.coord.invite(f.outing.id,p.token);}

test('one channel per participant: only Calendar guests are added, email guests use durable outbox',async t=>{
  const f=await fixture(t);const person={id:'email-guest',name:'Email guest',email:'email@fixture.org',transport:'walk',equipment:[]};
  f.outing.plan.participants.push(person);f.outing.plan.request.maxPeople=3;
  f.c.people.push({...person,channel:'email',response:'pending',revision:1,calendarStatus:'needsAction'});
  await invite(f);
  const args=f.calls.find(c=>c.tool==='create_event').args;
  assert.deepEqual(args.attendees,['guest@fixture.org']);assert.match(args.description,/http:\/\/127\.0\.0\.1:4317\/outing\//);
  assert.equal(f.store.local.outbox.filter(m=>m.to==='guest@fixture.org').length,0);
  assert.equal(f.store.local.outbox.filter(m=>m.to==='email@fixture.org').length,1);
  const reopened=await new Store(f.directory).load();assert.equal(reopened.local.outbox.length,1);reopened.close();
});

test('email-only invitations do not require a Calendar event or double-send on retry',async t=>{
  const f=await fixture(t,{channel:'email'});await invite(f);await invite(f);
  assert.equal(f.calls.filter(c=>c.tool==='create_event').length,0);
  assert.equal(f.store.local.outbox.filter(m=>m.subject.includes('invited')).length,1);
});

test('email-only confirmation and cancellation messages survive an immediate reload',async t=>{
  const f=await fixture(t,{channel:'email'});await invite(f);
  await f.coord.respond(f.outing.id,'guest@fixture.org',{response:'accepted',revision:1});
  let reopened=await new Store(f.directory).load();
  assert.ok(reopened.local.outbox.some(m=>m.to==='guest@fixture.org'&&m.subject==='Outing confirmed · Star Gazer'));
  reopened.close();
  await f.coord.cancel(f.outing.id,{reason:'Review test complete'});
  reopened=await new Store(f.directory).load();
  assert.ok(reopened.local.outbox.some(m=>m.to==='guest@fixture.org'&&m.subject.includes('Cancelled: Review test complete')));
  reopened.close();
});

test('a connection test ten minutes ahead has a usable response window',async t=>{
  const f=await fixture(t,{channel:'email'});
  const start=new Date(Date.now()+10*60000).toISOString();
  const created=await f.coord.createTest({guest:'quick@fixture.org',start,channel:'email'});
  const outing=f.service.outing(created.id);
  assert.equal(outing.coordination.deadline,start);
  const preview=await f.coord.preview(outing.id);
  await f.coord.invite(outing.id,preview.token);
  await f.coord.respond(outing.id,'quick@fixture.org',{response:'accepted',revision:1});
  assert.equal(outing.coordination.status,'confirmed');
});

test('legacy profiles do not opt into Calendar implicitly, and previews do not impose a 24-hour deadline',async t=>{
  const f=await fixture(t,{channel:'email'});
  assert.equal(f.c.people[0].channel,'email');assert.ok(Date.parse(f.c.deadline)>Date.now()+47*3600000);
  await f.coord.preview(f.outing.id);assert.ok(Date.parse(f.c.deadline)>Date.now()+47*3600000);
  const created=await f.coord.createTest({guest:'timezone@fixture.org',start:new Date(Date.now()+86400000).toISOString(),timezone:'America/New_York',channel:'email'});
  assert.equal(f.service.outing(created.id).plan.request.timezone,'America/New_York');
});

test('queued local actions run in order, and a needs-review outing closes after its end',async t=>{
  const f=await fixture(t,{channel:'email'});let release;const order=[];
  const first=f.coord.exclusive(f.outing.id,async()=>{await new Promise(r=>release=r);order.push(1);});
  await Promise.resolve();const second=f.coord.exclusive(f.outing.id,async()=>order.push(2));await Promise.resolve();release();await Promise.all([first,second]);assert.deepEqual(order,[1,2]);
  f.c.status='needs_review';f.c.everConfirmed=true;f.coord.evaluate(f.outing,Date.parse(f.outing.plan.meetingEnd)+1);assert.equal(f.c.status,'completed');
});

test('Calendar acceptance confirms, decline reopens review, and observations have local timestamps',async t=>{
  const f=await fixture(t);await invite(f);
  f.event.attendees[0].responseStatus='accepted';await f.coord.sync(f.outing.id);
  assert.equal(f.c.status,'confirmed');assert.equal(f.c.people[1].response,'accepted');assert.ok(f.c.people[1].observedAt);
  assert.equal(f.calls.filter(c=>c.tool==='update_event').length,1);
  await f.coord.sync(f.outing.id);assert.equal(f.calls.filter(c=>c.tool==='update_event').length,1);
  f.event.attendees[0].responseStatus='declined';await f.coord.sync(f.outing.id);assert.equal(f.c.status,'needs_review');
});

test('ambiguous Calendar snapshots cannot overwrite app decisions',async t=>{
  const f=await fixture(t);await invite(f);
  await f.coord.respond(f.outing.id,'guest@fixture.org',{response:'declined',revision:1});
  f.event.attendees[0].response_status='accepted';delete f.event.attendees[0].responseStatus;
  await f.coord.sync(f.outing.id);
  assert.equal(f.c.people[1].response,'declined');assert.match(f.c.people[1].conflict,/Calendar shows accepted/);
});

test('editing keeps the same event and requires new page responses, even when Calendar still says accepted',async t=>{
  const f=await fixture(t);await invite(f);f.event.attendees[0].responseStatus='accepted';await f.coord.sync(f.outing.id);
  const start=new Date(Date.now()+3*86400000).toISOString();
  await f.coord.edit(f.outing.id,{start,end:new Date(Date.parse(start)+1800000).toISOString(),deadline:new Date(Date.now()+86400000).toISOString(),siteName:'Test',location:{lat:50,lon:14},meetingPoint:{lat:50,lon:14},walkMinutes:0,accessNote:'No actual outing, test only'});
  assert.equal(f.c.revision,2);assert.equal(f.c.status,'needs_review');await f.coord.sync(f.outing.id);
  assert.equal(f.c.people[1].response,'pending');assert.notEqual(f.c.status,'confirmed');
  await assert.rejects(()=>f.coord.respond(f.outing.id,'guest@fixture.org',{response:'accepted',revision:1}),/plan changed/);
  await f.coord.respond(f.outing.id,'guest@fixture.org',{response:'accepted',revision:2});
  await f.coord.respond(f.outing.id,'organizer@fixture.org',{response:'accepted',revision:2});assert.equal(f.c.status,'confirmed');
  assert.equal(f.calls.filter(c=>c.tool==='create_event').length,1);
  assert.ok(f.calls.filter(c=>c.tool==='update_event').every(c=>c.args.event_id==='fixture-event'&&c.args.notify));
});

test('an uncertain Calendar update is saved and never blindly retried',async t=>{
  const f=await fixture(t,{failUpdate:true});await invite(f);
  await f.coord.respond(f.outing.id,'guest@fixture.org',{response:'accepted',revision:1});
  assert.equal(f.c.status,'confirmed');assert.equal(f.c.calendarDelivery,'uncertain');
  await f.coord.respond(f.outing.id,'guest@fixture.org',{response:'declined',revision:1});
  assert.equal(f.calls.filter(c=>c.tool==='update_event').length,1);
});

test('deadline closes an unformed outing; confirmed plans complete after their end',async t=>{
  const f=await fixture(t,{channel:'email'});await invite(f);
  f.coord.evaluate(f.outing,Date.parse(f.c.deadline)+1);assert.equal(f.c.status,'not_formed');
  await assert.rejects(()=>f.coord.respond(f.outing.id,'guest@fixture.org',{response:'accepted',revision:1}),/closed/);
  f.c.status='invited';f.c.people[1].response='accepted';f.coord.evaluate(f.outing,Date.parse(f.outing.plan.meetingEnd)+1);assert.equal(f.c.status,'completed');
});

test('late rider without accepted driver stays unresolved; a full group keeps a waitlist',async t=>{
  const f=await fixture(t,{channel:'email'});await invite(f);
  await f.coord.respond(f.outing.id,'guest@fixture.org',{response:'accepted',revision:1});assert.equal(f.c.status,'confirmed');
  const rider={id:'rider',name:'Rider',email:'rider@fixture.org',transport:'ride',equipment:[]};
  f.outing.plan.participants.push(rider);f.c.people.push({...rider,channel:'email',revision:1,response:'pending'});
  f.outing.plan.carpools=[{driverId:'absent',passengerIds:['rider']}];
  await f.coord.respond(f.outing.id,'rider@fixture.org',{response:'accepted',revision:1});
  assert.equal(f.c.status,'confirmed');assert.equal(f.c.people[2].place,'unresolved');
  f.outing.plan.carpools=[];await f.coord.settle(f.outing);
  assert.equal(f.c.status,'confirmed');assert.equal(f.c.people[2].place,'waitlist');
});

test('a driver withdrawing invalidates an admitted passenger; telescope support is required',async t=>{
  const f=await fixture(t,{channel:'email'});await invite(f);
  f.outing.plan.carpools=[{driverId:'organizer',passengerIds:['guest']}];
  await f.coord.respond(f.outing.id,'guest@fixture.org',{response:'accepted',revision:1});assert.equal(f.c.status,'confirmed');
  await f.coord.respond(f.outing.id,'organizer@fixture.org',{response:'declined',revision:1});assert.equal(f.c.status,'needs_review');
  f.outing.plan.request.target='Saturn';f.c.people[0].response='accepted';f.coord.evaluate(f.outing);assert.match(f.c.reasons.join(' '),/telescope/);
});

test('comments notify organizer and direct reply author once, never the commenter',async t=>{
  const f=await fixture(t,{channel:'email'});await invite(f);
  const first=await f.coord.comment(f.outing.id,'guest@fixture.org',{text:'Can we discuss the pickup?'});
  await f.coord.comment(f.outing.id,'organizer@fixture.org',{text:'Yes, here.',replyTo:first.id});
  assert.equal(f.store.local.outbox.filter(m=>m.subject.includes('commented')&&m.to==='organizer@fixture.org').length,1);
  assert.equal(f.store.local.outbox.filter(m=>m.subject.includes('commented')&&m.to==='guest@fixture.org').length,1);
  const view=f.coord.view(f.outing.id,'guest@fixture.org');assert.ok(!('email' in view.people[0]));assert.ok(!('authorEmail' in view.comments[0]));
  await assert.rejects(()=>f.coord.comment(f.outing.id,'outsider@fixture.org',{text:'No'}),/not invited/);
});

test('weather refresh shows bad conditions, persists age, and cancellation uses the existing event',async t=>{
  const f=await fixture(t);await invite(f);
  await f.coord.respond(f.outing.id,'guest@fixture.org',{response:'accepted',revision:1});
  f.outing.plan.mode='live';f.outing.plan.request={...f.outing.plan.request,maxCloudCover:40,maxWindKmh:25,minTemperatureC:-5,maxPrecipitationProbability:20};
  const at=Math.floor(Date.parse(f.outing.plan.observingStart)/3600000)*3600000;
  f.coord.forecast=async()=>({source:'Fixture forecast',fetchedAt:new Date().toISOString(),hours:[0,1].map(n=>({at:new Date(at+n*3600000).toISOString(),cloud_cover:95,wind_speed_10m:10,temperature_2m:8,precipitation_probability:10,precipitation:0,visibility:10000}))});
  // Use the test event formatter for this fixture; production uses the full, already validated plan.
  f.service.invitationDraft=outing=>f.coord.decorate(outing,f.coord.testDraft(outing));
  await f.coord.refreshWeather(f.outing.id);assert.equal(f.c.weather.maxCloudCover,95);assert.equal(f.c.status,'needs_review');assert.ok(f.c.weather.fetchedAt);
  f.coord.forecast=async()=>{throw new Error('Provider unavailable');};
  await assert.rejects(()=>f.coord.refreshWeather(f.outing.id),/unavailable/);assert.equal(f.c.weather.maxCloudCover,95);assert.ok(f.c.weatherError);
  await f.coord.cancel(f.outing.id,{reason:'Too cloudy'});assert.equal(f.c.status,'cancelled');
  const deletion=f.calls.find(c=>c.tool==='delete_event').args;assert.equal(deletion.event_id,'fixture-event');assert.equal(deletion.notify,true);assert.equal(f.event.status,'cancelled');
});

test('magic-link GET is scanner-safe; explicit POST creates an account and tokens are single-use',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'stargazer-auth-'));
  const app=await createApp({directory,port:0,bridge:{status:{},calendar:async()=>({email:'organizer@fixture.org'})}});
  t.after(async()=>{app.close();await rm(directory,{recursive:true,force:true});});
  const {id}=await app.coordination.createTest({guest:'guest@fixture.org',start:new Date(Date.now()+86400000).toISOString(),channel:'email'});
  const c=app.service.outing(id).coordination;c.status='invited';
  await app.coordination.requestSignIn({email:'guest@fixture.org',outingId:id});
  const link=app.store.local.outbox[0].link, token=new URL(link).hash.slice(1);
  assert.equal((await fetch(link)).status,200);assert.equal((await fetch(link)).status,200);assert.equal(app.store.local.tokens.length,1);
  const headers={Origin:app.url,'Content-Type':'application/json'};
  const bad=await fetch(app.url+'/api/auth/confirm',{method:'POST',headers:{...headers,Origin:'https://scanner.example'},body:JSON.stringify({token})});assert.equal(bad.status,403);
  const response=await fetch(app.url+'/api/auth/confirm',{method:'POST',headers,body:JSON.stringify({token})});assert.equal(response.status,200);
  const cookie=response.headers.get('set-cookie').split(';')[0];assert.equal(app.store.local.accounts.length,1);
  const again=await fetch(app.url+'/api/auth/confirm',{method:'POST',headers,body:JSON.stringify({token})});assert.equal(again.status,400);
  assert.equal((await fetch(app.url+'/api/outbox',{headers:{cookie}})).status,401);
  assert.equal((await fetch(app.url+'/api/state',{headers:{cookie}})).status,401);
  const view=await(await fetch(app.url+'/api/outing/'+id,{headers:{cookie}})).json();assert.ok(view.csrf);assert.equal(view.organizer,false);
  const post=action=>fetch(app.url+'/api/outing/'+id+'/'+action,{method:'POST',headers:{...headers,cookie,'X-Stargazer-Csrf':view.csrf},body:JSON.stringify({response:'accepted',revision:1})});
  assert.equal((await post('respond')).status,200);assert.equal((await post('cancel')).status,403);
});

test('owner sessions survive restart, and each local port has its own cookie name',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'stargazer-restart-')), bridge={status:{}};
  let app=await createApp({directory,port:0,bridge}),port=app.server.address().port;
  const root=await fetch(app.url),cookie=root.headers.get('set-cookie').split(';')[0];assert.match(cookie,new RegExp('stargazer_owner_'+port));
  const before=await(await fetch(app.url+'/api/state',{headers:{cookie}})).json();
  await new Promise(resolve=>{app.server.close(resolve);app.store.close();});
  app=await createApp({directory,port,bridge});t.after(async()=>{app.close();await rm(directory,{recursive:true,force:true});});
  const after=await(await fetch(app.url+'/api/state',{headers:{cookie}})).json();assert.equal(after.csrf,before.csrf);
});

test('an invalid revised real plan leaves the plan, revision and event unchanged',async t=>{
  const f=await fixture(t);await invite(f);f.outing.plan.mode='live';f.outing.input={request:f.outing.plan.request,participants:f.outing.plan.participants,sites:[f.outing.plan.site]};
  const before=structuredClone(f.outing);f.service.planner=async()=>({status:'no_match'});
  const start=new Date(Date.now()+3*86400000).toISOString();
  await assert.rejects(()=>f.coord.edit(f.outing.id,{start,end:new Date(Date.parse(start)+3600000).toISOString(),deadline:new Date(Date.now()+86400000).toISOString(),siteName:'Changed site',location:{lat:51,lon:15},meetingPoint:{lat:51,lon:15},accessNote:'Access checked for test',walkMinutes:10}),/Nothing was changed/);
  assert.deepEqual(f.outing,before);assert.equal(f.calls.filter(c=>c.tool==='update_event').length,0);
});
