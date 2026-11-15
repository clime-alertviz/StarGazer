import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { z } from 'zod';
import { fetchForecast, assessWeather } from '../../src/weather.js';
import { location, instant } from '../../src/schema.js';

const hash = value => createHash('sha256').update(value).digest('hex');
const email = value => z.email().max(254).parse(value).toLowerCase();
const stamp = () => new Date().toISOString();
const terminal = new Set(['cancelled', 'completed', 'not_formed']);
const labels = { draft: 'Draft', invited: 'Awaiting responses', confirmed: 'Confirmed', needs_review: 'Plan needs review', not_formed: 'Didn’t come together', cancelled: 'Cancelled', completed: 'Completed' };

// Coordination is deterministic. The agent proposes plans; it cannot accept for guests.
export class Coordination {
  constructor(service, { forecast = fetchForecast } = {}) {
    this.service = service; this.store = service.store; this.bridge = service.bridge; this.forecast = forecast;
    this.baseUrl = 'http://127.0.0.1:4317'; this.locks = new Map(); service.coordination = this;
  }
  async exclusive(id, action) {
    const previous = this.locks.get(id) || Promise.resolve();
    const next = previous.catch(() => {}).then(action);
    this.locks.set(id, next);
    try { return await next; } finally { if (this.locks.get(id) === next) this.locks.delete(id); }
  }
  link(outing) { return `${this.baseUrl}/outing/${outing.id}`; }
  init(outing) {
    if (outing.coordination) return outing.coordination;
    const p = outing.plan;
    if (!['proposal', 'calendar_test'].includes(p.status)) throw new Error('Finish checking this proposal before opening invitations.');
    const organizer = p.participants.find(person => person.id === p.request.organizerId);
    const c = outing.coordination = {
      revision: 1, status: 'draft', organizerEmail: email(organizer.email), comments: [], admitted: [],
      // Connection tests can start in a few minutes; real trips need a travel buffer.
      deadline: new Date(Date.parse(p.meetingStart) - (p.mode === 'calendar_test' ? 0 : 30 * 60000)).toISOString(),
      people: p.participants.map(person => ({
        id: person.id, name: person.name, email: email(person.email),
        channel: this.store.state.profiles.find(entry => entry.profile.id === person.id)?.invitationChannel || 'email',
        response: person.id === p.request.organizerId ? 'accepted' : 'pending',
        revision: 1, source: person.id === p.request.organizerId ? 'organizer' : null,
        calendarStatus: 'needsAction', observedAt: null, conflict: null,
      })),
    };
    return c;
  }
  mail(to, subject, text, { key, link } = {}) {
    const box = this.store.local.outbox;
    if (key && box.some(m => m.key === key)) return;
    box.unshift({ id: randomUUID(), to, subject, text, link, key, createdAt: stamp(), delivery: 'local_only' });
  }
  async requestSignIn(raw) {
    const address = email(raw.email), outing = this.service.outing(raw.outingId), c = this.init(outing);
    // Same response for unknown addresses; no account enumeration.
    if (c.people.some(p => p.email === address) && c.status !== 'draft') {
      this.store.local.tokens = this.store.local.tokens.filter(t => t.expires > Date.now());
      if (this.store.local.tokens.filter(t => t.email === address && t.created > Date.now() - 60000).length >= 3) return { message: 'If this address is invited, its sign-in link is in the local outbox.' };
      const token = randomBytes(32).toString('hex');
      this.store.local.tokens.push({ hash: hash(token), email: address, outingId: outing.id, expires: Date.now() + 15 * 60000, created: Date.now() });
      this.mail(address, 'Your Star Gazer sign-in link', 'Open the link, then click Continue to sign in. This link expires in 15 minutes. Opening it alone does not use it.', { link: `${this.baseUrl}/signin#${token}` });
      await this.store.persist();
    }
    return { message: 'If this address is invited, its sign-in link is in the local outbox.' };
  }
  async signIn(token) {
    z.string().regex(/^[a-f0-9]{64}$/).parse(token);
    const record = this.store.local.tokens.find(t => t.hash === hash(token) && t.expires > Date.now());
    if (!record) throw new Error('This sign-in link has expired or was already used. Request another.');
    this.store.local.tokens = this.store.local.tokens.filter(t => t !== record);
    if (!this.store.local.accounts.some(a => a.email === record.email)) this.store.local.accounts.push({ email: record.email, createdAt: stamp() });
    const session = randomBytes(32).toString('hex'), csrf = randomBytes(32).toString('hex');
    this.store.local.sessions = this.store.local.sessions.filter(s => s.expires > Date.now());
    this.store.local.sessions.push({ hash: hash(session), email: record.email, csrf, expires: Date.now() + 7 * 86400000 });
    await this.store.persist();
    return { session, outingId: record.outingId };
  }
  session(token) { return token && this.store.local.sessions.find(s => s.hash === hash(token) && s.expires > Date.now()); }
  member(outing, address) {
    const c = this.init(outing), person = c.people.find(p => p.email === address);
    if (!person || c.status === 'draft') throw new Error('This account is not invited to this outing.');
    return person;
  }
  view(id, address, manager = false) {
    const outing = this.service.outing(id), c = this.init(outing);
    if (!manager) this.member(outing, address);
    const p = outing.plan;
    // Never expose profile origins, availability, private email addresses, or login tokens to other guests.
    return {
      id, url: this.link(outing), test: p.mode === 'calendar_test', demo: p.mode === 'demo', title: p.mode === 'calendar_test' ? 'Calendar connection test' : `${p.request.target} at ${p.site.name}`,
      start: p.meetingStart, end: p.meetingEnd, observingStart: p.observingStart, observingEnd: p.observingEnd, timezone: p.request.timezone, site: p.site,
      equipment: p.equipment || [], astronomy: p.astronomy, target: p.request.target, weather: c.weather || p.weather, weatherError: c.weatherError,
      carpools: p.carpools || [], revision: c.revision, status: c.status, statusLabel: labels[c.status],
      deadline: c.deadline, minPeople: p.request.minPeople, maxPeople: p.request.maxPeople,
      organizer: manager || address === c.organizerEmail, viewerId: c.people.find(a => a.email === (manager ? c.organizerEmail : address))?.id,
      people: c.people.map(({ email: address, ...person }) => ({ ...person, ...(manager ? { email: address } : {}),
        place: terminal.has(c.status) ? null : person.place, organizer: person.id === p.request.organizerId,
        roles: [p.participants.find(p => p.id === person.id)?.transport === 'drive' ? 'Driver' : null,
          p.participants.find(p => p.id === person.id)?.equipment?.includes('telescope') ? 'Telescope' : null].filter(Boolean),
      })),
      comments: c.comments.map(({ authorEmail, ...comment }) => comment), reasons: c.reasons || [],
      calendar: { eventId: outing.invitation?.eventId, url: outing.invitation?.url, checkedAt: c.checkedAt, error: c.calendarError, delivery: c.calendarDelivery },
      emailDelivery: 'local_outbox',
    };
  }
  decorate(outing, draft) {
    const c = this.init(outing), args = structuredClone(draft.arguments);
    args.attendees = c.people.filter(p => p.channel === 'calendar' && p.email !== c.organizerEmail).map(p => p.email);
    args.title = `[${labels[c.status === 'draft' ? 'invited' : c.status]}] ${args.title}`;
    args.description = `${args.description.replace('Please RSVP in Google Calendar.', 'Respond in Calendar or on the outing page.')}` +
      `\n\nOuting page: ${this.link(outing)}\nLocal test: open this link on the computer running Star Gazer.\nPlan revision ${c.revision}. After a time or place change, reconfirm on this page; a previous Calendar Yes is not reconfirmation.\nResponse deadline: ${c.deadline}`;
    return { ...draft, arguments: args, emailRecipients: c.people.filter(p => p.channel === 'email' && p.email !== c.organizerEmail).map(p => p.email), emailDelivery: 'local_outbox' };
  }
  testDraft(outing) {
    const p = outing.plan;
    return { status: 'ready_for_organizer', planId: p.planId, arguments: {
      calendar_id: 'primary', title: 'Star Gazer · Calendar connection test',
      start_time: p.meetingStart, end_time: p.meetingEnd, timezone_str: p.request.timezone,
      attendees: [], location: 'Local software test — no physical meeting',
      description: `Star Gazer plan: ${p.planId}\nTEST ONLY. No real stargazing outing is planned. Please try Accept or Decline, then check the outing page. No forecast or travel claims apply.`,
      notify: true, visibility: 'private', guests_can_modify: false, add_google_meet: false,
    } };
  }
  async createTest(raw) {
    const data = z.object({ guest: z.email(), start: instant, timezone: z.string().default(Intl.DateTimeFormat().resolvedOptions().timeZone), channel: z.enum(['calendar', 'email']).default('calendar') }).strict().parse(raw);
    new Intl.DateTimeFormat('en', { timeZone: data.timezone }).format();
    if (Date.parse(data.start) < Date.now() + 5 * 60000) throw new Error('Choose a test time at least five minutes ahead.');
    const owner = await this.bridge.calendar('get_profile', {}), address = email(owner.email);
    if (address === email(data.guest)) throw new Error('Use a second account for the guest response test.');
    const end = new Date(Date.parse(data.start) + 30 * 60000).toISOString();
    const plan = { mode: 'calendar_test', status: 'calendar_test', planId: randomUUID(), createdAt: stamp(),
      meetingStart: data.start, meetingEnd: end, observingStart: data.start, observingEnd: end,
      request: { organizerId: 'organizer', timezone: data.timezone, minPeople: 2, maxPeople: 2, target: 'stargazing' },
      participants: [{ id: 'organizer', name: 'Organizer', email: address, transport: 'walk', equipment: [] }, { id: 'guest', name: data.guest.split('@')[0], email: email(data.guest), transport: 'walk', equipment: [] }],
      routes: [{ participantId: 'organizer', departAt: data.start, homeBy: end }], carpools: [], equipment: [],
      site: { name: 'Local connection test', location: { lat: 50.0755, lon: 14.4378 }, meetingPoint: { lat: 50.0755, lon: 14.4378 } },
    };
    const outing = await this.store.addOuting(plan, null, 'Calendar test only. No real outing.');
    this.init(outing).people.find(p => p.id === 'guest').channel = data.channel;
    await this.store.persist(); return { id: outing.id, url: this.link(outing) + '?manage=1' };
  }
  async preview(id) { this.init(this.service.outing(id)); await this.store.persist(); return this.service.previewInvitation(id); }
  async invite(id, token) {
    return this.exclusive(id, async () => {
      const outing = this.service.outing(id), c = this.init(outing);
      if (c.status === 'draft' && !outing.invitation && Date.parse(c.deadline) <= Date.now()) throw new Error('The response deadline has passed. Create a fresh plan.');
      const result = await this.service.sendInvitation(id, token);
      if (c.status === 'draft') {
        c.status = 'invited';
        for (const p of c.people.filter(p => p.channel === 'email' && p.email !== c.organizerEmail)) this.mail(p.email, 'You’re invited · Star Gazer', `Review this provisional outing and respond on its page. Reply by ${c.deadline}.`, { key: `${id}:invite:${p.id}`, link: this.link(outing) });
        await this.settle(outing);
      }
      await this.store.persist(); return result;
    });
  }
  evaluate(outing, now = Date.now()) {
    const c = this.init(outing), plan = outing.plan;
    if (c.status === 'draft' || terminal.has(c.status)) return;
    const accepted = c.people.filter(p => p.response === 'accepted' && p.revision === c.revision);
    const acceptedIds = new Set(accepted.map(p => p.id));
    const prior = new Set(c.admitted), possible = [];
    for (const person of c.people) {
      person.place = person.response === 'accepted' ? 'unresolved' : null;
      delete person.reason;
    }
    for (const person of accepted.sort((a, b) => Number(prior.has(b.id)) - Number(prior.has(a.id)))) {
      const car = (plan.carpools || []).find(car => car.passengerIds.includes(person.id));
      if (car && !acceptedIds.has(car.driverId)) { person.reason = 'Waiting for your driver to accept this plan.'; continue; }
      if (possible.length >= plan.request.maxPeople) { person.place = 'waitlist'; person.reason = 'The group is full.'; continue; }
      delete person.reason; person.place = 'awaiting_group'; possible.push(person);
    }
    const ids = new Set(possible.map(p => p.id)), members = plan.participants.filter(p => ids.has(p.id));
    const reasons = [];
    if (!ids.has(plan.request.organizerId)) reasons.push('The organizer must accept the current plan.');
    if (possible.length < plan.request.minPeople) reasons.push(`Waiting for at least ${plan.request.minPeople} people to accept.`);
    if (members.some(p => p.groupSize && (members.length < p.groupSize.min || members.length > p.groupSize.max))) reasons.push('The accepted group does not meet everyone’s group-size limits.');
    if (!['stargazing', 'Moon'].includes(plan.request.target) && !members.some(p => p.shareEquipment && p.equipment.includes('telescope')) && !members.every(p => p.equipment.includes('telescope'))) reasons.push('A required telescope is not confirmed.');
    if (plan.request.needsGuide && !members.some(p => p.experience === 'experienced' && p.happyToTeach)) reasons.push('A guide is not confirmed.');
    if (c.weather?.suitable === false) reasons.push('The refreshed forecast does not meet the planning limits.');
    // Losing an admitted person’s ride is a group problem; a new unresolved joiner is not.
    if (accepted.some(p => prior.has(p.id) && !ids.has(p.id))) reasons.push('An existing participant’s transport needs review.');
    c.reasons = reasons;
    if (!reasons.length) { c.status = 'confirmed'; c.admitted = [...ids]; possible.forEach(p => { p.place = 'confirmed'; }); c.everConfirmed = true; }
    else c.status = c.everConfirmed || c.revision > 1 ? 'needs_review' : 'invited';
    if (now >= Date.parse(c.deadline) && c.status !== 'confirmed' && !c.everConfirmed) c.status = 'not_formed';
    if (now >= Date.parse(plan.meetingEnd)) c.status = c.everConfirmed ? 'completed' : 'not_formed';
  }
  async settle(outing) {
    const c = this.init(outing), before = c.status;
    this.evaluate(outing); await this.store.persist();
    if (before !== c.status && c.status === 'confirmed' && !c.confirmationNotified) {
      c.confirmationNotified = true;
      await this.notifyPlan(outing, 'Outing confirmed');
    } else if (before !== c.status && c.status === 'needs_review') {
      this.mail(c.organizerEmail, 'Plan needs review · Star Gazer', c.reasons.join(' '), { link: this.link(outing) });
      await this.store.persist();
    }
  }
  async respond(id, address, raw) {
    return this.exclusive(id, async () => {
      const data = z.object({ response: z.enum(['accepted', 'declined', 'tentative']), revision: z.number().int() }).strict().parse(raw);
      const outing = this.service.outing(id), c = this.init(outing), person = this.member(outing, address);
      this.evaluate(outing);
      if (terminal.has(c.status)) throw new Error('This outing is closed.');
      if (data.revision !== c.revision) throw new Error('The plan changed. Refresh and review before responding.');
      if (person.response === data.response && person.revision === c.revision && person.source === 'app' && !person.conflict) return this.view(id, address);
      if (Date.now() >= Date.parse(c.deadline) && !c.everConfirmed) { await this.settle(outing); if (terminal.has(c.status)) throw new Error('The response deadline has passed.'); }
      Object.assign(person, { response: data.response, revision: c.revision, source: 'app', answeredAt: stamp(), conflict: null });
      if (address !== c.organizerEmail) this.mail(c.organizerEmail, `${person.name} · ${data.response}`, 'Their response is recorded on the outing page.', { link: this.link(outing) });
      await this.settle(outing); return this.view(id, address);
    });
  }
  async sync(id) {
    const outing = this.service.outing(id), c = this.init(outing);
    if (!outing.invitation?.eventId || terminal.has(c.status)) return;
    const revision = c.revision, startedAt = Date.now();
    let event;
    try { event = await this.bridge.calendar('read_event', { calendar_id: 'primary', event_id: outing.invitation.eventId }); }
    catch (error) { c.calendarError = error.message; await this.store.persist(); throw error; }
    return this.exclusive(id, async () => {
      if (revision !== c.revision || terminal.has(c.status)) return;
      try {
        if (!Array.isArray(event.attendees)) throw new Error('Calendar did not provide attendee responses.');
        for (const guest of event.attendees) {
          const person = c.people.find(p => p.email === guest.email?.toLowerCase() && p.email !== c.organizerEmail && p.channel === 'calendar');
          const status = guest.responseStatus ?? guest.response_status;
          if (!person || !['accepted', 'declined', 'tentative', 'needsAction'].includes(status)) continue;
          if (status === person.calendarStatus) continue;
          person.calendarStatus = status; person.observedAt = stamp();
          if (c.revision > 1 || person.source === 'app' || Date.parse(person.answeredAt) > startedAt) {
            // Google has no per-attendee response timestamp; an observed change cannot prove ordering or reconfirmation.
            if (status !== person.response) person.conflict = `Calendar shows ${status}. Confirm your choice on this page.`;
            continue;
          }
          person.response = status === 'needsAction' ? 'pending' : status; person.source = 'calendar'; person.revision = c.revision;
          this.mail(c.organizerEmail, `${person.name} · ${person.response}`, 'Calendar response observed. See the outing page.', { link: this.link(outing) });
        }
        c.checkedAt = stamp(); c.calendarError = null;
        await this.settle(outing);
      } catch (error) { c.calendarError = error.message; await this.store.persist(); throw error; }
    });
  }
  async notifyPlan(outing, message) {
    const c = this.init(outing);
    for (const person of c.people.filter(p => p.channel === 'email' && p.response !== 'declined' && p.email !== c.organizerEmail)) {
      this.mail(person.email, `${message} · Star Gazer`, `Plan revision ${c.revision}. ${c.cancelReason || ''} Review the current plan on the outing page.`, { link: this.link(outing) });
    }
    if (!outing.invitation?.eventId) { await this.store.persist(); return; }
    if (['sending', 'uncertain'].includes(c.calendarDelivery) && c.status !== 'cancelled') { c.calendarError = 'A Calendar update has an uncertain result. Check Calendar before sending another update.'; await this.store.persist(); return; }
    // Persist intent first. On ambiguous failure, never retry a notification automatically.
    c.calendarDelivery = 'sending'; await this.store.persist();
    try {
      if (c.status === 'cancelled') {
        await this.bridge.calendar('delete_event', { calendar_id: 'primary', event_id: outing.invitation.eventId, notify: true });
        c.calendarDelivery = 'sent'; c.calendarError = null; await this.store.persist(); return;
      }
      await this.bridge.calendar('read_event', { calendar_id: 'primary', event_id: outing.invitation.eventId });
      const draft = this.service.invitationDraft(outing, { allowOld: true }).arguments;
      await this.bridge.calendar('update_event', { calendar_id: 'primary', event_id: outing.invitation.eventId,
        title: draft.title, description: draft.description + `\n${message}\n${c.cancelReason || ''}`,
        start_time: draft.start_time, end_time: draft.end_time, timezone_str: draft.timezone_str, location: draft.location,
        ...(terminal.has(c.status) ? { transparency: 'transparent' } : {}), notify: true });
      c.calendarDelivery = 'sent'; c.calendarError = null;
    } catch (error) { c.calendarDelivery = 'uncertain'; c.calendarError = `${error.message} The app change is saved; check the existing Calendar event before retrying.`; }
    await this.store.persist();
  }
  async recoverCalendar(id) {
    const outing = this.service.outing(id), c = this.init(outing);
    if (!outing.invitation?.eventId) throw new Error('There is no linked Calendar event.');
    await this.bridge.calendar('read_event', { calendar_id: 'primary', event_id: outing.invitation.eventId });
    c.calendarDelivery = 'ready'; await this.store.persist();
    await this.notifyPlan(outing, 'Current outing details');
    return this.view(id, c.organizerEmail, true);
  }
  async comment(id, address, raw) {
    return this.exclusive(id, async () => {
      const data = z.object({ text: z.string().trim().min(1).max(2000), replyTo: z.string().optional() }).strict().parse(raw);
      const outing = this.service.outing(id), c = this.init(outing), person = this.member(outing, address);
      const parent = data.replyTo && c.comments.find(c => c.id === data.replyTo);
      if (data.replyTo && !parent) throw new Error('That comment no longer exists.');
      const comment = { id: randomUUID(), text: data.text, replyTo: data.replyTo, authorEmail: address, authorId: person.id, authorName: person.name, createdAt: stamp() };
      c.comments.push(comment);
      for (const to of new Set([c.organizerEmail, parent?.authorEmail].filter(to => to && to !== address))) this.mail(to, `${person.name} commented · Star Gazer`, data.text, { link: this.link(outing) });
      await this.store.persist(); return comment;
    });
  }
  async refreshWeather(id) {
    return this.exclusive(id, async () => {
      const outing = this.service.outing(id), c = this.init(outing), p = outing.plan;
      if (p.mode !== 'live') throw new Error('Weather refresh is available for real outings. Tests and demos have no live forecast.');
      try {
        const forecast = await this.forecast(p.site.location);
        const weather = assessWeather(forecast, Date.parse(p.observingStart), Date.parse(p.observingEnd), p.request);
        if (weather.reason === 'missing_weather') throw new Error('The provider has no complete forecast for this observing window. The last forecast is retained.');
        c.weather = weather; c.weatherError = null; await this.settle(outing);
      } catch (error) { c.weatherError = { message: error.message, at: stamp() }; await this.store.persist(); throw error; }
      return this.view(id, c.organizerEmail, true);
    });
  }
  async cancel(id, raw) {
    return this.exclusive(id, async () => {
      const reason = z.string().trim().min(1).max(1000).parse(raw.reason);
      const outing = this.service.outing(id), c = this.init(outing);
      if (terminal.has(c.status)) throw new Error('This outing is already closed.');
      c.status = 'cancelled'; c.cancelReason = reason; c.reasons = [reason]; await this.store.persist();
      await this.notifyPlan(outing, `Cancelled: ${reason}`); return this.view(id, c.organizerEmail, true);
    });
  }
  async edit(id, raw) {
    return this.exclusive(id, async () => {
      const data = z.object({ start: instant, end: instant, siteName: z.string().min(1).max(120), location, meetingPoint: location, accessNote: z.string().min(10).max(1000), walkMinutes: z.number().int().min(0).max(120), deadline: instant }).strict().parse(raw);
      const outing = this.service.outing(id), c = this.init(outing), old = outing.plan;
      if (terminal.has(c.status) || c.status === 'draft') throw new Error('Only an open invited outing can be edited.');
      if (Date.parse(data.start) <= Date.now() || Date.parse(data.end) <= Date.parse(data.start) || Date.parse(data.deadline) <= Date.now() || Date.parse(data.deadline) >= Date.parse(data.start)) throw new Error('Use future times, an end after the start, and a response deadline before the outing.');
      if (old.mode === 'calendar_test') {
        outing.plan = { ...old, meetingStart: data.start, meetingEnd: data.end, observingStart: data.start, observingEnd: data.end };
      } else {
        // Treat entered times as the observing window. Revalidate weather, sky, access, equipment and full journeys.
        const input = structuredClone(outing.input);
        input.request = { ...input.request, start: data.start, end: data.end, durationMinutes: Math.min(old.request.durationMinutes || 60, Math.round((Date.parse(data.end) - Date.parse(data.start)) / 60000)), minPeople: c.people.filter(p => p.response !== 'declined').length, maxPeople: c.people.filter(p => p.response !== 'declined').length };
        input.participants = structuredClone(old.participants.filter(p => c.people.some(member => member.id === p.id && member.response !== 'declined')));
        input.sites = [{ ...old.site, name: data.siteName, location: data.location, meetingPoint: data.meetingPoint, walkMinutes: data.walkMinutes, access: 'confirmed', accessNote: data.accessNote }];
        const plan = await this.service.planner(input, { geo: this.service.geo });
        if (plan.status !== 'proposal') throw new Error('This revision does not fit the participants, access hours, routes or conditions. Nothing was changed.');
        outing.plan = { ...plan, request: { ...plan.request, minPeople: old.request.minPeople, maxPeople: old.request.maxPeople }, planId: old.planId, mode: old.mode };
        outing.input = input;
      }
      c.revision++; c.deadline = data.deadline; c.status = 'needs_review'; c.weather = null; c.weatherError = null;
      c.reasons = ['The time or place changed. Everyone must respond on this page again.'];
      for (const person of c.people) { person.conflict = null; if (person.response !== 'declined') { person.response = 'pending'; person.place = null; } }
      await this.store.persist(); await this.notifyPlan(outing, 'Plan changed — please reconfirm on the outing page');
      return this.view(id, c.organizerEmail, true);
    });
  }
  async tick() {
    for (const outing of this.store.state.outings) {
      const c = outing.coordination;
      if (!c || c.status === 'draft' || terminal.has(c.status) || this.locks.has(outing.id)) continue;
      if (outing.invitation?.eventId) await this.sync(outing.id).catch(() => {});
      if (!this.locks.has(outing.id)) await this.exclusive(outing.id, () => this.settle(outing));
    }
  }
}
