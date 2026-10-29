import { randomUUID } from "crypto";
import { eq } from "drizzle-orm";
import { db as defaultDb } from "../../db/index.js";
import { reservations } from "../../db/schema.js";
import { getRedisClient, type FlashLockRedis } from "../../redis/client.js";
import { env } from "../../config/env.js";
import {
  ChaosPaymentSimulator,
  defaultPaymentSimulator,
} from "../payment-sim/simulator.js";

export interface ReserveInput {
  saleId: string;
  userId: string;
  quantity: number;
  idempotencyKey: string;
}

export type ReserveResult =
  | {
      status: 201;
      data: {
        reservationId: string;
        saleId: string;
        userId: string;
        quantity: number;
        status: string;
        expiresAt: string;
      };
    }
  | {
      status: 200;
      data: {
        reservationId: string;
        saleId: string;
        userId: string;
        quantity: number;
        status: string;
        expiresAt: string;
      };
    }
  | {
      status: 403 | 404 | 409 | 410 | 500;
      error: string;
      message: string;
    };

export interface InitiatePaymentInput {
  reservationId: string;
  userId: string;
  delayMs?: number;
  forceOutcome?: "succeeded" | "failed";
}

export type InitiatePaymentResult =
  | {
      status: 200;
      data: {
        reservationId: string;
        saleId: string;
        userId: string;
        status: string;
        expiresAt: string;
      };
    }
  | {
      status: 400 | 403 | 404 | 409 | 410 | 500;
      error: string;
      message: string;
    };

export class ReserveService {
  constructor(
    private db = defaultDb,
    private redis: FlashLockRedis = getRedisClient(),
    private paymentSimulator: ChaosPaymentSimulator = defaultPaymentSimulator
  ) {}

  async reserveStock(input: ReserveInput): Promise<ReserveResult> {
    const { saleId, userId, quantity, idempotencyKey } = input;
    const resId = randomUUID();
    const now = Date.now();
    const ttlMs = env.HOLD_TTL_SECONDS * 1000;

    const saleStateKey = `sale:${saleId}:state`;
    const userHoldsKey = `sale:${saleId}:user_holds`;
    const expiryQueueKey = `sale:${saleId}:expiry_queue`;
    const reservationKey = `reservation:${resId}`;
    const userPurchasesKey = `sale:${saleId}:user_purchases`;
    const idempotencyKeyRedis = `idempotency:${idempotencyKey}`;

    const rawResult = await this.redis.reserveStock(
      saleStateKey,
      userHoldsKey,
      expiryQueueKey,
      reservationKey,
      userPurchasesKey,
      idempotencyKeyRedis,
      resId,
      userId,
      quantity,
      now,
      ttlMs,
      saleId,
      idempotencyKey
    );

    const resultCode = rawResult[0];

    if (resultCode === "OK_CREATED") {
      const createdResId = rawResult[1];
      const expiresAtMs = Number(rawResult[2]);
      const expiresAtDate = new Date(expiresAtMs);

      // Persist new reservation to PostgreSQL
      try {
        await this.db.insert(reservations).values({
          id: createdResId,
          saleId,
          userId,
          quantity,
          status: "HELD",
          idempotencyKey,
          expiresAt: expiresAtDate,
        });
      } catch (err) {
        // If DB insertion fails, we log it; Redis holds authoritative hot state
        console.error("Failed to persist reservation to PostgreSQL:", err);
      }

      return {
        status: 201,
        data: {
          reservationId: createdResId,
          saleId,
          userId,
          quantity,
          status: "HELD",
          expiresAt: expiresAtDate.toISOString(),
        },
      };
    }

    if (resultCode === "OK_EXISTING") {
      const existingResId = rawResult[1];
      const status = rawResult[2] || "HELD";
      const existingQty = Number(rawResult[3] || quantity);
      const expiresAtMs = Number(rawResult[4] || now + ttlMs);

      return {
        status: 200,
        data: {
          reservationId: existingResId,
          saleId,
          userId,
          quantity: existingQty,
          status,
          expiresAt: new Date(expiresAtMs).toISOString(),
        },
      };
    }

    if (resultCode === "ERR_SALE_NOT_FOUND") {
      return {
        status: 404,
        error: "Not Found",
        message: "Sale not found",
      };
    }

    if (resultCode === "ERR_SALE_NOT_STARTED") {
      return {
        status: 403,
        error: "Forbidden",
        message: "Sale has not started yet",
      };
    }

    if (resultCode === "ERR_USER_ALREADY_PURCHASED") {
      return {
        status: 409,
        error: "Conflict",
        message: "User has already purchased an item for this sale",
      };
    }

    if (resultCode === "ERR_INSUFFICIENT_STOCK") {
      return {
        status: 409,
        error: "Conflict",
        message: "Insufficient stock available",
      };
    }

    if (resultCode === "ERR_SOLD_OUT") {
      return {
        status: 410,
        error: "Gone",
        message: "Sale is sold out",
      };
    }

    return {
      status: 500,
      error: "Internal Server Error",
      message: `Unexpected reservation outcome: ${resultCode}`,
    };
  }

  async initiatePayment(input: InitiatePaymentInput): Promise<InitiatePaymentResult> {
    const { reservationId, userId, delayMs, forceOutcome } = input;
    const resKey = `reservation:${reservationId}`;

    const resData = await this.redis.hgetall(resKey);
    let saleId = resData.sale_id;
    let ownerId = resData.user_id;
    let status = resData.status;
    let quantity = Number(resData.quantity || 1);
    let expiresAtMs = Number(resData.expires_at || 0);

    if (!status) {
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

        saleId = dbRes.saleId;
        ownerId = dbRes.userId;
        status = dbRes.status;
        quantity = dbRes.quantity;
        expiresAtMs = dbRes.expiresAt.getTime();
      } catch (err) {
        return {
          status: 404,
          error: "Not Found",
          message: "Reservation not found",
        };
      }
    }

    // Ownership check
    if (ownerId !== userId) {
      return {
        status: 403,
        error: "Forbidden",
        message: "You do not own this reservation",
      };
    }

    // Check status
    if (status === "CONFIRMED") {
      return {
        status: 200,
        data: {
          reservationId,
          saleId: saleId!,
          userId,
          status: "CONFIRMED",
          expiresAt: new Date(expiresAtMs).toISOString(),
        },
      };
    }

    const now = Date.now();
    if (status === "EXPIRED" || (expiresAtMs > 0 && now >= expiresAtMs)) {
      return {
        status: 410,
        error: "Gone",
        message: "Reservation has expired",
      };
    }

    // Idempotency: if already PAYMENT_PENDING, return current status
    if (status === "PAYMENT_PENDING") {
      return {
        status: 200,
        data: {
          reservationId,
          saleId: saleId!,
          userId,
          status: "PAYMENT_PENDING",
          expiresAt: new Date(expiresAtMs).toISOString(),
        },
      };
    }

    if (status !== "HELD") {
      return {
        status: 409,
        error: "Conflict",
        message: `Reservation cannot be checked out with status ${status}`,
      };
    }

    const extensionMs = env.PAYMENT_EXTENSION_SECONDS * 1000;
    const expiryQueueKey = `sale:${saleId}:expiry_queue`;

    const rawResult = await this.redis.extendHold(
      expiryQueueKey,
      resKey,
      reservationId,
      userId,
      now,
      extensionMs
    );

    const resultCode = rawResult[0];

    if (resultCode === "OK_EXTENDED") {
      const newExpiresAtMs = Number(rawResult[1]);
      const newExpiresAt = new Date(newExpiresAtMs);

      // Persist status change to PostgreSQL
      try {
        await this.db
          .update(reservations)
          .set({
            status: "PAYMENT_PENDING",
            expiresAt: newExpiresAt,
            updatedAt: new Date(now),
          })
          .where(eq(reservations.id, reservationId));
      } catch (err) {
        console.error("Failed to update reservation in PostgreSQL:", err);
      }

      // Trigger Chaos Payment Simulator asynchronously
      this.paymentSimulator.triggerPayment({
        reservationId,
        saleId: saleId!,
        userId,
        quantity,
        delayMs,
        forceOutcome,
      });

      return {
        status: 200,
        data: {
          reservationId,
          saleId: saleId!,
          userId,
          status: "PAYMENT_PENDING",
          expiresAt: newExpiresAt.toISOString(),
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

    if (resultCode === "ERR_UNAUTHORIZED") {
      return {
        status: 403,
        error: "Forbidden",
        message: "You do not own this reservation",
      };
    }

    if (resultCode === "ERR_RESERVATION_EXPIRED") {
      return {
        status: 410,
        error: "Gone",
        message: "Reservation has expired",
      };
    }

    return {
      status: 409,
      error: "Conflict",
      message: `Cannot extend reservation: ${resultCode}`,
    };
  }
}
