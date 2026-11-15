import { Temporal } from "@js-temporal/polyfill";
import { z } from "zod";
import { isTimezone, location } from "../../src/schema.js";

const clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const day = z.iso.date();
export const slotSchema = z
  .object({
    date: day,
    from: clock,
    until: clock,
    weekly: z.boolean().default(false),
    through: day.optional(),
  })
  .strict()
  .refine(
    (v) => !v.through || v.through >= v.date,
    "Recurrence end must follow its first date",
  );
export const pointSchema = z
  .object({ name: z.string().trim().min(1).max(180), location })
  .strict();
export const preferencesSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    avatar: z.enum(["saturn", "moon", "star", "comet"]).default("star"),
    timezone: z.string().refine(isTimezone, "Use an IANA timezone"),
    interests: z
      .array(
        z.enum([
          "Planets",
          "Stargazing",
          "Photography",
          "Learning",
          "Social evenings",
          "Open to anything",
        ]),
      )
      .max(6)
      .default([]),
    interestNote: z.string().trim().max(1000).default(""),
    experience: z.enum(["beginner", "experienced"]).default("beginner"),
    happyToTeach: z.boolean().default(false),
    equipment: z
      .array(z.enum(["telescope", "binoculars", "camera", "tripod"]))
      .max(4)
      .default([]),
    shareEquipment: z.boolean().default(false),
    channel: z.enum(["email", "calendar"]).default("email"),
    origin: pointSchema,
    slots: z.array(slotSchema).min(1).max(12),
    travel: z
      .array(z.enum(["drive", "ride", "bicycle", "walk"]))
      .min(1)
      .max(4),
    car: z
      .object({
        available: z.boolean(),
        offerRides: z.boolean(),
        passengerSeats: z.number().int().min(0).max(7),
        maxDetourMinutes: z.number().int().min(0).max(120),
        pickupPoints: z.array(pointSchema).max(3).default([]),
      })
      .strict()
      .optional(),
    pickup: pointSchema.optional(),
    maxTravelMinutes: z.number().int().min(1).max(240).default(60),
    maxWalkMinutes: z.number().int().min(0).max(120).default(20),
    preference: z
      .enum(["best_sky", "shortest_journey", "balanced"])
      .default("balanced"),
  })
  .strict();

// A remembered profile can grow from a single join; planning validates the full set.
export const profileSchema = preferencesSchema.partial();

// An in-progress form is a snapshot, not a patch to saved preferences. Missing
// fields stay unknown instead of gaining defaults before matching sees them.
export const discoveryPreferencesSchema = z
  .object(
    Object.fromEntries(
      Object.entries(preferencesSchema.shape).map(([name, schema]) => [
        name,
        (schema instanceof z.ZodDefault
          ? schema.removeDefault()
          : schema
        ).optional(),
      ]),
    ),
  )
  .strict();

// Recurrences stay in wall-clock time in the participant's timezone. Never add
// seven UTC days: that would move an evening after a daylight-saving change.
export function expandSlots(slots, timezone, from, until) {
  const result = [];
  for (const slot of slots) {
    let date = Temporal.PlainDate.from(slot.date);
    const last = Temporal.Instant.from(until)
      .toZonedDateTimeISO(timezone)
      .toPlainDate();
    const first = Temporal.Instant.from(from)
      .toZonedDateTimeISO(timezone)
      .toPlainDate()
      .subtract({ days: 1 });
    if (slot.weekly && Temporal.PlainDate.compare(date, first) < 0) {
      const days = date.until(first).days;
      date = date.add({ days: Math.floor(days / 7) * 7 });
    }
    for (
      let i = 0;
      i < 110 && Temporal.PlainDate.compare(date, last) <= 0;
      i++
    ) {
      if (slot.through && date.toString() > slot.through) break;
      const endDate =
        slot.until <= slot.from ? date.add({ days: 1 }) : date;
      // Follow local calendar clocks: repeated times use the earlier occurrence;
      // missing spring-forward times move forward by the clock-change gap.
      const start = Temporal.ZonedDateTime.from(
        `${date}T${slot.from}[${timezone}]`,
        { disambiguation: "compatible" },
      ).toInstant();
      const end = Temporal.ZonedDateTime.from(
        `${endDate}T${slot.until}[${timezone}]`,
        { disambiguation: "compatible" },
      ).toInstant();
      if (
        Temporal.Instant.compare(end, start) > 0 &&
        Temporal.Instant.compare(end, Temporal.Instant.from(from)) >= 0 &&
        Temporal.Instant.compare(start, Temporal.Instant.from(until)) <= 0
      )
        result.push({ start: start.toString(), end: end.toString() });
      if (!slot.weekly) break;
      date = date.add({ days: 7 });
    }
  }
  return result.sort((a, b) => a.start.localeCompare(b.start));
}

export function plannerPerson(
  user,
  preferences,
  transport,
  from,
  until,
  target = "stargazing",
) {
  const p = preferencesSchema.parse(preferences);
  return {
    id: user.id,
    name: p.name,
    email: user.email,
    timezone: p.timezone,
    origin: p.origin.location,
    // Interests rank offers, they do not exclude a person who explicitly chose an outing.
    interests: [target],
    experience: p.experience,
    happyToTeach: p.happyToTeach,
    equipment: p.equipment,
    shareEquipment: p.shareEquipment,
    transport,
    ...(transport === "drive"
      ? {
          car: p.car || {
            available: false,
            offerRides: false,
            passengerSeats: 0,
            maxDetourMinutes: 0,
          },
        }
      : {}),
    ...(transport === "ride" ? { pickup: p.pickup || p.origin } : {}),
    maxTravelMinutes: p.maxTravelMinutes,
    maxWalkMinutes: p.maxWalkMinutes,
    groupSize: { min: 1, max: 8 },
    preference: p.preference,
    availability: expandSlots(p.slots, p.timezone, from, until),
  };
}
