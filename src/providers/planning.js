import { z } from "zod";
import { location } from "../schema.js";

export const researchedSite = z
  .object({
    name: z.string().trim().min(1).max(120),
    location,
    meetingPoint: location,
    walkMinutes: z.number().int().min(0).max(120),
    source: z.string().trim().min(1).max(500),
  })
  .strict();
