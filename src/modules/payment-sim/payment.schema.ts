import { z } from "zod";

export const paymentWebhookSchema = z
  .object({
    eventId: z.string().optional(),
    event: z.enum(["payment.succeeded", "payment.failed"]),
    data: z
      .object({
        reservationId: z.string().uuid("Invalid reservation ID format"),
        saleId: z.string().uuid().optional(),
        userId: z.string().optional(),
        paymentReference: z.string().optional(),
        amount: z.number().optional(),
      })
      .optional(),
    reservationId: z.string().uuid().optional(),
    saleId: z.string().uuid().optional(),
    userId: z.string().optional(),
    paymentReference: z.string().optional(),
  })
  .refine((val) => Boolean(val.data?.reservationId || val.reservationId), {
    message: "reservationId is required in data or root payload",
  });

export type PaymentWebhookInput = z.infer<typeof paymentWebhookSchema>;
