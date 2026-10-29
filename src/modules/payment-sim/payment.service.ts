import { randomUUID } from "crypto";
import { eq } from "drizzle-orm";
import { db as defaultDb } from "../../db/index.js";
import { reservations, orders, auditLogs } from "../../db/schema.js";
import { getRedisClient, type FlashLockRedis } from "../../redis/client.js";
import type { PaymentWebhookInput } from "./payment.schema.js";
import { defaultPaymentSimulator } from "./simulator.js";

export type PaymentWebhookResult =
  | {
      status: 200;
      data: {
        status: "CONFIRMED" | "REFUNDED_LATE" | "EXPIRED";
        reservationId: string;
        saleId: string;
        userId: string;
        quantity: number;
        paymentReference?: string;
        message?: string;
      };
    }
  | {
      status: 400 | 404 | 409 | 500;
      error: string;
      message: string;
    };

export class PaymentService {
  constructor(
    private db = defaultDb,
    private redis: FlashLockRedis = getRedisClient()
  ) {}

  async processWebhook(payload: PaymentWebhookInput): Promise<PaymentWebhookResult> {
    const reservationId = payload.data?.reservationId || payload.reservationId!;
    let saleId = payload.data?.saleId || payload.saleId;
    let userId = payload.data?.userId || payload.userId;
    const paymentReference =
      payload.data?.paymentReference ||
      payload.paymentReference ||
      payload.eventId ||
      `pay_${randomUUID()}`;
    const outcome = payload.event === "payment.succeeded" ? "succeeded" : "failed";

    // 1. Resolve saleId and userId if missing
    const reservationKey = `reservation:${reservationId}`;
    const resData = await this.redis.hgetall(reservationKey);

    if (!resData || !resData.sale_id) {
      try {
        const [dbRes] = await this.db
          .select()
          .from(reservations)
          .where(eq(reservations.id, reservationId));

        if (!dbRes) {
          return {
            status: 404,
            error: "Not Found",
            message: "Reservation not found",
          };
        }
        saleId = saleId || dbRes.saleId;
        userId = userId || dbRes.userId;
      } catch (err) {
        return {
          status: 404,
          error: "Not Found",
          message: "Reservation not found",
        };
      }
    } else {
      saleId = saleId || resData.sale_id;
      userId = userId || resData.user_id;
    }

    if (!saleId) {
      return {
        status: 400,
        error: "Bad Request",
        message: "Missing sale ID for reservation",
      };
    }

    const saleStateKey = `sale:${saleId}:state`;
    const expiryQueueKey = `sale:${saleId}:expiry_queue`;
    const userHoldsKey = `sale:${saleId}:user_holds`;
    const userPurchasesKey = `sale:${saleId}:user_purchases`;
    const now = Date.now();

    const result = await this.redis.confirmOrder(
      saleStateKey,
      expiryQueueKey,
      userHoldsKey,
      userPurchasesKey,
      reservationKey,
      reservationId,
      outcome,
      now
    );

    const resultCode = result[0];
    const qty = Number(result[1] || 1);
    const finalUserId = result[2] || userId || "";

    if (resultCode === "OK_CONFIRMED") {
      try {
        await this.db.insert(orders).values({
          reservationId,
          saleId,
          userId: finalUserId,
          quantity: qty,
          status: "CONFIRMED",
          paymentReference,
        });

        await this.db
          .update(reservations)
          .set({
            status: "CONFIRMED",
            updatedAt: new Date(now),
          })
          .where(eq(reservations.id, reservationId));

        await this.db.insert(auditLogs).values({
          saleId,
          reservationId,
          eventType: "ORDER_CONFIRMED",
          payload: { quantity: qty, userId: finalUserId, paymentReference },
        });
      } catch (err) {
        console.error("Failed to persist confirmed order to database:", err);
      }

      return {
        status: 200,
        data: {
          status: "CONFIRMED",
          reservationId,
          saleId,
          userId: finalUserId,
          quantity: qty,
          paymentReference,
        },
      };
    }

    if (resultCode === "OK_ALREADY_CONFIRMED") {
      return {
        status: 200,
        data: {
          status: "CONFIRMED",
          reservationId,
          saleId,
          userId: finalUserId,
          quantity: qty,
          paymentReference,
          message: "Order already confirmed",
        },
      };
    }

    if (resultCode === "LATE_PAYMENT_DETECTED") {
      // Stock was already reclaimed by Reaper and returned to available stock!
      // Invariant preserved: DO NOT touch stock counters!
      try {
        await this.redis.hset(
          reservationKey,
          "status",
          "REFUNDED_LATE",
          "updated_at",
          String(now)
        );

        await this.db
          .update(reservations)
          .set({
            status: "REFUNDED_LATE",
            updatedAt: new Date(now),
          })
          .where(eq(reservations.id, reservationId));

        await this.db.insert(orders).values({
          reservationId,
          saleId,
          userId: finalUserId,
          quantity: qty,
          status: "REFUNDED_LATE",
          paymentReference,
        });

        await this.db.insert(auditLogs).values({
          saleId,
          reservationId,
          eventType: "REFUNDED_LATE",
          payload: {
            quantity: qty,
            userId: finalUserId,
            paymentReference,
            reason: "Late webhook arrived after hold expired and was reaped",
          },
        });
      } catch (err) {
        console.error("Failed to persist late payment refund:", err);
      }

      return {
        status: 200,
        data: {
          status: "REFUNDED_LATE",
          reservationId,
          saleId,
          userId: finalUserId,
          quantity: qty,
          paymentReference,
          message: "Late payment detected and refunded",
        },
      };
    }

    if (resultCode === "OK_EXPIRED_ON_FAILURE" || resultCode === "OK_ALREADY_EXPIRED") {
      try {
        await this.db
          .update(reservations)
          .set({
            status: "EXPIRED",
            updatedAt: new Date(now),
          })
          .where(eq(reservations.id, reservationId));

        await this.db.insert(auditLogs).values({
          saleId,
          reservationId,
          eventType: "PAYMENT_FAILED",
          payload: { quantity: qty, userId: finalUserId, paymentReference },
        });
      } catch (err) {
        console.error("Failed to update expired status in DB:", err);
      }

      return {
        status: 200,
        data: {
          status: "EXPIRED",
          reservationId,
          saleId,
          userId: finalUserId,
          quantity: qty,
          message: "Payment failed, hold released",
        },
      };
    }

    if (resultCode === "ERR_RESERVATION_NOT_FOUND") {
      return {
        status: 404,
        error: "Not Found",
        message: "Reservation not found",
      };
    }

    if (resultCode === "ERR_INVALID_STATUS") {
      return {
        status: 409,
        error: "Conflict",
        message: `Invalid reservation status: ${result[1]}`,
      };
    }

    return {
      status: 500,
      error: "Internal Server Error",
      message: `Unexpected confirmation outcome: ${resultCode}`,
    };
  }
}

export const defaultPaymentService = new PaymentService();

defaultPaymentSimulator.setOnDispatch(async (payload) => {
  await defaultPaymentService.processWebhook(payload);
});
