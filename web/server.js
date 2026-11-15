import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { Store } from './server/store.js';
import { CodexBridge } from './server/codex.js';
import { StargazerService } from './server/service.js';
import { Coordination } from './server/coordination.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const equal = (a, b) => typeof a === 'string' && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const json = (res, code, value) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
async function body(req) {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new Error('Send JSON data.');
  let text = '';
  for await (const chunk of req) { text += chunk; if (Buffer.byteLength(text) > 50000) throw new Error('Request is too large.'); }
  return JSON.parse(text || '{}');
}
export async function createApp({ directory = resolve(root, 'private/web'), bridge: suppliedBridge, geo, port = Number(process.env.PORT || 4317) } = {}) {
  const store = await new Store(directory).load();
  const bridge = suppliedBridge ?? new CodexBridge({ cwd: resolve(directory, 'agent') });
  const service = new StargazerService({ store, bridge, geo });
  const coordination = new Coordination(service);
  const derive = label => createHmac('sha256', store.local.secret).update(label).digest('hex');
  const session = derive('owner'), csrf = derive('csrf');
  await store.persist();
  const assets = new Set(['/','/index.html','/app.js','/shell.js','/fx.js','/planning-time.js','/style.css','/favicon.svg','/outing.js','/outing.css']);
  const server = createServer(async (req, res) => {
    const address = server.address();
    const allowed = [`127.0.0.1:${address.port}`, `localhost:${address.port}`];
    res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    if (!allowed.includes(req.headers.host)) return json(res, 403, { error: 'Use the local Star Gazer address.' });
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (req.headers.origin && !allowed.some(host => req.headers.origin === `http://${host}`)) return json(res,403,{error:'Cross-origin requests are not allowed.'});
    try {
      const ownerCookie = `stargazer_owner_${address.port}`, guestCookie = `stargazer_guest_${address.port}`;
      const cookies = Object.fromEntries((req.headers.cookie || '').split(';').map(c => c.trim().split('=')));
      const owner = equal(cookies[ownerCookie], session);
      const guest = coordination.session(cookies[guestCookie]);
      const page = /^\/outing\/[a-f0-9-]+$/.test(url.pathname) || ['/signin', '/outbox', '/calendar-test'].includes(url.pathname);
      if (req.method === 'GET' && (assets.has(url.pathname) || page)) {
        if (['/','/index.html'].includes(url.pathname)) res.setHeader('Set-Cookie', `${ownerCookie}=${session}; HttpOnly; SameSite=Lax; Path=/`);
        const path = page ? '/outing.html' : url.pathname === '/' ? '/index.html' : url.pathname;
        const file = await readFile(resolve(root,'web/public'+path));
        res.writeHead(200, { 'Content-Type': ({ '.html':'text/html', '.js':'text/javascript', '.css':'text/css', '.svg':'image/svg+xml' })[extname(path)] + '; charset=utf-8', 'Cache-Control':'no-cache' }); return res.end(file);
      }
      const parts = url.pathname.split('/').filter(Boolean);
      if (req.method === 'POST' && parts[1] === 'auth') {
        if (req.headers.origin !== `http://${req.headers.host}`) return json(res,403,{error:'Open the sign-in page to continue.'});
        const data = await body(req);
        if (parts[2] === 'request') return json(res,200,await coordination.requestSignIn(data));
        if (parts[2] === 'confirm') {
          const result = await coordination.signIn(data.token);
          res.setHeader('Set-Cookie', `${guestCookie}=${result.session}; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800`);
          return json(res,200,{outingId:result.outingId});
        }
      }
      if (parts[1] === 'outing') {
        const manager = url.searchParams.get('manage') === '1' && owner;
        if (!guest && !manager) return json(res,401,{error:'Sign in with the email address on your invitation.'});
        const outing = service.outing(parts[2]), c = coordination.init(outing), address = manager ? c.organizerEmail : guest.email;
        if (!manager) coordination.member(outing,address);
        if (req.method === 'GET') return json(res,200,{...coordination.view(outing.id,address,manager),csrf:manager?csrf:guest.csrf});
        if (req.method !== 'POST' || req.headers.origin !== `http://${req.headers.host}` || !equal(req.headers['x-stargazer-csrf'],manager?csrf:guest.csrf)) return json(res,403,{error:'Refresh this page before trying again.'});
        const data = await body(req), action = parts[3];
        if (action === 'respond') return json(res,200,await coordination.respond(outing.id,address,data));
        if (action === 'comment') return json(res,200,await coordination.comment(outing.id,address,data));
        if (address !== c.organizerEmail) return json(res,403,{error:'Only the organizer can change this outing.'});
        if (action === 'preview') return json(res,200,await coordination.preview(outing.id));
        if (action === 'invite') return json(res,200,await coordination.invite(outing.id,data.token));
        if (action === 'recover-calendar') return json(res,200,await coordination.recoverCalendar(outing.id));
        if (action === 'sync') { await coordination.sync(outing.id); return json(res,200,{ok:true}); }
        if (action === 'weather') return json(res,200,await coordination.refreshWeather(outing.id));
        if (action === 'edit') return json(res,200,await coordination.edit(outing.id,data));
        if (action === 'cancel') return json(res,200,await coordination.cancel(outing.id,data));
        return json(res,404,{error:'Not found.'});
      }
      if (!owner) return json(res,401,{error:'Open Star Gazer in this browser first.'});
      if (req.method !== 'GET' && (!equal(req.headers['x-stargazer-csrf'],csrf) || req.headers.origin !== `http://${req.headers.host}`)) return json(res,403,{error:'Refresh the page before trying again.'});
      if (req.method === 'GET' && url.pathname === '/api/state') return json(res,200,{ ...store.state, csrf, connection:{...bridge.status,geoapify:Boolean(process.env.GEOAPIFY_API_KEY)}, jobs:[...service.jobs.values()].map(j=>service.publicJob(j)) });
      if (req.method === 'GET' && url.pathname === '/api/outbox') return json(res,200,{messages:store.local.outbox});
      if (req.method === 'GET' && url.pathname === '/api/geocode') return json(res,200,await service.geocode(url.searchParams.get('q')));
      const path = url.pathname.split('/').filter(Boolean), data = req.method === 'POST' ? await body(req) : {};
      if (req.method === 'POST' && url.pathname === '/api/calendar-test') return json(res,200,await coordination.createTest(data));
      if (req.method === 'POST' && url.pathname === '/api/profiles') return json(res,200,await store.saveProfile(data));
      if (req.method === 'POST' && path[1] === 'profiles' && path[3] === 'delete') { await store.removeProfile(path[2]); return json(res,200,{ok:true}); }
      if (req.method === 'POST' && url.pathname === '/api/match') return json(res,202,service.match(data));
      if (req.method === 'POST' && path[1] === 'jobs' && path[3] === 'cancel') {
        const job=service.jobs.get(path[2]); if(!job) throw new Error('Search not found.'); job.controller.abort(); job.status='cancelled'; return json(res,200,service.publicJob(job));
      }
      if (req.method === 'POST' && path[1] === 'outings') {
        if (path[3] === 'access') return json(res,202,service.confirmAccess(path[2],data));
        if (path[3] === 'preview') return json(res,200,await coordination.preview(path[2]));
        if (path[3] === 'invite') return json(res,200,await coordination.invite(path[2],data.token));
      }
      json(res,404,{error:'Not found.'});
    } catch(error) {
      const message = error.issues ? error.issues.map(i=>`${i.path.join('.')}: ${i.message}`).join('; ') : error.message;
      json(res,400,{error:message});
    }
  });
  await new Promise(resolve => server.listen(port,'127.0.0.1',resolve));
  coordination.baseUrl = `http://127.0.0.1:${server.address().port}`;
  const timer = setInterval(() => coordination.tick().catch(() => {}), 60000); timer.unref();
  if (!suppliedBridge) bridge.connect().catch(() => {});
  return { server, store, service, coordination, bridge, url:coordination.baseUrl, close:()=>{clearInterval(timer);bridge.close?.();server.close();store.close();} };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const app = await createApp();
  console.log(`Star Gazer is ready at ${app.url}`);
  console.log('Local profiles stay in private/web. Codex and Calendar connect in the background.');
  for (const signal of ['SIGINT','SIGTERM']) process.on(signal,()=>{app.close();process.exit(0);});
}
