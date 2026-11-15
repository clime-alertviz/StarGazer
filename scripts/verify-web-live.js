// Read-only external test: temporary synthetic profiles, live planning, no Calendar writes.
import { writeFile } from 'node:fs/promises';
const base=process.env.STAR_GAZER_WEB_URL||'http://127.0.0.1:4317';
const home=await fetch(base),cookie=home.headers.get('set-cookie').split(';')[0];
let state=await(await fetch(base+'/api/state',{headers:{cookie}})).json();
const post=async(path,data)=>{const response=await fetch(base+'/api/'+path,{method:'POST',headers:{cookie,Origin:base,'Content-Type':'application/json','X-Stargazer-Csrf':state.csrf},body:JSON.stringify(data)});const result=await response.json();if(!response.ok)throw new Error(result.error);return result;};
for(let i=0;i<50&&['starting','discovering'].includes(state.connection.state);i++){await new Promise(r=>setTimeout(r,2000));state=await(await fetch(base+'/api/state',{headers:{cookie}})).json();}
if(!state.connection.geoapify||state.connection.state!=='ready')throw new Error('Live web connection is not ready.');
if(state.profiles.length>6)throw new Error('The live check needs room for two temporary profiles. No existing profiles were changed.');
const suffix=Date.now().toString(36),ids=['web-driver-'+suffix,'web-rider-'+suffix];
const start=new Date();start.setDate(start.getDate()+1);start.setHours(18,0,0,0);const end=new Date(+start+5*3600000);
const availability=[{start:new Date(+start-3*3600000).toISOString(),end:new Date(+end+3*3600000).toISOString()}];
const basic={timezone:'Europe/Prague',interests:['Saturn','stargazing'],maxTravelMinutes:120,maxWalkMinutes:40,groupSize:{min:2,max:2},preference:'balanced',availability,origin:{lat:50.0755,lon:14.4378}};
try{
 await post('profiles',{profile:{...basic,id:ids[0],name:'Synthetic web driver',email:ids[0]+'@example.test',experience:'experienced',happyToTeach:true,equipment:['telescope'],shareEquipment:true,transport:'drive',car:{available:true,offerRides:true,passengerSeats:1,maxDetourMinutes:30}},displayPlace:'Public Prague test point',avatar:'saturn'});
 await post('profiles',{profile:{...basic,id:ids[1],name:'Synthetic web rider',email:ids[1]+'@example.test',experience:'beginner',happyToTeach:false,equipment:[],shareEquipment:false,transport:'ride',pickup:{name:'Public Prague test pickup; not an agreed meeting',location:basic.origin}},displayPlace:'Public Prague test point',avatar:'moon'});
 const job=await post('match',{mode:'live',useAgent:true,participantIds:ids,request:{organizerId:ids[0],target:'Saturn',start:start.toISOString(),end:end.toISOString(),timezone:'Europe/Prague',durationMinutes:30,minPeople:2,maxPeople:2,needsGuide:true}});
 let result;
 for(let i=0;i<150;i++){
  await new Promise(r=>setTimeout(r,2000));state=await(await fetch(base+'/api/state',{headers:{cookie}})).json();result=state.jobs.find(j=>j.id===job.id);
  if(i%15===0)console.log(result.events.at(-1)?.message);
  if(result.status!=='running')break;
 }
 if(result.status!=='completed')throw new Error(result.error||'Live web job did not complete.');
 const outing=state.outings.find(o=>o.id===result.result.outingId);
 if(!['needs_access_check','no_match'].includes(outing.plan.status))throw new Error('Unverified discovered places must not be invitation-ready.');
 const report={checkedAt:new Date().toISOString(),provenance:'Actual web API, SQLite profiles, Codex app-server model turn and live providers. Synthetic people and public coordinates only.',calendarWrite:false,status:'passed',planStatus:outing.plan.status,carpoolCount:outing.plan.carpools?.length||0,events:result.events,summary:outing.summary,checks:{agentCompleted:true,sharedProfileStore:true,liveProviders:true,unverifiedAccessBlocksInvite:true}};
 await writeFile(new URL('../examples/generated/live-web-trace.json',import.meta.url),JSON.stringify(report,null,2)+'\n');
 console.log(JSON.stringify(report,null,2));
}finally{for(const id of ids)await post(`profiles/${id}/delete`,{});}
