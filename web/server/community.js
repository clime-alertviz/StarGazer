import { randomUUID } from "node:crypto";
import { z } from "zod";
import { Geoapify } from "../../src/geoapify.js";
import { assessSky } from "../../src/astronomy.js";
import { fetchForecast, assessWeather } from "../../src/weather.js";
import { SolverBackends } from "./solvers/index.js";
import { PlanningJobs } from "./solvers/jobs.js";
import { ConnectorDelivery } from "./connector-delivery.js";
import { ClientPlanning } from "./solvers/sessions.js";
import { planningWindowProblem } from "../../src/planning-window.js";
import { equipmentList } from "./outing-details.js";
import {
  createTransport,
  describeTransport,
  journeyFits,
} from "../../src/transport.js";
import {
  site as siteSchema,
  target,
  instant,
  location,
  request as requestSchema,
} from "../../src/schema.js";
import {
  preferencesSchema,
  profileSchema,
  discoveryPreferencesSchema,
  plannerPerson,
  expandSlots,
} from "./availability.js";
import { Addresses } from "./addresses.js";
import { prepareJoin, joinDetailsSchema, meetingTimes } from "./join.js";
import { Traffic } from "./traffic.js";
import { Identity } from "./identity.js";
import { Providers, digest } from "./providers.js";

const iso = () => new Date().toISOString();
const closed = new Set(["cancelled", "completed", "not_formed"]);
const active = (p) =>
  !["declined", "expired", "withdrawn"].includes(p.response);
const labels = {
  draft: "Draft",
  invited: "Gathering your group",
  confirmed: "Confirmed",
  needs_review: "Plan needs review",
  cancelled: "Cancelled",
  completed: "Completed",
  not_formed: "Didn’t come together",
};
const idSchema = z.string().max(100);
const outline = z
  .object({
    target,
    solver: z.enum(["codex", "deterministic"]).optional(),
    start: instant,
    end: instant,
    durationMinutes: z.number().int().min(30).max(180).default(60),
    minPeople: z.number().int().min(1).max(8).default(2),
    maxPeople: z.number().int().min(1).max(8).default(4),
    visibility: z.enum(["circle", "open"]).default("open"),
    needsGuide: z.boolean().default(false),
    site: siteSchema.optional(),
    participantIds: z.array(idSchema).max(7).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const problem = planningWindowProblem(value, {
      preparation: true,
    });
    if (problem)
      context.addIssue({
        code: "custom",
        path: [problem.field],
        message: problem.message,
      });
  });

export class Community {
  constructor(store, options = {}) {
    this.store = store;
    this.data = store.community;
    this.geo = options.geo || new Geoapify();
    this.forecast = options.forecast || fetchForecast;
    this.addresses = new Addresses(this.geo);
    this.trafficReports = new Traffic(this.geo);
    this.providers = options.providers || new Providers(store);
    this.solvers =
      options.solvers ||
      new SolverBackends({
        directory: store.directory || "private/web",
        defaultBackend: options.solver,
      });
    this.planningJobs = new PlanningJobs(this);
    this.clientPlanning = new ClientPlanning(this);
    this.connectorDelivery = new ConnectorDelivery(this);
    this.queues = new Map();
    this.deliveryRuns = new Map();
    this.baseUrl = "";
    this.identity = new Identity(store, (message) => this.mail(message));
    for (const m of this.data.messages)
      if (m.delivery === "sending") m.delivery = "uncertain";
    for (const o of this.data.outings)
      if (o.calendar?.state === "sending") o.calendar.state = "uncertain";
  }
  setBase(url) {
    this.baseUrl = url;
    this.identity.baseUrl = url;
    this.providers.baseUrl = url;
  }
  user(id) {
    const u = this.data.users.find((u) => u.id === id);
    if (!u) throw new Error("Sign in to continue.");
    return u;
  }
  outing(id) {
    const o = this.data.outings.find((o) => o.id === id);
    if (!o) throw new Error("Outing not found.");
    return o;
  }
  owner(o, id) {
    if (o.organizerId !== id)
      throw new Error("Only the organizer can change this outing.");
  }
  friends(id) {
    return this.data.connections
      .filter((c) => c.status === "accepted" && [c.from, c.to].includes(id))
      .map((c) => (c.from === id ? c.to : c.from));
  }
  canSee(o, id) {
    return (
      o.organizerId === id ||
      (!o.unpublished &&
        o.status !== "draft" &&
        o.people.some((p) => p.userId === id)) ||
      (!o.unpublished &&
        o.status !== "draft" &&
        (o.visibility === "open" ||
          this.friends(o.organizerId).includes(id)))
    );
  }
  async lock(id, action) {
    const next = (this.queues.get(id) || Promise.resolve())
      .catch(() => {})
      .then(action);
    this.queues.set(id, next);
    try {
      return await next;
    } finally {
      if (this.queues.get(id) === next) this.queues.delete(id);
    }
  }
  mail(message) {
    if (
      message.key &&
      this.data.messages.some((m) => m.key === message.key)
    )
      return;
    const outing = this.data.outings.find(
      (o) => message.link === `${this.baseUrl}/outing/${o.id}`,
    );
    const record = {
      id: randomUUID(),
      createdAt: iso(),
      delivery: "queued",
      ...message,
      ...(outing ? { outingId: outing.id } : {}),
    };
    if (
      outing?.deliveryMode === "codex" &&
      message.senderId === outing.organizerId
    )
      record.delivery = "codex_pending";
    this.data.messages.unshift(record);
    return record;
  }
  notice(o, person, subject, text, key) {
    const user = this.user(person.userId);
    if (person.channel !== "calendar")
      this.mail({
        to: user.email,
        recipientId: user.id,
        senderId: o.organizerId,
        subject,
        text,
        key,
        link: `${this.baseUrl}/outing/${o.id}`,
      });
  }
  organizerNotice(o, subject, text) {
    this.mail({
      to: this.user(o.organizerId).email,
      recipientId: o.organizerId,
      senderId: o.organizerId,
      subject,
      text,
      link: `${this.baseUrl}/outing/${o.id}`,
    });
  }
  audit(userId, operation, result) {
    this.data.audit.push({ at: iso(), userId, operation, result });
    if (this.data.audit.length > 1000) this.data.audit.shift();
  }
  publicPerson(user) {
    return {
      id: user.id,
      name: user.preferences?.name || user.email.split("@")[0],
      avatar: user.preferences?.avatar || "star",
      experience: user.preferences?.experience,
      equipment: user.preferences?.equipment || [],
      interests: user.preferences?.interests || [],
      interestNote: user.preferences?.interestNote || "",
    };
  }
  state(id) {
    const user = this.user(id);
    return {
      user: {
        id: user.id,
        email: user.email,
        preferences: user.preferences,
      },
      solver: this.solvers.status(),
      planningWindows:
        user.preferences?.slots?.length && user.preferences?.timezone
          ? expandSlots(
              user.preferences.slots,
              user.preferences.timezone,
              iso(),
              new Date(Date.now() + 14 * 86400000).toISOString(),
            )
          : [],
      circle: this.friends(id).map((i) => this.publicPerson(this.user(i))),
      circleInvitations: this.data.connections
        .filter(
          (c) => [c.from, c.to].includes(id) && c.status === "pending",
        )
        .map((c) => ({
          id: c.id,
          incoming: c.to === id,
          person: this.publicPerson(
            this.user(c.from === id ? c.to : c.from),
          ),
        })),
      outings: this.data.outings
        .filter(
          (o) =>
            this.canSee(o, id) &&
            (o.organizerId === id || o.people.some((p) => p.userId === id)),
        )
        .map((o) => this.view(o.id, id)),
      providers: this.providers.status(id),
    };
  }
  async saveProfile(id, raw) {
    const p = profileSchema.parse(raw);
    if (p.slots?.length && p.timezone)
      expandSlots(
        p.slots,
        p.timezone,
        new Date().toISOString(),
        new Date(Date.now() + 30 * 86400000).toISOString(),
      );
    this.user(id).preferences = p;
    await this.store.persist();
    return { saved: true, preferences: p };
  }
  async autocomplete(id, raw) {
    this.user(id);
    return this.addresses.search(raw);
  }
  async nearby(id, point) {
    this.user(id);
    return this.addresses.nearby(point);
  }
  async circleInvite(id, raw) {
    if (
      raw.userId &&
      !this.data.outings.some(
        (o) =>
          o.people.some((p) => p.userId === id) &&
          o.people.some((p) => p.userId === raw.userId),
      )
    )
      throw new Error(
        "You can invite a person from a shared outing, or enter their email.",
      );
    const address = raw.userId
        ? this.user(raw.userId).email
        : z.email().max(254).parse(raw.email).toLowerCase(),
      from = this.user(id),
      to = this.identity.user(address);
    if (from.id === to.id)
      throw new Error("That is your own email address.");
    if (this.friends(id).includes(to.id)) return { status: "accepted" };
    let invitation = this.data.connections.find(
      (c) =>
        c.status === "pending" &&
        [c.from, c.to].includes(id) &&
        [c.from, c.to].includes(to.id),
    );
    if (!invitation) {
      invitation = {
        id: randomUUID(),
        from: id,
        to: to.id,
        status: "pending",
        createdAt: iso(),
      };
      this.data.connections.push(invitation);
      this.mail({
        to: address,
        recipientId: to.id,
        senderId: id,
        subject: `${this.publicPerson(from).name} invited you to their circle`,
        text: "Accept or decline in Star Gazer. Joining a circle is separate from joining an outing.",
        link: `${this.baseUrl}/?view=circle`,
      });
    }
    await this.store.persist();
    return { id: invitation.id, status: invitation.status };
  }
  async circleRespond(id, raw) {
    const { invitationId, accept } = z
      .object({ invitationId: idSchema, accept: z.boolean() })
      .strict()
      .parse(raw);
    const c = this.data.connections.find(
      (c) => c.id === invitationId && c.to === id && c.status === "pending",
    );
    if (!c) throw new Error("Circle invitation not found.");
    c.status = accept ? "accepted" : "declined";
    await this.store.persist();
    return { status: c.status };
  }
  capacity(o) {
    return o.people.filter(
      (p) =>
        p.userId === o.organizerId ||
        (active(p) &&
          (!["pending", "tentative"].includes(p.response) ||
            !p.reservedUntil ||
            Date.parse(p.reservedUntil) > Date.now())),
    ).length;
  }
  driverPlace(o) {
    return o.pendingTransport?.length && this.capacity(o) < o.maxPeople
      ? 1
      : 0;
  }
  openPlaces(o) {
    return Math.max(
      0,
      o.maxPeople - this.capacity(o) - this.driverPlace(o),
    );
  }
  joinable(o) {
    return (
      !o.unpublished &&
      !o.migrationPaused &&
      o.status !== "draft" &&
      !closed.has(o.status) &&
      Date.parse(o.start) > Date.now() &&
      o.weather?.suitable !== false &&
      o.astronomy?.suitable !== false &&
      this.capacity(o) < o.maxPeople
    );
  }
  requireCalendar(o, people) {
    if (o.deliveryMode === "codex") return;
    if (
      people.some(
        (p) =>
          p.channel === "calendar" &&
          p.userId !== o.organizerId &&
          active(p),
      ) &&
      !this.providers.status(o.organizerId).googleConnected
    )
      throw new Error(
        "The organizer must connect Google in Settings before Calendar invitations can be sent. Choose email or connect Google first.",
      );
  }
  reservationEnd(o, now = Date.now()) {
    // An accepted guest changing to Maybe keeps their place until departure,
    // even when the original invitation deadline has already passed.
    return new Date(
      Math.min(
        now + (o.invitationHoldHours || 24) * 3600000,
        Date.parse(o.deadline) > now
          ? Date.parse(o.deadline)
          : Date.parse(o.start),
      ),
    ).toISOString();
  }
  releaseBrokenRides(o) {
    const ids = new Set(o.people.filter(active).map((p) => p.userId));
    const broken = (o.carpools || []).filter((c) => !ids.has(c.driverId));
    if (!broken.length) return;
    const waiting = new Set(
      (o.pendingTransport || []).filter((id) => ids.has(id)),
    );
    for (const car of broken)
      for (const uid of car.passengerIds)
        if (ids.has(uid)) {
          waiting.add(uid);
          const p = o.people.find((p) => p.userId === uid);
          p.conflict =
            "Your driver is no longer attending. A replacement lift needs your confirmation.";
        }
    o.pendingTransport = [...waiting];
    o.carpools = o.carpools.filter((c) => ids.has(c.driverId));
    o.routes = (o.routes || []).filter(
      (r) => ids.has(r.participantId) && !waiting.has(r.participantId),
    );
    o.version++;
  }
  journeySignature(o, uid) {
    const r = (o.routes || []).find((r) => r.participantId === uid);
    const cars = (o.carpools || []).filter(
      (c) => c.driverId === uid || c.passengerIds.includes(uid),
    );
    return JSON.stringify([
      r && [r.mode, r.departAt, r.homeBy, r.meetAt, r.leaveAt],
      cars.map((c) => [
        c.driverId,
        c.driverId === uid ? c.passengerIds : [],
        c.pickups
          .filter((p) => c.driverId === uid || p.participantId === uid)
          .map((p) => [
            p.participantId,
            p.pickup.location,
            p.pickupAt,
            p.dropoffAt,
          ]),
      ]),
    ]);
  }
  joinPreviewKey(o, uid, preferences, travel) {
    return digest(
      JSON.stringify([
        o.id,
        o.version,
        uid,
        preferences,
        this.journeySignature(travel, uid),
        travel.pendingTransport || [],
      ]),
    );
  }
  view(outingId, id) {
    const o = this.outing(outingId);
    if (!this.canSee(o, id)) throw new Error("This outing is private.");
    const member = o.people.find((p) => p.userId === id),
      participant =
        (Boolean(member) && active(member)) || o.organizerId === id;
    return {
      id: o.id,
      title: o.title,
      kind: o.kind || "outing",
      needsGuide: Boolean(o.needsGuide),
      organizerId: o.organizerId,
      visibility: o.visibility,
      status: o.status,
      statusLabel: labels[o.status],
      revision: o.revision,
      version: o.version,
      target: o.target,
      start: o.start,
      end: o.end,
      timezone: o.timezone,
      site: o.site,
      minPeople: o.minPeople,
      maxPeople: o.maxPeople,
      deadline: o.deadline,
      remaining: this.openPlaces(o),
      driverPlaces: this.driverPlace(o),
      astronomy: o.astronomy,
      weather: o.weather,
      weatherError: o.weatherError,
      solver: o.organizerId === id ? o.solver : undefined,
      reasons: [
        ...(o.reasons || []),
        ...(o.migrationPaused
          ? [
              "Imported outing: automatic updates are paused until the organizer reviews or reconciles it.",
            ]
          : []),
      ],
      viewerId: id,
      organizer: o.organizerId === id,
      canJoin:
        (!member || !active(member)) &&
        o.organizerId !== id &&
        this.joinable(o),
      canComment:
        participant && o.status !== "draft" && !closed.has(o.status),
      migrationPaused: Boolean(o.migrationPaused),
      people: o.people.map((p) => ({
        ...this.publicPerson({
          ...this.user(p.userId),
          preferences: p.preferences,
        }),
        response: p.response,
        channel: p.channel,
        revision: p.revision,
        transport: p.transport,
        selfArranged: Boolean(p.selfArranged),
        confirmed: p.response === "accepted" && p.revision === o.revision,
        organizer: p.userId === o.organizerId,
        conflict: p.conflict,
        roles: [
          p.transport === "drive" ? "Driver" : null,
          p.preferences.equipment.includes("telescope")
            ? "Telescope"
            : null,
          p.preferences.happyToTeach ? "Guide" : null,
        ].filter(Boolean),
        reservedUntil: p.reservedUntil,
        ...(p.userId === id
          ? {
              preferences: p.preferences,
              availability:
                p.availability ||
                expandSlots(
                  p.preferences.slots || [],
                  p.preferences.timezone || o.timezone,
                  o.start,
                  o.end,
                ),
            }
          : {}),
      })),
      equipment: equipmentList(o),
      alternatives: o.organizerId === id ? o.alternatives || [] : [],
      routes: participant
        ? (o.routes || [])
            .filter((r) => r.participantId === id)
            .map((r) => ({
              ...r,
              pickupOnly: Boolean(member?.pickupChoice),
            }))
        : [],
      carpools: participant ? o.carpools || [] : [],
      comments: participant
        ? o.comments.map(({ authorId, ...c }) => ({
            ...c,
            authorId,
            authorName: this.publicPerson(this.user(authorId)).name,
          }))
        : [],
      calendar: participant
        ? {
            id: o.calendar?.applied ? o.calendar.id : undefined,
            state: o.calendar?.state,
            error: o.calendar?.error,
            checkedAt: o.calendar?.checkedAt,
            url: o.calendar?.url,
          }
        : undefined,
      deliveryMode: o.deliveryMode || "server",
      invitationHoldHours: o.invitationHoldHours || 24,
      traffic: o.people.some((p) => active(p) && p.transport === "drive")
        ? o.traffic
        : undefined,
      pendingTransport: o.pendingTransport || [],
      needsDriver: Boolean(o.pendingTransport?.length),
      meeting: meetingTimes(o),
      accessConfirmed: o.site.access === "confirmed",
    };
  }
  async trafficReport(id, outingId) {
    const o = this.outing(outingId);
    if (!this.canSee(o, id)) throw new Error("This outing is private.");
    return this.trafficReports.report(o);
  }
  publicOuting(outingId) {
    const o = this.data.outings.find((o) => o.id === outingId);
    if (
      !o ||
      o.visibility !== "open" ||
      o.status === "draft" ||
      o.unpublished ||
      closed.has(o.status) ||
      Date.parse(o.start) <= Date.now()
    )
      return null;
    // Deliberately separate from the signed-in view: no people, pickup points,
    // preferences, comments, Calendar links or delivery details leave this API.
    const pick = (value, keys) =>
      value == null
        ? null
        : Object.fromEntries(keys.map((key) => [key, value[key]]));
    return {
      id: o.id,
      title: o.title,
      target: o.target,
      start: o.start,
      end: o.end,
      timezone: o.timezone,
      status: o.status,
      statusLabel: labels[o.status],
      site: pick(o.site, ["name", "accessNote", "walkMinutes"]),
      maxPeople: o.maxPeople,
      remaining: this.openPlaces(o),
      driverPlaces: this.driverPlace(o),
      going: o.people.filter((p) => p.response === "accepted").length,
      needsDriver: Boolean(o.pendingTransport?.length),
      astronomy: pick(o.astronomy, [
        "minTargetAltitude",
        "moonIllumination",
        "maxSunAltitude",
        "maxMoonAltitude",
        "suitable",
        "sampleMinutes",
      ]),
      weather: pick(o.weather, [
        "maxCloudCover",
        "maxWindKmh",
        "minTemperatureC",
        "maxPrecipitationProbability",
        "suitable",
        "fetchedAt",
      ]),
    };
  }
  publicOutings() {
    return this.data.outings
      .map((o) => this.publicOuting(o.id))
      .filter(
        (o) =>
          o &&
          (o.remaining > 0 || o.driverPlaces > 0) &&
          o.weather?.suitable !== false &&
          o.astronomy?.suitable !== false,
      )
      .sort((a, b) => Date.parse(a.start) - Date.parse(b.start))
      .slice(0, 24);
  }
  async discover(id, raw = {}) {
    const candidates = await this.discoverCandidates(id, raw);
    return this.solvers.rank(
      id,
      this.discoveryPreferences(id, raw),
      candidates,
      { ...raw, providers: { geo: this.geo, forecast: this.forecast } },
    );
  }
  discoveryPreferences(id, raw) {
    // A supplied form snapshot is authoritative, including cleared fields.
    // Only calls without a snapshot fall back to remembered preferences.
    return discoveryPreferencesSchema.parse(
      raw.preferences ?? this.user(id).preferences ?? {},
    );
  }
  async discoverCandidates(id, raw = {}) {
    const p = this.discoveryPreferences(id, raw);
    const now = Date.now(),
      offers = [];
    for (const o of this.data.outings) {
      if (
        !this.canSee(o, id) ||
        !this.joinable(o) ||
        closed.has(o.status) ||
        Date.parse(o.start) <= now ||
        this.capacity(o) >= o.maxPeople ||
        o.people.some((a) => a.userId === id)
      )
        continue;
      const reasons = [];
      let score = 0;
      if (!raw.anyDate && p.slots?.length && p.timezone) {
        const windows = expandSlots(p.slots, p.timezone, o.start, o.end);
        if (
          !windows.some(
            (w) =>
              Date.parse(w.start) <= Date.parse(o.start) &&
              Date.parse(w.end) >= Date.parse(o.end),
          )
        )
          continue;
        reasons.push("Your evening overlaps");
        score += 3;
      }
      const interests = p.interests || [];
      if (
        interests.includes("Open to anything") ||
        interests.includes("Stargazing") ||
        (interests.includes("Planets") && o.target !== "stargazing")
      ) {
        score += 2;
        reasons.push("Fits your interests");
      }
      if (
        interests.includes("Learning") &&
        o.people.some((m) => active(m) && m.preferences.happyToTeach)
      ) {
        score += 2;
        reasons.push("Someone happy to teach");
      }
      if (
        interests.includes("Photography") &&
        o.tags?.includes("Photography")
      ) {
        score += 3;
        reasons.push("Photography friendly");
      }
      if (p.origin) {
        const a = p.origin.location,
          b = o.site.location;
        const km = Math.hypot((a.lat - b.lat) * 111, (a.lon - b.lon) * 71);
        score -= km / 30;
        reasons.push(`About ${Math.round(km)} km away`);
      }
      offers.push({
        ...this.view(o.id, id),
        matchReasons: reasons,
        potential: true,
        score,
      });
    }
    return offers.sort((a, b) => b.score - a.score).slice(0, 12);
  }
  async routesFor(o, people, { allowPending = false } = {}) {
    const self = people.filter((p) => p.selfArranged),
      routed = people.filter((p) => !p.selfArranged);
    const ownRoutes = self.map((p) => ({
      participantId: p.userId,
      mode: "self",
      selfArranged: true,
      ...meetingTimes(o),
    }));
    if (!routed.length)
      return {
        routes: ownRoutes,
        carpools: [],
        modes: Object.fromEntries(self.map((p) => [p.userId, "self"])),
        pendingTransport: [],
      };
    const request = {
      trafficModel: "approximated",
      drivingBufferMinutes: 10,
      pickupStopMinutes: 3,
      ...o.limits,
    };
    const start = Date.parse(o.start),
      end = Date.parse(o.end),
      from = new Date(start - 86400000).toISOString(),
      until = new Date(end + 86400000).toISOString();
    const variants = [],
      failures = [];
    function combine(index, list) {
      if (variants.length >= 32) return;
      if (index === routed.length) {
        variants.push(list);
        return;
      }
      const member = routed[index];
      for (const transport of member.transport
        ? [member.transport]
        : member.preferences.travel)
        combine(index + 1, [...list, { member, transport }]);
    }
    combine(0, []);
    for (const variant of variants) {
      const group = variant.map(({ member, transport }) => ({
        ...plannerPerson(
          this.user(member.userId),
          member.preferences,
          transport,
          from,
          until,
          o.target,
        ),
        ...(member.pickupChoice
          ? {
              fixedPickup: true,
              requiredDriverId: member.pickupChoice.driverId,
            }
          : {}),
        ...(member.availability
          ? { availability: member.availability }
          : {}),
      }));
      if (
        group.some(
          (p) =>
            !p.availability.length ||
            (p.transport === "drive" && !p.car.available),
        )
      )
        continue;
      const routing = await createTransport(
        group,
        [o.site],
        request,
        this.geo,
      );
      for (const option of routing
        .options(group, o.site)
        .sort(
          (a, b) => a.pickupPreferenceMisses - b.pickupPreferenceMisses,
        )) {
        if (
          !group.every((p) =>
            journeyFits(p, option.journeys[p.id], o.site, start, end),
          )
        )
          continue;
        const checked = await routing.validate(option, group, o.site);
        if (
          checked &&
          group.every((p) =>
            journeyFits(p, checked.journeys[p.id], o.site, start, end),
          )
        )
          return {
            ...describeTransport(checked, group, o.site, start, end),
            routes: [
              ...describeTransport(checked, group, o.site, start, end)
                .routes,
              ...ownRoutes,
            ],
            modes: {
              ...Object.fromEntries(group.map((p) => [p.id, p.transport])),
              ...Object.fromEntries(self.map((p) => [p.userId, "self"])),
            },
            pendingTransport: [],
          };
      }
      failures.push(...routing.failures);
      for (const option of routing.options(group, o.site))
        for (const p of group)
          if (!journeyFits(p, option.journeys[p.id], o.site, start, end))
            failures.push({ participantId: p.id, kind: "availability" });
    }
    if (allowPending) {
      const riders = routed.filter(
        (p) =>
          p.transport === "ride" ||
          (!p.transport && p.preferences.travel.includes("ride")),
      );
      if (riders.length) {
        const waiting = new Set(riders.map((p) => p.userId));
        const rest = await this.routesFor(
          o,
          people.filter((p) => !waiting.has(p.userId)),
        );
        return {
          ...rest,
          pendingTransport: [...waiting],
          modes: {
            ...rest.modes,
            ...Object.fromEntries(riders.map((p) => [p.userId, "ride"])),
          },
        };
      }
    }
    if (failures.length) {
      const who = people.at(-1).userId;
      const f =
        failures.find((f) => f.participantId === who) || failures[0];
      const name =
        f.participantId === who
          ? "Your"
          : `${this.publicPerson(this.user(f.participantId)).name}’s`;
      if (f.kind === "availability")
        throw new Error(
          `${name} available evening does not cover the journey, setup and return. Choose different travel arrangements or ask the organizer to review the time.`,
        );
      const label = {
        journey: "journey",
        walking: "walking",
        detour: "extra driving",
      }[f.kind];
      throw new Error(
        `${name} ${label} needs about ${f.minutes} minutes each way; the limit is ${f.limit} minutes. Review the limit for this outing, choose another pickup, or make your own way.`,
      );
    }
    throw new Error(
      "No offered lift fits the group’s current seats, pickup points and travel limits. Try another pickup or make your own way. The complete journey does not fit: check availability, seats, walking limits and pickup points. Your availability must include travel, setup and the return home.",
    );
  }
  preparePlanning(id, raw, options = {}) {
    const data = outline.parse(raw),
      user = structuredClone(this.user(id));
    // These confirmed dates belong to this outing, not to the reusable profile.
    const availability = [{ start: data.start, end: data.end }];
    if (!preferencesSchema.safeParse(user.preferences).success)
      throw new Error(
        "Choose your starting point, availability and travel options for this evening first.",
      );
    if (
      user.preferences.travel.every((mode) => mode === "drive") &&
      !user.preferences.car?.available
    )
      throw new Error(
        "Confirm that your car is available, or choose another way to travel.",
      );
    if (data.minPeople > data.maxPeople)
      throw new Error("Minimum group size cannot exceed maximum.");
    const friends = this.friends(id);
    const ranked = [...friends].sort((a, b) => {
      const score = (uid) => {
        const p = this.user(uid).preferences;
        if (!preferencesSchema.safeParse(p).success) return -1000;
        const windows = expandSlots(
          p.slots,
          p.timezone,
          data.start,
          data.end,
        );
        return (
          (windows.length ? 10 : 0) +
          (p.interests.includes("Open to anything") ? 1 : 0) +
          (p.interests.includes(
            data.target === "stargazing" ? "Stargazing" : "Planets",
          )
            ? 2
            : 0) +
          (p.shareEquipment && p.equipment.includes("telescope") ? 2 : 0) +
          (p.happyToTeach ? 1 : 0)
        );
      };
      return score(b) - score(a);
    });
    const selected = data.participantIds || ranked.slice(0, 7);
    if (selected.some((p) => !friends.includes(p)))
      throw new Error(
        "Direct proposals use your circle. Other people can join open places.",
      );
    const users = [
      user,
      ...selected
        .map((p) => structuredClone(this.user(p)))
        .filter((u) => preferencesSchema.safeParse(u.preferences).success),
    ].slice(0, 8);
    const {
      site: suppliedSite,
      solver,
      visibility,
      participantIds,
      ...planning
    } = data;
    const request = requestSchema.parse({
      ...planning,
      organizerId: id,
      timezone: user.preferences.timezone,
      minPeople: Math.min(data.minPeople, users.length),
    });
    const backend = data.solver || this.solvers.defaultBackend;
    return {
      data,
      user,
      users,
      request,
      id,
      availability,
      backend,
      ranked,
      geo: this.geo,
      forecast: this.forecast,
      routesFor: this.routesFor.bind(this),
      signal: options.signal,
      onProgress: options.onProgress || (() => {}),
    };
  }
  async plan(id, raw, options = {}) {
    const context = this.preparePlanning(id, raw, options);
    const result = await this.solvers.plan(context.backend, context);
    return this.commitPlan(id, context, result, options);
  }
  assertPlanningCurrent(context) {
    for (const person of context.users) {
      if (
        (person.id !== context.id &&
          !this.friends(context.id).includes(person.id)) ||
        JSON.stringify(this.user(person.id).preferences) !==
          JSON.stringify(person.preferences)
      )
        throw new Error(
          "A profile or circle membership changed while planning. Start a fresh plan using the current choices.",
        );
    }
  }
  async commitPlan(id, context, result, options = {}) {
    const { data, users, request, availability, backend, ranked } = context;
    if (options.signal?.aborted || this.closing)
      throw new Error("Planning was stopped.");
    this.assertPlanningCurrent(context);
    if (result.status === "no_match")
      return {
        ...result,
        reason:
          result.solver?.backend === "codex"
            ? result.reason
            : "No suitable viewing window was found. Try a different evening, observing target or travel options.",
      };
    const o = {
      id: randomUUID(),
      organizerId: id,
      title: `${data.target === "stargazing" ? "A sky full of stars" : data.target} · ${result.site.name}`,
      visibility: data.visibility,
      status: "draft",
      revision: 1,
      version: 1,
      target: data.target,
      start: result.observingStart,
      end: result.observingEnd,
      timezone: request.timezone,
      site: result.site,
      minPeople: data.minPeople,
      maxPeople: data.maxPeople,
      needsGuide: data.needsGuide,
      people: result.participants.map((p) => ({
        userId: p.id,
        response: p.id === id ? "accepted" : "pending",
        revision: 1,
        channel:
          users.find((u) => u.id === p.id).preferences.channel || "email",
        preferences: structuredClone(
          users.find((u) => u.id === p.id).preferences,
        ),
        transport: p.transport,
        ...(p.id === id ? { availability } : {}),
      })),
      pendingTransport: result.pendingTransport || [],
      astronomy: result.astronomy,
      weather: result.weather,
      equipment: result.equipment,
      routes: result.routes,
      carpools: result.carpools,
      traffic: result.traffic,
      comments: [],
      limits: request,
      solver: result.solver || {
        backend,
        summary: "Selected by the rule-based planner.",
      },
      createdAt: iso(),
      alternatives: ranked
        .filter((uid) => !result.participants.some((p) => p.id === uid))
        .map((uid) => this.publicPerson(this.user(uid))),
    };
    o.reasons = o.pendingTransport.length
      ? [
          "Driver needed. The outing can gather people while the ride is arranged.",
        ]
      : [];
    if (
      !["stargazing", "Moon"].includes(o.target) &&
      !o.people.some(
        (p) =>
          p.preferences.equipment.includes("telescope") &&
          p.preferences.shareEquipment,
      )
    )
      o.reasons.push(
        "A shared telescope is needed before this outing can be confirmed.",
      );
    if (
      o.needsGuide &&
      !o.people.some(
        (p) =>
          p.preferences.experience === "experienced" &&
          p.preferences.happyToTeach,
      )
    )
      o.reasons.push(
        "An experienced guide is needed before this outing can be confirmed.",
      );
    options.beforeCommit?.();
    this.data.outings.unshift(o);
    try {
      await this.store.persist();
    } catch (error) {
      this.data.outings = this.data.outings.filter(
        (saved) => saved.id !== o.id,
      );
      throw error;
    }
    return this.view(o.id, id);
  }
  evaluate(o, now = Date.now()) {
    if (o.migrationPaused || closed.has(o.status) || o.status === "draft")
      return;
    let expired = false;
    for (const p of o.people)
      if (
        p.userId !== o.organizerId &&
        ["pending", "tentative"].includes(p.response) &&
        p.reservedUntil &&
        Date.parse(p.reservedUntil) <= now
      ) {
        p.response = "expired";
        o.version++;
        expired = true;
        this.organizerNotice(
          o,
          `${p.preferences.name}’s invitation expired`,
          "Their reserved place is available again.",
        );
      }
    this.releaseBrokenRides(o);
    const accepted = o.people.filter(
        (p) => p.response === "accepted" && p.revision === o.revision,
      ),
      ids = new Set(accepted.map((p) => p.userId)),
      reasons = [];
    if (accepted.length < o.minPeople)
      reasons.push(
        `Waiting for ${o.minPeople - accepted.length} more ${o.minPeople - accepted.length === 1 ? "person" : "people"} to accept.`,
      );
    if (o.people.some((p) => active(p) && p.journeyReview))
      reasons.push(
        "Changed journeys need confirmation from the affected participants.",
      );
    if (!ids.has(o.organizerId))
      reasons.push("The organizer must confirm the current plan.");
    if (
      !["stargazing", "Moon"].includes(o.target) &&
      !(
        accepted.some(
          (p) =>
            p.preferences.equipment.includes("telescope") &&
            p.preferences.shareEquipment,
        ) ||
        (accepted.length > 0 &&
          accepted.every((p) =>
            p.preferences.equipment.includes("telescope"),
          ))
      )
    )
      reasons.push("A shared telescope needs confirmation.");
    if (
      o.needsGuide &&
      !accepted.some(
        (p) =>
          p.preferences.happyToTeach &&
          p.preferences.experience === "experienced",
      )
    )
      reasons.push("A guide needs to confirm.");
    for (const car of o.carpools || [])
      if (
        car.passengerIds.some((p) => ids.has(p)) &&
        !ids.has(car.driverId)
      )
        reasons.push("A passenger is waiting for their driver.");
    if ((o.pendingTransport || []).some((uid) => ids.has(uid)))
      reasons.push("Driver needed. Transport is not yet arranged.");
    if (o.site.access !== "confirmed")
      reasons.push("Night access needs confirmation.");
    if (o.astronomy?.suitable === false)
      reasons.push("Astronomical conditions need review.");
    if (o.weather?.suitable === false)
      reasons.push("The forecast no longer meets the planning limits.");
    o.reasons = [...new Set(reasons)];
    const before = o.status;
    o.status = reasons.length
      ? o.everConfirmed
        ? "needs_review"
        : "invited"
      : "confirmed";
    if (o.status === "confirmed") o.everConfirmed = true;
    if (now >= Date.parse(o.end))
      o.status = o.everConfirmed ? "completed" : "not_formed";
    else if (
      now >= Date.parse(o.deadline) &&
      !o.everConfirmed &&
      o.status !== "confirmed"
    )
      o.status = "not_formed";
    if (
      before !== o.status &&
      o.status === "confirmed" &&
      !o.confirmationNotified
    ) {
      o.confirmationNotified = true;
      this.notify(
        o,
        "Outing confirmed",
        "Your group is ready. Review your journey before leaving.",
      );
    }
    if (before !== o.status && o.status === "needs_review")
      this.organizerNotice(o, "Plan needs review", o.reasons.join(" "));
    const full = this.capacity(o) >= o.maxPeople;
    if (full && !o.wasFull)
      this.organizerNotice(
        o,
        "Your group is full",
        "All places are occupied or reserved. Pending guests can still respond.",
      );
    o.wasFull = full;
    if (expired) this.queueCalendar(o);
    if (
      closed.has(o.status) &&
      before !== o.status &&
      o.status === "not_formed"
    )
      this.notify(
        o,
        "This outing didn’t come together",
        "The response deadline passed before the group was ready.",
      );
  }
  notify(o, subject, text) {
    for (const p of o.people.filter(active))
      this.notice(o, p, subject, text);
    this.queueCalendar(o);
  }
  queueCalendar(o) {
    if (o.migrationPaused || o.unpublished || o.status === "draft") return;
    if (!o.people.some((p) => p.channel === "calendar") && !o.calendar?.id)
      return;
    o.calendar ||= { id: digest(o.id).slice(0, 40) };
    const previous = o.calendar.desired;
    o.calendar.desired = digest(
      JSON.stringify([
        o.revision,
        Boolean(o.confirmationNotified),
        o.status === "cancelled" || o.status === "not_formed",
        o.title,
        o.start,
        o.end,
        o.deadline,
        o.site,
        o.people.filter(active).map((p) => [p.userId, p.channel]),
        o.carpools,
      ]),
    );
    if (
      o.calendar.applied !== o.calendar.desired &&
      previous !== o.calendar.desired
    ) {
      o.calendar.state = o.calendar.externalClaim
        ? "codex_sending"
        : o.deliveryMode === "codex"
          ? "codex_pending"
          : "queued";
      o.calendar.attempts = 0;
      delete o.calendar.nextAttempt;
    }
  }
  async invite(id, raw) {
    const data = z
      .object({
        outingId: idSchema,
        participantIds: z.array(idSchema).max(7),
        deadline: instant.optional(),
        holdHours: z.number().min(1).max(168).default(24),
        visibility: z.enum(["circle", "open"]).optional(),
      })
      .strict()
      .parse(raw);
    const o = this.outing(data.outingId);
    this.owner(o, id);
    this.evaluate(o);
    if (closed.has(o.status)) throw new Error("This outing is closed.");
    if (o.site.access !== "confirmed")
      throw new Error(
        "Confirm night access and the meeting point before inviting.",
      );
    if (Date.parse(o.start) <= Date.now() + 30 * 60000)
      throw new Error(
        "Choose a future outing with time to respond and travel.",
      );
    if (data.participantIds.some((p) => !this.friends(id).includes(p)))
      throw new Error("Choose direct invitations from your circle.");
    const version = o.version,
      ids = [...new Set([id, ...data.participantIds])];
    const people =
      o.status === "draft"
        ? o.people.filter((p) => ids.includes(p.userId))
        : structuredClone(o.people.filter(active));
    for (const userId of ids)
      if (!people.some((p) => p.userId === userId)) {
        const prior = o.people.find((p) => p.userId === userId);
        if (userId === id && prior) {
          people.push(structuredClone(prior));
          continue;
        }
        const u = this.user(userId);
        if (!preferencesSchema.safeParse(u.preferences).success)
          throw new Error(
            "This friend must save their evening preferences first.",
          );
        people.push({
          userId,
          preferences: structuredClone(u.preferences),
          channel: u.preferences.channel || "email",
          response: userId === id ? "accepted" : "pending",
          revision: o.revision,
        });
      }
    this.requireCalendar(o, people);
    if (people.length > o.maxPeople)
      throw new Error(
        "Not enough unreserved places for these invitations.",
      );
    const travel = await this.routesFor(o, people.filter(active), {
      allowPending:
        Boolean(o.pendingTransport?.length) ||
        (!o.everConfirmed && (data.visibility || o.visibility) === "open"),
    });
    if (travel.pendingTransport.length && people.length >= o.maxPeople)
      throw new Error(
        "Leave a place open for someone who can offer a lift.",
      );
    return this.lock(o.id, async () => {
      if (o.version !== version)
        throw new Error(
          "The group changed while checking journeys. Review it and invite again.",
        );
      const deadline =
        data.deadline ||
        o.deadline ||
        new Date(Date.parse(o.start) - 30 * 60000).toISOString();
      if (
        Date.parse(deadline) <= Date.now() ||
        Date.parse(deadline) >= Date.parse(o.start)
      )
        throw new Error(
          "Choose a response deadline after now and before the outing.",
        );
      const newly = people.filter(
        (p) =>
          o.status === "draft" ||
          !o.people.some((old) => old.userId === p.userId && active(old)),
      );
      const previousPeople = structuredClone(o.people);
      o.migrationPaused = false;
      o.unpublished = false;
      o.people = [
        ...people,
        ...o.people.filter(
          (p) =>
            !active(p) && !people.some((next) => next.userId === p.userId),
        ),
      ];
      o.deadline = deadline;
      o.invitationHoldHours = data.holdHours;
      o.visibility = data.visibility || o.visibility;
      this.applyTravel(o, travel, previousPeople);
      for (const p of o.people) {
        p.transport = travel.modes[p.userId];
        if (p.response === "pending" && !p.reservedUntil)
          p.reservedUntil = new Date(
            Math.min(
              Date.now() + data.holdHours * 3600000,
              Date.parse(deadline),
            ),
          ).toISOString();
      }
      o.status = o.status === "draft" ? "invited" : o.status;
      o.version++;
      for (const p of newly.filter((p) => p.userId !== id))
        this.notice(
          o,
          p,
          "You’re invited · Star Gazer",
          `Your place is reserved until ${p.reservedUntil}. Review the plan and respond on the outing page.`,
        );
      for (const p of newly.filter((p) => p.userId !== id))
        this.rideNotices(o, p.userId, { calendarUpdate: true });
      this.queueCalendar(o);
      this.evaluate(o);
      await this.store.persist();
      return this.view(o.id, id);
    });
  }
  joinOptions(id, outingId) {
    const o = this.outing(outingId);
    if (!this.canSee(o, id)) throw new Error("This outing is private.");
    const pickups = [];
    let availableSeats = 0;
    for (const p of o.people.filter(active)) {
      const car = p.preferences.car;
      if (!car?.available || !car.offerRides || p.transport !== "drive")
        continue;
      const assigned = (o.carpools || []).find(
        (c) => c.driverId === p.userId,
      );
      const used = (assigned?.passengerIds || []).filter((uid) =>
        o.people.some((m) => m.userId === uid && active(m)),
      ).length;
      const seats = car.passengerSeats - used;
      if (seats < 1) continue;
      availableSeats += seats;
      for (const [i, point] of (car.pickupPoints || []).entries()) {
        const existing = assigned?.pickups.find(
          (x) =>
            JSON.stringify(x.pickup.location) ===
            JSON.stringify(point.location),
        );
        pickups.push({
          id: `${p.userId}:${i}`,
          point,
          driverId: p.userId,
          driver: this.publicPerson(this.user(p.userId)).name,
          seats,
          pickupAt: existing?.pickupAt,
          dropoffAt: existing?.dropoffAt,
        });
      }
    }
    return {
      meeting: meetingTimes(o),
      pickups,
      availableSeats,
      needsDriver: Boolean(o.pendingTransport?.length),
      calendarAvailable:
        o.deliveryMode === "codex" ||
        this.providers.status(o.organizerId).googleConnected,
      needsTelescope:
        !["stargazing", "Moon"].includes(o.target) &&
        !o.people.some(
          (p) =>
            active(p) &&
            p.preferences.equipment.includes("telescope") &&
            p.preferences.shareEquipment,
        ),
    };
  }
  joinInput(id, o, raw) {
    if (raw.details)
      return prepareJoin(
        this.user(id),
        o,
        raw.details,
        this.joinOptions(id, o.id),
      );
    return {
      preferences: preferencesSchema.parse(
        raw.preferences || this.user(id).preferences,
      ),
      selfArranged: false,
    };
  }
  applyTravel(o, travel, previousPeople = o.people) {
    const waiting = new Set(o.pendingTransport || []);
    const affected = previousPeople.filter(
      (p) =>
        active(p) &&
        o.people.some((n) => n.userId === p.userId && active(n)) &&
        ((waiting.has(p.userId) &&
          !travel.pendingTransport?.includes(p.userId)) ||
          this.journeySignature(o, p.userId) !==
            this.journeySignature(travel, p.userId)),
    );
    Object.assign(o, {
      routes: travel.routes,
      carpools: travel.carpools,
      pendingTransport: travel.pendingTransport || [],
    });
    for (const p of o.people.filter(active))
      p.transport = travel.modes[p.userId];
    if (o.status === "draft" || !affected.length) return;
    o.revision++;
    const changed = new Set(affected.map((p) => p.userId));
    for (const p of o.people.filter(active)) {
      if (!changed.has(p.userId)) {
        p.revision = o.revision;
        continue;
      }
      p.response = "pending";
      p.journeyReview = true;
      p.conflict =
        "Your journey changed. Review your driver, pickup and return times, then confirm on this page.";
      p.reservedUntil = this.reservationEnd(o);
      this.notice(
        o,
        p,
        "Your journey changed · please reconfirm",
        p.conflict,
      );
    }
  }
  async travelForJoin(o, people) {
    const joining = people.at(-1);
    if (!joining.selfArranged)
      return this.routesFor(o, people, {
        allowPending: Boolean(o.pendingTransport?.length),
      });
    // Self-transport consumes a group place but no seat and changes no route.
    // Preserve the reviewed arrangements instead of re-routing everybody.
    const ids = new Set(people.map((p) => p.userId));
    return {
      routes: [
        ...(o.routes || []).filter(
          (r) =>
            ids.has(r.participantId) && r.participantId !== joining.userId,
        ),
        {
          participantId: joining.userId,
          name: joining.preferences.name,
          mode: "self",
          selfArranged: true,
          ...meetingTimes(o),
        },
      ],
      carpools: structuredClone(o.carpools || []),
      modes: Object.fromEntries(
        people.map((p) => [p.userId, p === joining ? "self" : p.transport]),
      ),
      pendingTransport: (o.pendingTransport || []).filter((id) =>
        ids.has(id),
      ),
    };
  }
  async join(id, raw) {
    const {
      outingId,
      preferences,
      details,
      expectedVersion,
      expectedPreview,
    } = z
      .object({
        outingId: idSchema,
        preferences: preferencesSchema.optional(),
        details: joinDetailsSchema.optional(),
        expectedVersion: z.number().int().optional(),
        expectedPreview: z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .optional(),
      })
      .strict()
      .parse(raw);
    const o = this.outing(outingId),
      u = this.user(id);
    if (!this.canSee(o, id)) throw new Error("This outing is private.");
    this.evaluate(o);
    if (expectedVersion !== undefined && expectedVersion !== o.version)
      throw new Error(
        "The plan changed since your journey preview. Review it again.",
      );
    if (closed.has(o.status) || o.status === "draft")
      throw new Error("This outing is not open for joining.");
    if (o.migrationPaused)
      throw new Error(
        "The organizer must review this imported outing before anyone joins.",
      );
    if (Date.parse(o.start) <= Date.now())
      throw new Error(
        "This outing has already started. Choose another evening.",
      );
    if (o.weather?.suitable === false || o.astronomy?.suitable === false)
      throw new Error(
        "The observing conditions need the organizer’s review before more people can join.",
      );
    if (o.people.some((p) => p.userId === id && active(p)))
      throw new Error(
        "You already have a place. Respond on the outing page.",
      );
    if (this.capacity(o) >= o.maxPeople)
      throw new Error("The group is full. Choose another outing.");
    const input = this.joinInput(id, o, { preferences, details }),
      prefs = input.preferences,
      version = o.version;
    const person = {
      userId: id,
      preferences: prefs,
      selfArranged: input.selfArranged,
      ...(input.pickupChoice ? { pickupChoice: input.pickupChoice } : {}),
      channel: prefs.channel,
      response: "accepted",
      revision: o.revision,
      source: "app",
      answeredAt: iso(),
    };
    const people = [...structuredClone(o.people.filter(active)), person],
      travel = await this.travelForJoin(o, people);
    if (
      expectedPreview &&
      expectedPreview !== this.joinPreviewKey(o, id, prefs, travel)
    )
      throw new Error(
        "Your journey or invitation details changed since the preview. Review them again before joining.",
      );
    if (travel.pendingTransport.includes(id))
      throw new Error(
        "No lift is available for you yet. Choose self-transport or wait for a driver.",
      );
    if (travel.pendingTransport.length && people.length >= o.maxPeople)
      throw new Error(
        "The last place is needed for a driver who can provide the missing lift.",
      );
    if (
      Date.parse(
        travel.routes.find((r) => r.participantId === id)?.departAt ||
          travel.routes.find((r) => r.participantId === id)?.meetAt,
      ) <= Date.now()
    )
      throw new Error(
        "There is no longer enough time for your journey. Choose another evening.",
      );
    return this.lock(o.id, async () => {
      this.evaluate(o);
      if (
        version !== o.version ||
        this.capacity(o) >= o.maxPeople ||
        closed.has(o.status)
      )
        throw new Error(
          "The available places changed. Refresh before joining.",
        );
      // A join may use offered seats, but cannot move an existing passenger to a different pickup or driver.
      for (const old of o.carpools || [])
        for (const pickup of old.pickups)
          if (people.some((p) => p.userId === pickup.participantId)) {
            const next = travel.carpools.find((c) =>
              c.passengerIds.includes(pickup.participantId),
            );
            if (
              !next ||
              next.driverId !== old.driverId ||
              JSON.stringify(
                next.pickups.find(
                  (p) => p.participantId === pickup.participantId,
                )?.pickup.location,
              ) !== JSON.stringify(pickup.pickup.location)
            )
              throw new Error(
                "Joining would change an existing ride. Ask the organizer to review the plan first.",
              );
          }
      const previousPeople = structuredClone(o.people);
      o.people = o.people.filter((p) => p.userId !== id);
      o.people.push(person);
      this.applyTravel(o, travel, previousPeople);
      u.preferences = input.remembered || {
        ...prefs,
        ...u.preferences,
      };
      o.version++;
      this.notice(
        o,
        person,
        "You joined · Star Gazer",
        "Your place is confirmed. Check your ride and the current forecast.",
      );
      this.organizerNotice(
        o,
        `${prefs.name} joined your outing`,
        "The journey and group constraints were checked.",
      );
      this.rideNotices(o, id, { calendarUpdate: true });
      this.queueCalendar(o);
      this.evaluate(o);
      await this.store.persist();
      return this.view(o.id, id);
    });
  }
  async previewJoin(id, raw) {
    const o = this.outing(raw.outingId);
    if (!this.canSee(o, id)) throw new Error("This outing is private.");
    this.evaluate(o);
    if (
      closed.has(o.status) ||
      o.migrationPaused ||
      o.status === "draft" ||
      Date.parse(o.start) <= Date.now() ||
      this.capacity(o) >= o.maxPeople
    )
      throw new Error("This outing has no open place.");
    if (o.weather?.suitable === false || o.astronomy?.suitable === false)
      throw new Error(
        "The observing conditions need the organizer’s review.",
      );
    const input = this.joinInput(id, o, raw),
      preferences = input.preferences,
      version = o.version;
    const people = [
      ...structuredClone(
        o.people.filter((p) => active(p) && p.userId !== id),
      ),
      {
        userId: id,
        preferences,
        selfArranged: input.selfArranged,
        pickupChoice: input.pickupChoice,
      },
    ];
    const travel = await this.travelForJoin(o, people);
    if (travel.pendingTransport.includes(id))
      throw new Error(
        "No lift is available for you yet. Choose self-transport or wait for a driver.",
      );
    if (travel.pendingTransport.length && people.length >= o.maxPeople)
      throw new Error(
        "The last place is needed for a driver who can provide the missing lift.",
      );
    if (
      Date.parse(
        travel.routes.find((r) => r.participantId === id)?.departAt ||
          travel.routes.find((r) => r.participantId === id)?.meetAt,
      ) <= Date.now()
    )
      throw new Error(
        "There is no longer enough time for your journey. Choose another evening.",
      );
    if (o.version !== version)
      throw new Error("The group changed. Check your journey again.");
    const car = travel.carpools.find((c) => c.passengerIds.includes(id));
    return {
      outingId: o.id,
      version,
      previewKey: this.joinPreviewKey(o, id, preferences, travel),
      ...(raw.details ? { details: raw.details } : { preferences }),
      pendingTransport: travel.pendingTransport,
      route: travel.routes.find((r) => r.participantId === id),
      driver: car ? { id: car.driverId, name: car.driverName } : null,
      pickup: car?.pickups.find((p) => p.participantId === id),
      mode: travel.modes[id],
    };
  }
  rideNotices(o, changedId, { calendarUpdate = false } = {}) {
    for (const car of o.carpools || [])
      if (
        car.driverId === changedId ||
        car.passengerIds.includes(changedId)
      )
        for (const personId of new Set([
          car.driverId,
          ...car.passengerIds,
        ])) {
          if (personId === changedId) continue;
          const p = o.people.find((p) => p.userId === personId);
          if (
            p &&
            active(p) &&
            !(p.channel === "calendar" && calendarUpdate)
          )
            this.mail({
              to: this.user(p.userId).email,
              recipientId: p.userId,
              senderId: o.organizerId,
              subject: "Your shared journey changed",
              text: "Check the passenger list, pickup and return arrangements.",
              link: `${this.baseUrl}/outing/${o.id}`,
            });
        }
  }
  async respond(id, raw) {
    const data = z
      .object({
        outingId: idSchema,
        response: z.enum(["accepted", "declined", "tentative"]),
        revision: z.number().int(),
      })
      .strict()
      .parse(raw);
    const o = this.outing(data.outingId);
    return this.lock(o.id, async () => {
      this.evaluate(o);
      if (closed.has(o.status) || o.status === "draft")
        throw new Error("This outing is closed for responses.");
      if (o.migrationPaused && id !== o.organizerId)
        throw new Error(
          "The organizer must review this imported outing before responses resume.",
        );
      const p = o.people.find((p) => p.userId === id);
      if (!p) throw new Error("Join the outing before responding.");
      if (data.revision !== o.revision)
        throw new Error(
          "The plan changed. Review the latest version first.",
        );
      if (
        p.response === data.response &&
        p.revision === o.revision &&
        !p.conflict
      )
        return this.view(o.id, id);
      if (
        !active(p) &&
        id !== o.organizerId &&
        data.response !== "declined"
      )
        throw new Error(
          "Your reserved place was released. Use Join to check availability again.",
        );
      if (
        data.response === "accepted" &&
        o.kind !== "connection_test" &&
        Date.parse(
          o.routes.find((r) => r.participantId === id)?.departAt ||
            o.routes.find((r) => r.participantId === id)?.meetAt,
        ) <= Date.now()
      )
        throw new Error(
          "Your proposed departure time has passed. Ask the organizer to revise the journey before accepting.",
        );
      if (
        data.response === "tentative" &&
        !["pending", "tentative"].includes(p.response)
      )
        p.reservedUntil = this.reservationEnd(o);
      if (data.response === "accepted" && o.pendingTransport?.includes(id))
        throw new Error(
          "Your lift is not arranged yet. Wait for a replacement driver or ask the organizer to review your transport.",
        );
      o.migrationPaused = false;
      Object.assign(p, {
        response: data.response,
        source: "app",
        revision: o.revision,
        answeredAt: iso(),
        conflict: null,
        journeyReview: false,
      });
      o.version++;
      if (id !== o.organizerId)
        this.organizerNotice(
          o,
          `${p.preferences.name} · ${data.response}`,
          "Their answer is on the outing page.",
        );
      this.rideNotices(o, id);
      this.evaluate(o);
      await this.store.persist();
      return this.view(o.id, id);
    });
  }
  async comment(id, raw) {
    const data = z
        .object({
          outingId: idSchema,
          text: z.string().trim().min(1).max(2000),
          replyTo: idSchema.optional(),
        })
        .strict()
        .parse(raw),
      o = this.outing(data.outingId);
    if (
      !o.people.some((p) => p.userId === id && active(p)) ||
      o.status === "draft" ||
      closed.has(o.status)
    )
      throw new Error("Only invited participants can comment.");
    const parent =
      data.replyTo && o.comments.find((c) => c.id === data.replyTo);
    if (data.replyTo && !parent)
      throw new Error("The comment you replied to was not found.");
    const c = {
      id: randomUUID(),
      authorId: id,
      text: data.text,
      replyTo: data.replyTo,
      createdAt: iso(),
    };
    o.comments.push(c);
    for (const userId of new Set(
      [o.organizerId, parent?.authorId].filter((p) => p && p !== id),
    )) {
      if (!o.people.some((p) => p.userId === userId && active(p))) continue;
      const u = this.user(userId);
      this.mail({
        to: u.email,
        recipientId: userId,
        senderId: id,
        subject: "New comment on your StarGazer outing",
        text: "A participant posted a comment. Open the outing page to read it and reply.",
        link: `${this.baseUrl}/outing/${o.id}`,
      });
    }
    await this.store.persist();
    return this.view(o.id, id);
  }
  async weather(id, raw) {
    const o = this.outing(raw.outingId);
    this.owner(o, id);
    const version = o.version,
      forecast = await this.forecast(o.site.location);
    const weather = assessWeather(
      forecast,
      Date.parse(o.start),
      Date.parse(o.end),
      o.limits,
    );
    if (weather.reason === "missing_weather")
      throw new Error(
        "No complete forecast for this time. The previous report has been retained.",
      );
    return this.lock(o.id, async () => {
      if (o.version !== version)
        throw new Error("The outing changed. Refresh its forecast again.");
      o.weather = weather;
      o.weatherError = null;
      o.version++;
      this.evaluate(o);
      await this.store.persist();
      return this.view(o.id, id);
    });
  }
  async edit(id, raw) {
    const data = z
        .object({
          outingId: idSchema,
          start: instant,
          end: instant,
          site: siteSchema,
          deadline: instant.optional(),
          availability: z
            .object({ start: instant, end: instant })
            .strict()
            .optional(),
        })
        .strict()
        .parse(raw),
      o = this.outing(data.outingId);
    this.owner(o, id);
    this.evaluate(o);
    if (closed.has(o.status)) throw new Error("This outing is closed.");
    if (
      Date.parse(data.start) <= Date.now() ||
      Date.parse(data.end) <= Date.parse(data.start) ||
      Date.parse(data.end) - Date.parse(data.start) > 12 * 3600000
    )
      throw new Error("Choose a future observing window, up to 12 hours.");
    const version = o.version,
      next = {
        ...o,
        start: data.start,
        end: data.end,
        site: data.site,
      };
    if (data.availability) {
      const problem = planningWindowProblem({
        ...data.availability,
        durationMinutes: 0,
      });
      if (problem) throw new Error(problem.message);
      if (
        Date.parse(data.availability.start) > Date.parse(data.start) ||
        Date.parse(data.availability.end) < Date.parse(data.end)
      )
        throw new Error(
          "Your available hours must contain the observing time and leave room for the complete journey.",
        );
    }
    const people = structuredClone(o.people);
    const organizer = people.find((p) => p.userId === id);
    const availabilityChanged = Boolean(
      data.availability &&
        JSON.stringify(organizer.availability) !==
          JSON.stringify([data.availability]),
    );
    if (data.availability) organizer.availability = [data.availability];
    const isTest = o.kind === "connection_test";
    let material =
      o.start !== data.start ||
      o.end !== data.end ||
      o.site.name !== data.site.name ||
      o.site.walkMinutes !== data.site.walkMinutes ||
      JSON.stringify(o.site.location) !==
        JSON.stringify(data.site.location) ||
      JSON.stringify(o.site.meetingPoint) !==
        JSON.stringify(data.site.meetingPoint);
    if (
      !isTest &&
      !data.site.accessWindows.some(
        (w) =>
          Date.parse(w.start) <=
            Date.parse(data.start) - (15 + data.site.walkMinutes) * 60000 &&
          Date.parse(w.end) >=
            Date.parse(data.end) + (15 + data.site.walkMinutes) * 60000,
      )
    )
      throw new Error("The access window must include setup and pack-up.");
    const sky = !material
      ? o.astronomy
      : isTest
        ? null
        : assessSky(
            data.site.location,
            Date.parse(data.start),
            Date.parse(data.end),
            o.target,
          );
    if (material && sky && !sky.suitable)
      throw new Error(
        "The revised observing window is not dark enough or the target is too low.",
      );
    const weather = !material
      ? o.weather
      : isTest
        ? null
        : assessWeather(
            await this.forecast(data.site.location),
            Date.parse(data.start),
            Date.parse(data.end),
            o.limits,
          );
    if (material && weather && !weather.suitable)
      throw new Error(
        "The revised forecast does not meet the planning limits.",
      );
    const travel =
      !material && !availabilityChanged
        ? {
            routes: o.routes,
            carpools: o.carpools,
            pendingTransport: o.pendingTransport || [],
            modes: Object.fromEntries(
              o.people.map((p) => [p.userId, p.transport]),
            ),
          }
        : isTest
          ? {
              routes: [],
              carpools: [],
              modes: Object.fromEntries(
                o.people.map((p) => [p.userId, p.transport]),
              ),
            }
          : await this.routesFor(next, people.filter(active), {
              allowPending: Boolean(o.pendingTransport?.length),
            });
    if (
      availabilityChanged &&
      o.people.some(
        (p) =>
          active(p) &&
          this.journeySignature(o, p.userId) !==
            this.journeySignature(travel, p.userId),
      )
    )
      material = true;
    return this.lock(o.id, async () => {
      if (o.version !== version)
        throw new Error(
          "The outing changed while the revision was being checked. Try again.",
        );
      const deadline =
        data.deadline ||
        (Date.parse(o.deadline) > Date.now() &&
        Date.parse(o.deadline) < Date.parse(data.start)
          ? o.deadline
          : new Date(
              Date.parse(data.start) - (isTest ? 1 : 30) * 60000,
            ).toISOString());
      if (
        Date.parse(deadline) <= Date.now() ||
        Date.parse(deadline) >= Date.parse(data.start)
      )
        throw new Error(
          "Set a future response deadline before the outing.",
        );
      const deadlineChanged = o.deadline !== deadline;
      o.migrationPaused = false;
      Object.assign(o, {
        start: data.start,
        end: data.end,
        site: data.site,
        deadline,
        astronomy: sky,
        weather,
        routes: travel.routes,
        carpools: travel.carpools,
        pendingTransport: travel.pendingTransport || [],
      });
      if (data.availability)
        o.people.find((p) => p.userId === id).availability = [
          data.availability,
        ];
      o.version++;
      if (material) {
        o.revision++;
        o.confirmationNotified = false;
        for (const p of o.people.filter(active)) {
          p.response = "pending";
          p.conflict = null;
          p.reservedUntil = deadline;
          p.transport = travel.modes[p.userId];
        }
        o.status = o.status === "draft" ? "draft" : "needs_review";
        o.reasons = ["The plan changed. Please reconfirm on this page."];
        if (o.status !== "draft")
          this.notify(
            o,
            "Plan changed · please reconfirm",
            "Review the new time, site and ride on the outing page. An old Calendar Yes does not confirm this revision.",
          );
      } else if (deadlineChanged && o.status !== "draft") {
        this.notify(
          o,
          "Response deadline updated",
          `Please respond by ${deadline}.`,
        );
      }
      await this.store.persist();
      return this.view(o.id, id);
    });
  }
  async cancel(id, raw) {
    const data = z
        .object({
          outingId: idSchema,
          reason: z.string().trim().min(1).max(1000),
        })
        .strict()
        .parse(raw),
      o = this.outing(data.outingId);
    this.owner(o, id);
    return this.lock(o.id, async () => {
      if (closed.has(o.status))
        throw new Error("This outing is already closed.");
      const wasDraft = o.status === "draft" || o.unpublished;
      o.unpublished = wasDraft;
      o.migrationPaused = false;
      o.status = "cancelled";
      o.version++;
      o.reasons = [data.reason];
      if (!wasDraft) this.notify(o, "Outing cancelled", data.reason);
      await this.store.persist();
      return this.view(o.id, id);
    });
  }
  async createTest(id, raw) {
    const data = z
      .object({
        guestEmail: z.email(),
        start: instant,
        timezone: z.string(),
        channel: z.enum(["email", "calendar"]).default("calendar"),
      })
      .strict()
      .parse(raw);
    new Intl.DateTimeFormat("en", {
      timeZone: data.timezone,
    }).format();
    if (Date.parse(data.start) < Date.now() + 5 * 60000)
      throw new Error("Choose a test time at least five minutes ahead.");
    const owner = this.user(id),
      guest = this.identity.user(data.guestEmail.toLowerCase());
    if (owner.id === guest.id)
      throw new Error("Use a second account you control.");
    if (
      data.channel === "calendar" &&
      !this.providers.status(id).googleConnected
    )
      throw new Error(
        "Connect the organizer’s Google account in Settings before sending a Calendar test.",
      );
    const basic = (u) => ({
      name: u.preferences?.name || u.email.split("@")[0],
      avatar: "star",
      timezone: data.timezone,
      interests: [],
      experience: "beginner",
      happyToTeach: false,
      equipment: [],
      shareEquipment: false,
      origin: {
        name: "Invitation connection test",
        location: { lat: 0, lon: 0 },
      },
      slots: [],
      travel: ["walk"],
      maxWalkMinutes: 0,
      maxTravelMinutes: 1,
      channel: u.id === id ? "email" : data.channel,
    });
    const o = {
      id: randomUUID(),
      kind: "connection_test",
      organizerId: id,
      title: `Star Gazer · ${data.channel === "calendar" ? "Calendar" : "Email"} connection test`,
      target: "stargazing",
      visibility: "circle",
      status: "invited",
      revision: 1,
      version: 1,
      start: data.start,
      end: new Date(Date.parse(data.start) + 1800000).toISOString(),
      timezone: data.timezone,
      site: {
        id: "connection-test",
        name: "Local connection test",
        location: { lat: 0, lon: 0 },
        meetingPoint: { lat: 0, lon: 0 },
        walkMinutes: 0,
        access: "confirmed",
        accessNote: "Invitation test only. No physical outing is planned.",
        accessWindows: [
          {
            start: data.start,
            end: new Date(Date.parse(data.start) + 1800000).toISOString(),
          },
        ],
        bortle: null,
        skyQualitySource: null,
      },
      minPeople: 2,
      maxPeople: 2,
      deadline: data.start,
      people: [owner, guest].map((u) => ({
        userId: u.id,
        preferences: basic(u),
        channel: u.id === id ? "email" : data.channel,
        response: u.id === id ? "accepted" : "pending",
        revision: 1,
        transport: "walk",
        reservedUntil: data.start,
      })),
      comments: [],
      routes: [],
      carpools: [],
      equipment: [],
      limits: {},
      createdAt: iso(),
    };
    this.data.outings.unshift(o);
    this.notice(
      o,
      o.people[1],
      o.title,
      `Try Accept or Decline ${data.channel === "calendar" ? "in Calendar or " : ""}on the outing page. This is a connection test, not a physical outing.`,
    );
    this.queueCalendar(o);
    await this.store.persist();
    return this.view(o.id, id);
  }
}
