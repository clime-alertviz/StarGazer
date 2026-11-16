import { Temporal } from "@js-temporal/polyfill";
import { isDeepStrictEqual } from 'node:util';
import { preferencesSchema } from './availability.js';

function slot(start, end, timezone) {
  const a = Temporal.Instant.from(start).toZonedDateTimeISO(timezone),
    b = Temporal.Instant.from(end).toZonedDateTimeISO(timezone);
  return {
    date: a.toPlainDate().toString(),
    from: a.toPlainTime().toString().slice(0, 5),
    until: b.toPlainTime().toString().slice(0, 5),
    weekly: false,
  };
}
// The v2 shape lets us recognize exact fallback profiles already saved.
function oldPreferences(person, entry, plan) {
  const timezone =
    person.timezone ||
    plan?.request.timezone ||
    Intl.DateTimeFormat().resolvedOptions().timeZone;
  const start = plan?.meetingStart || new Date().toISOString(),
    end = plan?.meetingEnd || new Date(Date.now() + 3600000).toISOString();
  return {
    name: person.name,
    avatar: entry?.avatar || "star",
    timezone,
    interests: person.interests?.some((t) => t !== "stargazing")
      ? ["Planets", "Stargazing"]
      : ["Stargazing"],
    interestNote: "",
    experience: person.experience || "beginner",
    happyToTeach: person.happyToTeach || false,
    equipment: person.equipment || [],
    shareEquipment: person.shareEquipment || false,
    channel: entry?.invitationChannel || "email",
    origin: {
      name: entry?.displayPlace || "Public meeting point",
      location: person.origin ||
        plan?.site.meetingPoint || { lat: 0, lon: 0 },
    },
    slots: (person.availability?.length
      ? person.availability
      : [{ start, end }]
    )
      .slice(0, 12)
      .map((w) => slot(w.start, w.end, timezone)),
    travel: [person.transport || "walk"],
    ...(person.car ? { car: person.car } : {}),
    ...(person.pickup ? { pickup: person.pickup } : {}),
    maxTravelMinutes: person.maxTravelMinutes || 60,
    maxWalkMinutes: person.maxWalkMinutes || 20,
    preference: person.preference || "balanced",
  };
}

function preferences(person, entry, plan) {
  const p = oldPreferences(person, entry, plan);
  if (!person.origin) delete p.origin;
  if (!person.availability?.length) delete p.slots;
  if (!person.transport) delete p.travel;
  // An invitation connection test is not a source of real travel preferences.
  if (plan?.mode === 'calendar_test' && !entry) {
    delete p.origin;
    delete p.slots;
    delete p.travel;
  }
  return p;
}

function repairFallbackProfiles(hub) {
  for (const record of hub.store.state.outings) {
    const plan = record.plan;
    for (const person of plan?.participants || []) {
      const user = hub.data.users.find(u => u.email === person.email?.toLowerCase());
      const entry = hub.store.state.profiles.find(e => e.profile.email === person.email);
      // Preserve anything a person has changed since import. Only remove the
      // exact synthetic values from the old migration, never inferred real data.
      if (user && isDeepStrictEqual(user.preferences, oldPreferences(person, entry, plan)))
        user.preferences = preferences(person, entry, plan);
    }
  }
}

// Copy existing local records once; the original tables are preserved. Imported
// Calendar events keep their IDs and are not rewritten by migration or startup.
export async function migrateLegacy(hub) {
  if (hub.data.legacyImportVersion >= 3) return;
  if (hub.data.legacyImportVersion >= 2) {
    repairFallbackProfiles(hub);
    hub.data.legacyImportVersion = 3;
    await hub.store.persist();
    return;
  }
  for (const entry of hub.store.state.profiles) {
    const u = hub.identity.user(entry.profile.email);
    u.preferences ||= preferences(entry.profile, entry);
  }
  for (const record of hub.store.state.outings) {
    const p = record.plan;
    if (!p?.participants?.length || !p.request || !p.site) continue;
    const c = record.coordination || {
      status: record.invitation?.eventId ? "invited" : "draft",
      revision: 1,
      comments: [],
      deadline: new Date(
        Date.parse(p.meetingStart || p.observingStart) - 30 * 60000,
      ).toISOString(),
      people: p.participants.map((person) => ({
        ...person,
        response:
          person.id === p.request.organizerId ? "accepted" : "pending",
        revision: 1,
        channel: "email",
      })),
    };
    if (
      !p.participants ||
      p.mode === "demo" ||
      hub.data.outings.some((o) => o.id === record.id)
    )
      continue;
    const ids = new Map(
      p.participants.map((person) => [
        person.id,
        hub.identity.user(person.email).id,
      ]),
    );
    const people = c.people.map((member) => {
      const person =
          p.participants.find((p) => p.id === member.id) || member,
        u = hub.identity.user(member.email),
        entry = hub.store.state.profiles.find(
          (e) => e.profile.id === member.id,
        ),
        prefs = preferences(person, entry, p);
      u.preferences ||= prefs;
      return {
        userId: u.id,
        preferences: prefs,
        needsDetails: p.mode !== 'calendar_test' && !preferencesSchema.safeParse(prefs).success,
        response: member.response,
        revision: member.revision || 1,
        source: member.source,
        answeredAt: member.answeredAt,
        calendarStatus: member.calendarStatus,
        observedAt: member.observedAt,
        channel:
          p.mode === "calendar_test"
            ? member.channel || "email"
            : prefs.channel,
        transport: person.transport || "walk",
        reservedUntil: c.deadline,
      };
    });
    const remap = (point) => ({
      ...point,
      participantId: ids.get(point.participantId) || point.participantId,
    });
    hub.data.outings.push({
      id: record.id,
      legacy: true,
      migrationPaused: true,
      unpublished: c.status === "draft",
      kind: p.mode === "calendar_test" ? "connection_test" : "outing",
      organizerId: ids.get(p.request.organizerId),
      title:
        p.mode === "calendar_test"
          ? "Calendar connection test"
          : `${p.request.target} · ${p.site.name}`,
      visibility: "circle",
      status: c.status,
      revision: c.revision || 1,
      version: 1,
      target: p.request.target,
      start: p.observingStart,
      end: p.observingEnd,
      timezone: p.request.timezone,
      site: {
        id: p.site.id || "imported-site",
        access: "confirmed",
        accessNote:
          "Imported meeting location. Review access before a physical outing.",
        accessWindows: [{ start: p.meetingStart, end: p.meetingEnd }],
        bortle: null,
        skyQualitySource: null,
        ...p.site,
        walkMinutes: p.site.walkMinutes || 0,
      },
      minPeople: p.request.minPeople,
      maxPeople: p.request.maxPeople,
      deadline: c.deadline,
      people,
      equipment: p.equipment || [],
      astronomy: p.astronomy,
      weather: c.weather || p.weather,
      limits: p.request,
      traffic: p.traffic,
      routes: (p.routes || []).map(remap),
      carpools: (p.carpools || []).map((car) => ({
        ...car,
        driverId: ids.get(car.driverId),
        passengerIds: car.passengerIds.map((id) => ids.get(id)),
        pickups: car.pickups.map(remap),
      })),
      comments: (c.comments || []).map((comment) => ({
        id: comment.id,
        authorId: ids.get(comment.authorId),
        text: comment.text,
        replyTo: comment.replyTo,
        createdAt: comment.createdAt,
      })),
      everConfirmed: c.everConfirmed,
      confirmationNotified: c.everConfirmed,
      reasons: c.reasons || [],
      createdAt: record.savedAt,
      ...(record.invitation?.eventId
        ? {
            calendar: {
              id: record.invitation.eventId,
              url: record.invitation.url,
              state: "needs_connection",
              checkedAt: c.checkedAt,
              error:
                "Connect the organizer’s Google account in Settings to synchronize this existing event.",
            },
          }
        : {}),
    });
  }
  hub.data.legacyImported = true;
  hub.data.legacyImportVersion = 3;
  await hub.store.persist();
}
