import { z } from 'zod';
import { planningWindowProblem } from './planning-window.js';

export const instant = z.iso.datetime({ offset: true });
export const location = z.object({ lat: z.number().min(-90).max(90), lon: z.number().min(-180).max(180) }).strict();
export const target = z.enum(['Saturn', 'Jupiter', 'Mars', 'Moon', 'stargazing']);
export const mode = z.enum(['drive', 'bicycle', 'walk', 'ride']);
export const preference = z.enum(['best_sky', 'shortest_journey', 'balanced']);
export const interval = z.object({ start: instant, end: instant }).strict().refine(
  v => Date.parse(v.end) > Date.parse(v.start), 'End must follow start');
const pickupPoint = z.object({ name: z.string().min(1).max(120), location }).strict();
export const profile = z.object({
  id: z.string().regex(/^[a-z0-9-]{1,40}$/),
  name: z.string().min(1).max(100),
  email: z.email(),
  origin: location,
  timezone: z.string().refine(isTimezone, 'Use an IANA timezone'),
  interests: z.array(target).min(1),
  experience: z.enum(['beginner', 'experienced']),
  happyToTeach: z.boolean(),
  equipment: z.array(z.enum(['telescope', 'binoculars', 'camera', 'tripod'])),
  shareEquipment: z.boolean(),
  transport: mode,
  car: z.object({
    available: z.boolean(),
    offerRides: z.boolean(),
    passengerSeats: z.number().int().min(0).max(7),
    maxDetourMinutes: z.number().int().min(0).max(120),
    pickupPoints: z.array(pickupPoint).max(3).optional(),
  }).strict().optional(),
  pickup: pickupPoint.optional(),
  maxTravelMinutes: z.number().int().min(1).max(240),
  maxWalkMinutes: z.number().int().min(0).max(120),
  groupSize: z.object({ min: z.number().int().min(1).max(8), max: z.number().int().min(1).max(8) }).strict()
    .refine(v => v.max >= v.min, 'Invalid group size'),
  preference,
  availability: z.array(interval).min(1).max(30),
}).strict().superRefine((v, ctx) => {
  if (v.transport === 'drive' && !v.car) ctx.addIssue({ code: 'custom', path: ['car'], message: 'Driving requires explicit car availability, lift offer, passenger seats and detour limit' });
  if (v.car?.offerRides && (!v.car.available || v.car.passengerSeats < 1 || v.transport !== 'drive')) ctx.addIssue({ code: 'custom', path: ['car'], message: 'A lift offer requires an available car, at least one passenger seat and driving transport' });
});
export const site = z.object({
  id: z.string().regex(/^[a-z0-9-]{1,40}$/), name: z.string().min(1).max(120),
  location,
  // Geoapify journeys end at this meeting point; allow for the walk each way.
  meetingPoint: location,
  walkMinutes: z.number().int().min(0).max(120),
  access: z.enum(['confirmed', 'unverified', 'closed']),
  accessNote: z.string().min(1).max(1000),
  accessWindows: z.array(interval).min(1).max(30),
  bortle: z.number().int().min(1).max(9).nullable(),
  skyQualitySource: z.string().max(500).nullable(),
}).strict().refine(v => v.bortle === null || Boolean(v.skyQualitySource), 'A Bortle estimate needs a source');
export const request = z.object({
  organizerId: z.string().min(1), target,
  start: instant, end: instant,
  timezone: z.string().refine(isTimezone, 'Use an IANA timezone'),
  durationMinutes: z.number().int().min(30).max(180).default(60),
  minPeople: z.number().int().min(1).max(8).default(2),
  maxPeople: z.number().int().min(1).max(8).default(4),
  needsGuide: z.boolean().default(false),
  trafficModel: z.enum(['approximated', 'free_flow']).default('approximated'),
  drivingBufferMinutes: z.number().int().min(0).max(60).default(10),
  pickupStopMinutes: z.number().int().min(0).max(15).default(3),
  maxCloudCover: z.number().min(0).max(100).default(40),
  maxWindKmh: z.number().min(0).max(80).default(25),
  minTemperatureC: z.number().min(-50).max(40).default(-5),
  maxPrecipitationProbability: z.number().min(0).max(100).default(20),
}).strict().superRefine((v, ctx) => {
  const problem = planningWindowProblem(v);
  if (problem) ctx.addIssue({ code: 'custom', path: [problem.field], message: problem.message });
  if (v.minPeople > v.maxPeople) ctx.addIssue({ code: 'custom', message: 'minPeople exceeds maxPeople' });
});
export const planInput = z.object({ request, participants: z.array(profile).min(1).max(8), sites: z.array(site).min(1).max(8) }).strict()
  .superRefine((v, ctx) => {
    if (!v.participants.some(p => p.id === v.request.organizerId)) ctx.addIssue({ code: 'custom', message: 'Organizer must be a participant' });
    for (const [label, items] of [['participants', v.participants], ['sites', v.sites]]) {
      if (new Set(items.map(p => p.id)).size !== items.length) ctx.addIssue({ code: 'custom', message: `Duplicate ${label} IDs` });
    }
    if (new Set(v.participants.map(p => p.email.toLowerCase())).size !== v.participants.length) ctx.addIssue({ code: 'custom', message: 'Duplicate participant emails' });
  });
export function isTimezone(value) {
  try { new Intl.DateTimeFormat('en', { timeZone: value }).format(); return true; } catch { return false; }
}
export function parse(schema, value) { return schema.parse(value); }
