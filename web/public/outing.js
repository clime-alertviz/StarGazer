import { appShell, esc } from './shell.js';
import { initFx } from './fx.js';
const $ = selector => document.querySelector(selector);
const url = new URL(location.href), id = url.pathname.split('/')[2], manage = url.searchParams.get('manage') === '1';
let state, csrf, replyTo, preview, authToken, busy = false;
const activePage = { '/outbox':'outbox', '/calendar-test':'test', '/signin':'signin' }[url.pathname] || 'outings';
$('#app').innerHTML = appShell({ active:activePage, detail:activePage==='outings'?'Outing details':'',
  content:'<div class="outing-shell"><div id="notice" role="status" aria-live="polite"></div><div id="page"><p>Opening your night…</p></div></div>' });
initFx();
const showNotice = value => { $('#notice').textContent = value; };
const date = value => value ? new Intl.DateTimeFormat('en-GB',{dateStyle:'medium',timeStyle:'short',timeZone:state?.timezone || 'Europe/Prague'}).format(new Date(value)) : 'Not checked yet';
const localInput = value => { const d = new Date(value); return new Date(+d - d.getTimezoneOffset()*60000).toISOString().slice(0,16); };
async function api(path, data) {
  const response = await fetch('/api/'+path, data === undefined ? {} : {method:'POST',headers:{'Content-Type':'application/json','X-Stargazer-Csrf':csrf || ''},body:JSON.stringify(data)});
  const result = await response.json();
  if (!response.ok) { const error = new Error(result.error); error.status = response.status; throw error; }
  return result;
}
const outingApi = (action='', data) => api(`outing/${id}${action?'/'+action:''}${manage?'?manage=1':''}`, data);
function signInForm() {
  $('#page').innerHTML = `<section class="panel narrow-panel"><div class="eyebrow">YOUR PLACE UNDER THE STARS</div><h1>Join your outing.</h1><p>Use the email address on your invitation. No password needed.</p><form id="signin-request"><div class="field"><label for="email">Your email</label><input type="email" id="email" name="email" autocomplete="email" required></div><button class="primary" type="submit">Send sign-in link →</button></form><p class="muted-line">Local testing: sign-in messages appear in the <a href="/outbox" target="_blank">local outbox</a>. Open it on this computer.</p></section>`;
}
function personStatus(person, revision) {
  if (person.revision !== revision && person.response !== 'declined') return 'Please reconfirm';
  if (person.place === 'confirmed') return 'Going';
  return { accepted:'Accepted', tentative:'Maybe', declined:'Declined', pending:'No response yet' }[person.response] || 'No response yet';
}
function render() {
  const s = state, me = s.people.find(p => p.id === s.viewerId), closed = ['cancelled','completed','not_formed'].includes(s.status), weather = s.weather;
  document.title = `${s.title} · Star Gazer`;
  $('#page').innerHTML = `<section class="outing-hero"><div><div class="eyebrow">${s.test?'A SMALL TEST, A REAL INVITATION':s.demo?'FICTIONAL PREVIEW':'YOUR SHARED NIGHT'} · REVISION ${s.revision}</div><h1>${esc(s.title)}</h1><span class="state-tag state-${s.status}">${esc(s.statusLabel)}</span><p>${date(s.start)} – ${date(s.end)}<br>${esc(s.timezone)} · ${esc(s.site.name)}</p></div><div class="night-orb" aria-hidden="true">✦</div></section>
    ${!manage?'<button class="text-button" data-action="switch-account">Use another email address ↗</button>':''}
    ${s.test?'<div class="alert">This tests invitations and responses only. There is no physical outing and no weather or travel recommendation.</div>':''}
    ${s.reasons.length?`<div class="alert">${s.reasons.map(esc).join('<br>')}</div>`:''}
    <div class="outing-grid"><section class="panel"><h2>Your answer</h2><p>${closed?'This outing is closed. Your previous response is kept for reference.':s.revision>1?'The plan has changed. Please review it and respond here, even if Calendar still says Yes.':'Accepting confirms the travel and equipment arrangements shown below.'}</p>${me?.conflict?`<div class="alert">${esc(me.conflict)}</div>`:''}
    ${s.status==='draft'?'<p>Review the plan, then invite your companions.</p>':`<div class="outing-actions">${[['accepted','I’m in'],['tentative','Maybe'],['declined','Can’t make it']].map(([value,label])=>`<button class="${value==='accepted'?'primary':'secondary'}" data-action="respond" data-response="${value}" aria-pressed="${me?.response===value&&me.revision===s.revision}" ${closed?'disabled':''}>${label}</button>`).join('')}</div>`}
    <small>Reply by ${date(s.deadline)}. Minimum ${s.minPeople}; space for ${s.maxPeople}.<br>Accepting a full group or an unavailable ride leaves you waiting for a place.</small>
    ${s.organizer&&s.status==='draft'?'<div class="outing-actions"><button class="primary" data-action="preview">Review invitation →</button></div>':''}
    ${preview?`<div class="detail-block"><h3>Review before sending</h3><p>Calendar invitations: ${preview.arguments.attendees.map(esc).join(', ') || 'None'}<br>Email to local outbox: ${(preview.emailRecipients || []).map(esc).join(', ') || 'None'}</p><details><summary>Full invitation</summary><pre>${esc(preview.arguments.description)}</pre></details><button class="primary" data-action="invite" ${s.demo?'disabled':''}>Invite</button></div>`:''}</section>
    <section class="panel"><h2>Your constellation</h2>${s.people.map(p=>`<div class="person-row"><span class="person-dot">${esc(p.name[0])}</span><div class="person-info"><strong>${esc(p.name)}${p.id===s.viewerId?' · you':''}</strong>${p.organizer?'<span class="role-tag">Organizer</span>':''}${p.roles.map(r=>`<span class="role-tag">${esc(r)}</span>`).join('')}<small>${esc(p.channel==='calendar'?'Calendar invitation':'Email invitation')}${p.reason?` · ${esc(p.reason)}`:''}</small></div><span class="person-status">${esc(personStatus(p,s.revision))}${p.place&&p.place!=='confirmed'?`<small>${esc({unresolved:'Ride needed',waitlist:'Waitlisted',awaiting_group:'Awaiting group'}[p.place]||'')}</small>`:''}</span></div>`).join('')}</section>
    <section class="panel"><h2>The sky report</h2>${weather?`<div class="weather-stats"><div><strong>${esc(weather.maxCloudCover)}%</strong><span>maximum cloud cover</span></div><div><strong>${esc(weather.maxWindKmh)} km/h</strong><span>maximum wind</span></div><div><strong>${esc(weather.minTemperatureC)}°C</strong><span>minimum temperature</span></div><div><strong>${esc(weather.maxPrecipitationProbability ?? '—')}%</strong><span>maximum chance of rain</span></div></div><p>${weather.suitable===false?'Conditions no longer meet the planning limits.':s.demo?'Fictional sample forecast.':'Within the planning limits when checked.'}</p><small>${esc(weather.source || 'Open-Meteo')} · fetched ${date(weather.fetchedAt)}<br>For the observing window. Forecasts can change.</small>`:'<p class="muted-line">No live forecast for this connection test.</p>'}
    ${s.weatherError?`<div class="alert">${esc(s.weatherError.message)}<br>Last attempt ${date(s.weatherError.at)}.</div>`:''}
    ${s.organizer&&!s.test&&!s.demo&&!closed?'<div class="outing-actions"><button class="secondary" data-action="weather">Refresh weather ↻</button></div>':''}</section>
    <section class="panel"><h2>Getting there, together</h2>${s.carpools.length?s.carpools.map(c=>`<p><strong>${esc(c.driverName)} drives</strong> · ${c.passengerSeats} passenger seats</p>${c.pickups.map(p=>`<p>${esc(p.name)} meets at <strong>${esc(p.pickup.name)}</strong><br><small>Pickup ${date(p.pickupAt)} · return ${date(p.dropoffAt)}</small></p>`).join('')}`).join(''):`<p>${s.test?'No travel involved in this test.':'Everyone travels independently.'}</p>`}${s.equipment.map(e=>`<p>${esc(e)}</p>`).join('')}<small>Public pickup points and times are visible to this group and reveal an approximate starting area. Private profile addresses are not shown.</small></section>
    ${s.organizer?`<section class="panel wide"><h2>Keep the plan in sync</h2><p class="muted-line">${s.calendar.eventId?`Calendar last checked ${date(s.calendar.checkedAt)}. Checks run each minute while the local server is running. App answers stay authoritative when Calendar’s ordering is unclear.`:'Your group responds on this page. Email invitations and updates appear in the local outbox.'}</p>${s.calendar.error?`<div class="alert">${esc(s.calendar.error)}</div>`:''}<div class="outing-actions">${s.calendar.eventId?'<button class="secondary" data-action="sync">Check Calendar responses ↻</button>':''}${s.calendar.url?`<a class="secondary" href="${esc(s.calendar.url)}" target="_blank" rel="noreferrer">Open Calendar ↗</a>`:''}<a class="secondary" href="${esc(s.url)}" target="_blank">Open participant page ↗</a></div>
    ${!closed&&s.status!=='draft'?`<details><summary>Edit time or location</summary><p>Time inputs use your browser timezone (${esc(Intl.DateTimeFormat().resolvedOptions().timeZone)}). ${s.test?'Edit the test meeting.':'Enter the exact observing window. We recheck the existing participants, their original availability, routes, access hours and conditions.'} Everyone must respond on this page again.</p><form id="edit"><div class="row"><div class="field"><label>Start<input name="start" type="datetime-local" value="${localInput(s.observingStart)}" required></label></div><div class="field"><label>End<input name="end" type="datetime-local" value="${localInput(s.observingEnd)}" required></label></div></div><div class="field"><label>Response deadline<input name="deadline" type="datetime-local" value="${localInput(s.deadline)}" required></label></div>${s.test?'':`<div class="field"><label>Observing site name<input name="siteName" value="${esc(s.site.name)}" required></label></div><div class="row"><div class="field"><label>Site latitude<input name="lat" type="number" step="any" min="-90" max="90" value="${s.site.location.lat}" required></label></div><div class="field"><label>Site longitude<input name="lon" type="number" step="any" min="-180" max="180" value="${s.site.location.lon}" required></label></div></div><div class="row"><div class="field"><label>Meeting latitude<input name="meetLat" type="number" step="any" min="-90" max="90" value="${s.site.meetingPoint.lat}" required></label></div><div class="field"><label>Meeting longitude<input name="meetLon" type="number" step="any" min="-180" max="180" value="${s.site.meetingPoint.lon}" required></label></div></div><div class="field"><label>Minutes walking from meeting point<input name="walkMinutes" type="number" min="0" max="120" value="${s.site.walkMinutes}" required></label></div><div class="field"><label>How did you verify night access?<textarea name="accessNote" minlength="10" required>${esc(s.site.accessNote)}</textarea></label></div>`}<button class="primary" type="submit">Check and update this plan</button></form></details><details><summary>Cancel outing</summary><form id="cancel"><div class="field"><label>Reason<textarea name="reason" placeholder="For example, the cloud forecast has worsened." required maxlength="1000"></textarea></label></div><p class="muted-line">The group’s chosen invitation channel receives the update. The same Calendar event is marked Cancelled and stops blocking time.</p><button class="secondary" type="submit">Cancel this outing</button></form></details>`:''}</section>`:''}
    <section class="panel wide"><h2>A little conversation</h2><p class="muted-line">Comments notify the organizer. Replies also notify the person you reply to. For local testing, these emails appear in the outbox.</p>${s.comments.map(c=>`<article class="comment ${c.replyTo?'reply':''}"><strong>${esc(c.authorName)}</strong><time>${date(c.createdAt)}</time><p>${esc(c.text)}</p><button class="text-button" data-action="reply" data-id="${c.id}">Reply ↗</button></article>`).join('') || '<p>No comments yet. Say hello.</p>'}${s.status!=='draft'?`<form id="comment"><div id="reply-context" hidden><span id="reply-label"></span> <button type="button" class="text-button" data-action="cancel-reply">Cancel reply</button></div><div class="field"><label for="comment-text">Your comment</label><textarea id="comment-text" name="text" maxlength="2000" required placeholder="Ask about the plan, equipment or a pickup…"></textarea></div><button class="primary" type="submit">Post comment →</button></form>`:''}</section></div>`;
}
async function loadOuting() {
  try { state = await outingApi(); csrf = state.csrf; render(); }
  catch (error) { if (error.status === 401 || error.message?.includes('not invited')) { state=null; signInForm(); } else throw error; }
}
async function loadOutbox() {
  try {
    const result = await api('outbox');
    $('#page').innerHTML = `<div class="eyebrow">LOCAL MAIL SINK</div><h1>Your test inbox.</h1><p>These messages stay on this computer. No email has been sent. Calendar notifications are sent separately by Google.</p><button class="secondary" data-action="reload-outbox">Refresh inbox ↻</button>${result.messages.map(m=>`<article class="panel outing-panel outbox-message"><span class="to">To ${esc(m.to)}</span><h2>${esc(m.subject)}</h2><small>${date(m.createdAt)} · local only</small><pre>${esc(m.text)}</pre>${m.link?`<a class="primary" href="${esc(m.link)}" target="_blank">${m.subject.includes('sign-in')?'Open sign-in link':'Open outing'} →</a>`:''}</article>`).join('') || '<p>Your outbox is empty.</p>'}`;
  } catch(error) { $('#page').innerHTML='<section class="panel narrow-panel"><h1>Open your local dashboard first.</h1><p>This outbox is for the person running Star Gazer on this computer.</p><a class="primary" href="/">Open Star Gazer →</a></section>'; }
}
async function loadTest() {
  const owner = await api('state'); csrf = owner.csrf;
  $('#page').innerHTML = `<section class="panel narrow-panel"><div class="eyebrow">FROM LOCAL APP TO REAL INBOX</div><h1>Try an invitation.</h1><p>Create a clearly labelled test with your connected Calendar account as organizer and another account you control as guest. Nothing is sent until you review and click Invite.</p><form id="test"><div class="field"><label>Guest email<input name="guest" type="email" placeholder="Your second email account" required></label></div><div class="field"><label>Test meeting time<input name="start" type="datetime-local" value="${localInput(Date.now()+2*86400000)}" required></label></div><div class="field"><label>Invitation channel<select name="channel"><option value="calendar">Real Google Calendar invitation</option><option value="email">Email in local outbox</option></select></label></div><button class="primary" type="submit">Prepare test →</button></form><p class="muted-line">The connected organizer uses their existing Codex Calendar connection. Guests don’t need to connect an account to Star Gazer.</p></section>`;
}
$('#page').addEventListener('click', async event => {
  const button = event.target.closest('[data-action]'); if(!button || busy) return;
  busy = true; button.disabled = true; showNotice('');
  try {
    const action = button.dataset.action;
    if(action==='switch-account') {state=null;signInForm();return;}
    if(action==='respond') await outingApi('respond',{response:button.dataset.response,revision:state.revision});
    if(action==='preview') preview=await outingApi('preview',{});
    if(action==='invite') { await outingApi('invite',{token:preview.token}); preview=null; showNotice('Invitation processed. Email messages are in the local outbox; Google handles Calendar notifications.'); }
    if(action==='sync') await outingApi('sync',{});
    if(action==='weather') await outingApi('weather',{});
    if(action==='reload-outbox') { await loadOutbox(); return; }
    if(action==='continue') { const result=await api('auth/confirm',{token:authToken}); location.href='/outing/'+result.outingId; return; }
    if(action==='reply') { replyTo=button.dataset.id; $('#reply-context').hidden=false; $('#reply-label').textContent='Replying to '+state.comments.find(c=>c.id===replyTo).authorName; $('#comment-text').focus(); return; }
    if(action==='cancel-reply') { replyTo=null; $('#reply-context').hidden=true; return; }
    await loadOuting();
  } catch(error) { showNotice(error.message); } finally { busy=false; button.disabled=false; }
});
$('#page').addEventListener('submit', async event => {
  event.preventDefault(); if(busy) return; busy=true; const form=event.target, button=form.querySelector('button[type="submit"]'), values=Object.fromEntries(new FormData(form));
  button.disabled=true; showNotice('');
  try {
    if(form.id==='signin-request') { const result=await api('auth/request',{email:values.email,outingId:id}); showNotice(result.message); return; }
    if(form.id==='test') { const result=await api('calendar-test',{...values,start:new Date(values.start).toISOString()}); location.href=result.url; return; }
    if(form.id==='comment') { await outingApi('comment',{text:values.text,...(replyTo?{replyTo}:{})}); replyTo=null; }
    if(form.id==='cancel') await outingApi('cancel',values);
    if(form.id==='edit') await outingApi('edit',{
      start:new Date(values.start).toISOString(),end:new Date(values.end).toISOString(),deadline:new Date(values.deadline).toISOString(),
      siteName:values.siteName||state.site.name,location:values.lat?{lat:+values.lat,lon:+values.lon}:state.site.location,
      meetingPoint:values.meetLat?{lat:+values.meetLat,lon:+values.meetLon}:state.site.meetingPoint,
      accessNote:values.accessNote||'Local software test only',walkMinutes:+values.walkMinutes||0,
    });
    await loadOuting();
  } catch(error) { showNotice(error.message); } finally { busy=false; button.disabled=false; }
});
async function start() {
  if(url.pathname==='/signin') {
    authToken=url.hash.slice(1); history.replaceState(null,'','/signin');
    $('#page').innerHTML='<section class="panel narrow-panel"><div class="eyebrow">YOUR SIGN-IN LINK</div><h1>Ready to join?</h1><p>Click Continue to sign in. Opening this page alone does not use your link.</p><button class="primary" data-action="continue">Continue →</button></section>'; return;
  }
  if(url.pathname==='/outbox') return loadOutbox();
  if(url.pathname==='/calendar-test') return loadTest();
  await loadOuting();
  setInterval(()=>{if(state&&!busy&&!document.querySelector('#comment-text')?.value&&!replyTo&&!document.querySelector('details[open]')&&!document.activeElement?.matches('input,textarea,select')&&!preview)loadOuting().catch(error=>showNotice(error.message));},15000);
}
start().catch(error=>showNotice(error.message));
