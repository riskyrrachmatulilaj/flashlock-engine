import { z } from "zod";

export const reserveParamsSchema = z.object({
  id: z.string().uuid("Invalid sale ID format"),
});

export const reserveBodySchema = z.object({
  quantity: z.number().int().min(1, "Quantity must be at least 1").max(2, "Quantity cannot exceed 2").default(1),
  idempotencyKey: z.string().optional(),
});

export type ReserveParams = z.infer<typeof reserveParamsSchema>;
export type ReserveBody = z.infer<typeof reserveBodySchema>;

export const payParamsSchema = z.object({
  id: z.string().uuid("Invalid reservation ID format"),
});

export const payBodySchema = z
  .object({
    delayMs: z.number().int().min(0).max(60000).optional(),
    forceOutcome: z.enum(["succeeded", "failed"]).optional(),
  })
  .nullish()
  .default({});

export type PayParams = z.infer<typeof payParamsSchema>;
export type PayBody = z.infer<typeof payBodySchema>;
