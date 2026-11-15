import { z } from "zod";
import { Temporal } from "@js-temporal/polyfill";
import { preferencesSchema, pointSchema } from "./availability.js";
import { setupMinutes, packUpMinutes } from "../../src/timing.js";

export const joinDetailsSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    mode: z.enum(["self", "ride", "drive"]),
    channel: z.enum(["email", "calendar"]).optional(),
    confirmed: z.literal(true),
    origin: pointSchema.optional(),
    pickupId: z.string().max(200).optional(),
    maxWalkMinutes: z.number().int().min(0).max(120).optional(),
    maxTravelMinutes: z.number().int().min(1).max(240).optional(),
    car: preferencesSchema.shape.car.optional(),
    equipment: preferencesSchema.shape.equipment.optional(),
    shareEquipment: z.boolean().default(false),
    happyToTeach: z.boolean().default(false),
  })
  .strict();

export function meetingTimes(o) {
  return {
    meetAt: new Date(
      Date.parse(o.start) - (setupMinutes + o.site.walkMinutes) * 60000,
    ).toISOString(),
    leaveAt: new Date(
      Date.parse(o.end) + (packUpMinutes + o.site.walkMinutes) * 60000,
    ).toISOString(),
  };
}
export function prepareJoin(user, o, raw, options) {
  const d = joinDetailsSchema.parse(raw),
    saved = user.preferences || {};
  const choice = d.pickupId
    ? options.pickups.find((p) => p.id === d.pickupId)
    : null;
  if (d.pickupId && !choice)
    throw new Error(
      "That pickup is no longer offered. Choose another or enter a public starting point.",
    );
  if (d.mode !== "self" && !d.origin && !choice)
    throw new Error("Choose a pickup or a public starting point.");
  if (
    d.mode === "drive" &&
    (!d.car?.available || !d.car.offerRides || d.car.passengerSeats < 1)
  )
    throw new Error(
      "Offering lifts needs an available car and at least one spare seat.",
    );
  const timezone = saved.timezone || o.timezone;
  const from = Temporal.Instant.from(o.start)
    .subtract({ hours: 6 })
    .toZonedDateTimeISO(timezone);
  const until = Temporal.Instant.from(o.end)
    .add({ hours: 6 })
    .toZonedDateTimeISO(timezone);
  const origin = d.origin ||
    choice?.point || { name: o.site.name, location: o.site.meetingPoint };
  const preferences = preferencesSchema.parse({
    name: d.name,
    avatar: saved.avatar || "star",
    timezone,
    interests: saved.interests || [],
    interestNote: saved.interestNote || "",
    experience: d.happyToTeach
      ? "experienced"
      : saved.experience || "beginner",
    equipment: d.equipment || [],
    shareEquipment: d.shareEquipment,
    happyToTeach: d.happyToTeach,
    channel: d.channel ?? saved.channel ?? "email",
    origin,
    slots: [
      {
        date: from.toPlainDate().toString(),
        from: from.toPlainTime().toString().slice(0, 5),
        until: until.toPlainTime().toString().slice(0, 5),
        weekly: false,
      },
    ],
    travel: [d.mode === "self" ? "walk" : d.mode],
    ...(d.mode === "drive" ? { car: d.car } : {}),
    ...(d.mode === "ride" ? { pickup: choice?.point || origin } : {}),
    maxWalkMinutes: d.maxWalkMinutes ?? saved.maxWalkMinutes ?? 20,
    maxTravelMinutes: d.maxTravelMinutes ?? saved.maxTravelMinutes ?? 90,
    preference: "balanced",
  });
  // Do not turn the meeting point or this one evening into a permanent profile origin/availability.
  const learned = { name: d.name, channel: preferences.channel };
  if (d.origin) learned.origin = d.origin;
  if (d.mode !== "self") {
    learned.travel = [d.mode];
    learned.maxWalkMinutes = preferences.maxWalkMinutes;
    learned.maxTravelMinutes = preferences.maxTravelMinutes;
  }
  if (d.car) learned.car = d.car;
  // Outing answers may fill missing profile details, never replace saved defaults.
  const remembered = { ...learned, ...saved };
  return { preferences, selfArranged: d.mode === "self", remembered, ...(choice ? { pickupChoice: { driverId: choice.driverId, pickupId: choice.id } } : {}) };
}
