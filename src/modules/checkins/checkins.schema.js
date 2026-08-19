import { z } from "zod";

export const scanQrSchema = z.object({
  token: z.string().min(1),
  deviceInfo: z.string().optional(),
});

export const checkinStatsQuerySchema = z.object({
  eventId: z.string().uuid("Invalid event ID format").optional(),
});

export const scanEventIdParamsSchema = z.object({
  eventId: z.string().uuid("Invalid event ID format"),
});

export const checkinListParamsSchema = z.object({
  eventId: z.string().uuid("Invalid event ID format"),
});

export const attendeeLookupQuerySchema = z.object({
  q: z.string().trim().max(255).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  status: z.enum(["PENDING", "CONFIRMED", "CANCELLED"]).optional(),
});

export const undoCheckinParamsSchema = z.object({
  eventId: z.string().uuid("Invalid event ID format"),
  checkInId: z.string().uuid("Invalid check-in ID format"),
});
