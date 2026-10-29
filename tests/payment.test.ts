import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fastify, { type FastifyInstance } from "fastify";
import RedisMock from "ioredis-mock";
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from "fastify-type-provider-zod";
import { registerLuaCommands, type FlashLockRedis } from "../src/redis/client.js";
import { ReserveService } from "../src/modules/reservation/reserve.service.js";
import { PaymentService } from "../src/modules/payment-sim/payment.service.js";
import { ChaosPaymentSimulator } from "../src/modules/payment-sim/simulator.js";
import { reserveRoutes } from "../src/modules/reservation/reserve.routes.js";
import { webhookRoutes } from "../src/modules/payment-sim/webhook.routes.js";

describe("Phase 3: Chaos Payment Simulator, Checkout Initiation, and Webhook Race Handling", () => {
  let redis: FlashLockRedis;
  let mockDb: any;
  let simulator: ChaosPaymentSimulator;
  let reserveService: ReserveService;
  let paymentService: PaymentService;
  let app: FastifyInstance;

  const saleId = "a0000000-0000-0000-0000-000000000001";
  const resId = "b0000000-0000-0000-0000-000000000001";
  const userId = "buyer-123";

  const persistedOrders: any[] = [];
  const persistedReservations: any[] = [];
  const persistedAuditLogs: any[] = [];

  beforeEach(async () => {
    persistedOrders.length = 0;
    persistedReservations.length = 0;
    persistedAuditLogs.length = 0;

    const rawMock = new RedisMock();
    redis = registerLuaCommands(rawMock as any);
    await redis.flushall();

    mockDb = {
      insert: () => ({
        values: async (data: any) => {
          if (data.eventType) {
            persistedAuditLogs.push(data);
          } else if (data.paymentReference) {
            persistedOrders.push(data);
          } else {
            persistedReservations.push(data);
          }
          return [data];
        },
      }),
      update: () => ({
        set: (data: any) => ({
          where: async () => {
            persistedReservations.push({ updated: true, ...data });
            return [data];
          },
        }),
      }),
      select: () => ({
        from: () => ({
          where: async () => {
            const found = persistedReservations.find((r) => r.id === resId);
            return found ? [found] : [];
          },
        }),
      }),
    };

    simulator = new ChaosPaymentSimulator({
      minDelayMs: 10,
      maxDelayMs: 20,
      failureRate: 0,
    });

    paymentService = new PaymentService(mockDb, redis);
    simulator.setOnDispatch(async (payload) => {
      await paymentService.processWebhook(payload);
    });

    reserveService = new ReserveService(mockDb, redis, simulator);

    app = fastify({ logger: false }).withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);

    const rateLimiter = async (req: any, reply: any) => {};

    await app.register(reserveRoutes, { reserveService, rateLimiter });
    await app.register(webhookRoutes, { paymentService });
  });

  afterEach(() => {
    simulator.clearAll();
  });

  describe("Task 3.1: Checkout Initiation (POST /api/v1/reservations/:id/pay)", () => {
    it("rejects request if missing x-user-id header with 401", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/api/v1/reservations/${resId}/pay`,
      });

      expect(res.statusCode).toBe(401);
      const body = JSON.parse(res.body);
      expect(body.error).toBe("Unauthorized");
    });

    it("returns 404 if reservation does not exist", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/api/v1/reservations/${resId}/pay`,
        headers: { "x-user-id": userId },
      });

      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.body);
      expect(body.message).toContain("Reservation not found");
    });

    it("returns 403 if authenticated user is not hold owner", async () => {
      const expiryQueueKey = `sale:${saleId}:expiry_queue`;
      await redis.hset(`reservation:${resId}`, {
        id: resId,
        sale_id: saleId,
        user_id: "other-user",
        quantity: "1",
        status: "HELD",
        expires_at: String(Date.now() + 60000),
      });
      await redis.zadd(expiryQueueKey, Date.now() + 60000, resId);

      const res = await app.inject({
        method: "POST",
        url: `/api/v1/reservations/${resId}/pay`,
        headers: { "x-user-id": userId },
      });

      expect(res.statusCode).toBe(403);
      const body = JSON.parse(res.body);
      expect(body.error).toBe("Forbidden");
    });

    it("returns 410 if reservation has already expired", async () => {
      const expiryQueueKey = `sale:${saleId}:expiry_queue`;
      await redis.hset(`reservation:${resId}`, {
        id: resId,
        sale_id: saleId,
        user_id: userId,
        quantity: "1",
        status: "EXPIRED",
        expires_at: String(Date.now() - 1000),
      });
      await redis.zadd(expiryQueueKey, Date.now() - 1000, resId);

      const res = await app.inject({
        method: "POST",
        url: `/api/v1/reservations/${resId}/pay`,
        headers: { "x-user-id": userId },
      });

      expect(res.statusCode).toBe(410);
      const body = JSON.parse(res.body);
      expect(body.error).toBe("Gone");
    });

    it("transitions HELD to PAYMENT_PENDING, extends expiry by +60s, and triggers payment simulator", async () => {
      const initialExpiry = Date.now() + 50000;
      const expiryQueueKey = `sale:${saleId}:expiry_queue`;

      await redis.hset(`reservation:${resId}`, {
        id: resId,
        sale_id: saleId,
        user_id: userId,
        quantity: "2",
        status: "HELD",
        expires_at: String(initialExpiry),
      });
      await redis.zadd(expiryQueueKey, initialExpiry, resId);

      const triggerSpy = vi.spyOn(simulator, "triggerPayment");

      const res = await app.inject({
        method: "POST",
        url: `/api/v1/reservations/${resId}/pay`,
        headers: { "x-user-id": userId },
        payload: {
          delayMs: 50,
          forceOutcome: "succeeded",
        },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.reservationId).toBe(resId);
      expect(body.status).toBe("PAYMENT_PENDING");

      // Verify extended score in Redis
      const newScore = await redis.zscore(expiryQueueKey, resId);
      expect(Number(newScore)).toBe(initialExpiry + 60000);

      // Verify Redis reservation record
      const updatedHash = await redis.hgetall(`reservation:${resId}`);
      expect(updatedHash.status).toBe("PAYMENT_PENDING");
      expect(Number(updatedHash.expires_at)).toBe(initialExpiry + 60000);

      // Verify simulator trigger was called
      expect(triggerSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          reservationId: resId,
          saleId,
          userId,
          delayMs: 50,
          forceOutcome: "succeeded",
        })
      );
    });

    it("handles idempotent pay calls when status is already PAYMENT_PENDING", async () => {
      const expiry = Date.now() + 60000;
      await redis.hset(`reservation:${resId}`, {
        id: resId,
        sale_id: saleId,
        user_id: userId,
        quantity: "1",
        status: "PAYMENT_PENDING",
        expires_at: String(expiry),
      });

      const res = await app.inject({
        method: "POST",
        url: `/api/v1/reservations/${resId}/pay`,
        headers: { "x-user-id": userId },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.status).toBe("PAYMENT_PENDING");
      expect(body.reservationId).toBe(resId);
    });
  });

  describe("Task 3.2: Webhook Receiver & Race Condition Handling (POST /api/v1/webhooks/payment)", () => {
    const saleStateKey = `sale:${saleId}:state`;
    const expiryQueueKey = `sale:${saleId}:expiry_queue`;
    const userHoldsKey = `sale:${saleId}:user_holds`;
    const userPurchasesKey = `sale:${saleId}:user_purchases`;

    beforeEach(async () => {
      await redis.hset(saleStateKey, {
        total_stock: "100",
        available_stock: "98",
        held_stock: "2",
        sold_stock: "0",
        start_time: "0",
      });
    });

    it("confirms order on payment.succeeded, updates stock counters, creates order and audit log", async () => {
      await redis.hset(`reservation:${resId}`, {
        id: resId,
        sale_id: saleId,
        user_id: userId,
        quantity: "2",
        status: "PAYMENT_PENDING",
        expires_at: String(Date.now() + 60000),
      });
      await redis.zadd(expiryQueueKey, Date.now() + 60000, resId);
      await redis.hset(userHoldsKey, userId, resId);

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/webhooks/payment",
        payload: {
          eventId: "evt_12345",
          event: "payment.succeeded",
          data: {
            reservationId: resId,
            saleId,
            userId,
            paymentReference: "pay_test_ref_1",
          },
        },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.status).toBe("CONFIRMED");
      expect(body.quantity).toBe(2);

      // Verify Redis stock counters: held 2 -> 0, sold 0 -> 2
      const state = await redis.hgetall(saleStateKey);
      expect(state.available_stock).toBe("98");
      expect(state.held_stock).toBe("0");
      expect(state.sold_stock).toBe("2");

      // Verify reservation status in Redis
      const resHash = await redis.hgetall(`reservation:${resId}`);
      expect(resHash.status).toBe("CONFIRMED");

      // Verify removed from expiry queue
      const score = await redis.zscore(expiryQueueKey, resId);
      expect(score).toBeNull();

      // Verify DB order persisted
      expect(persistedOrders.length).toBeGreaterThan(0);
      const savedOrder = persistedOrders.find((o) => o.reservationId === resId);
      expect(savedOrder).toBeDefined();
      expect(savedOrder.status).toBe("CONFIRMED");
      expect(savedOrder.quantity).toBe(2);

      // Verify DB audit log persisted
      const auditLog = persistedAuditLogs.find((a) => a.eventType === "ORDER_CONFIRMED");
      expect(auditLog).toBeDefined();
    });

    it("handles idempotency for repeated payment.succeeded webhook", async () => {
      await redis.hset(`reservation:${resId}`, {
        id: resId,
        sale_id: saleId,
        user_id: userId,
        quantity: "2",
        status: "CONFIRMED",
        expires_at: String(Date.now() + 60000),
      });

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/webhooks/payment",
        payload: {
          event: "payment.succeeded",
          data: {
            reservationId: resId,
            saleId,
          },
        },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.status).toBe("CONFIRMED");
      expect(body.message).toContain("already confirmed");
    });

    it("releases stock back to available_stock on payment.failed", async () => {
      await redis.hset(`reservation:${resId}`, {
        id: resId,
        sale_id: saleId,
        user_id: userId,
        quantity: "2",
        status: "PAYMENT_PENDING",
        expires_at: String(Date.now() + 60000),
      });
      await redis.zadd(expiryQueueKey, Date.now() + 60000, resId);
      await redis.hset(userHoldsKey, userId, resId);

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/webhooks/payment",
        payload: {
          event: "payment.failed",
          data: {
            reservationId: resId,
            saleId,
          },
        },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.status).toBe("EXPIRED");

      // Verify stock restored: held 2 -> 0, available 98 -> 100
      const state = await redis.hgetall(saleStateKey);
      expect(state.available_stock).toBe("100");
      expect(state.held_stock).toBe("0");
      expect(state.sold_stock).toBe("0");

      // Verify audit log
      const auditLog = persistedAuditLogs.find((a) => a.eventType === "PAYMENT_FAILED");
      expect(auditLog).toBeDefined();
    });

    it("CRITICAL RACE: handles Late Webhook Race Condition without stock invariant drift (status becomes REFUNDED_LATE)", async () => {
      // Scenario:
      // 1. Hold expired and reaper reclaimed stock: held 0, available restored to 100.
      await redis.hset(saleStateKey, {
        total_stock: "100",
        available_stock: "100", // reaper reclaimed
        held_stock: "0",
        sold_stock: "0",
      });

      // 2. Reservation hash marked EXPIRED by reaper
      await redis.hset(`reservation:${resId}`, {
        id: resId,
        sale_id: saleId,
        user_id: userId,
        quantity: "2",
        status: "EXPIRED",
        expires_at: "1000",
      });

      // 3. Late payment.succeeded arrives at t = 2000
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/webhooks/payment",
        payload: {
          eventId: "evt_late_race",
          event: "payment.succeeded",
          data: {
            reservationId: resId,
            saleId,
            userId,
            paymentReference: "pay_late_123",
          },
        },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.status).toBe("REFUNDED_LATE");

      // CRITICAL INVARIANT: Sold stock must NOT increment!
      const state = await redis.hgetall(saleStateKey);
      expect(state.available_stock).toBe("100");
      expect(state.held_stock).toBe("0");
      expect(state.sold_stock).toBe("0"); // NOT 2! Zero overselling!

      // Total invariant: Available + Held + Sold === Total Stock
      const total = Number(state.total_stock);
      const sum = Number(state.available_stock) + Number(state.held_stock) + Number(state.sold_stock);
      expect(sum).toBe(total);

      // Verify reservation marked REFUNDED_LATE in Redis
      const resHash = await redis.hgetall(`reservation:${resId}`);
      expect(resHash.status).toBe("REFUNDED_LATE");

      // Verify late order recorded as REFUNDED_LATE
      const lateOrder = persistedOrders.find((o) => o.status === "REFUNDED_LATE");
      expect(lateOrder).toBeDefined();
      expect(lateOrder.reservationId).toBe(resId);

      // Verify audit log has REFUNDED_LATE event
      const lateAudit = persistedAuditLogs.find((a) => a.eventType === "REFUNDED_LATE");
      expect(lateAudit).toBeDefined();
    });
  });

  describe("Chaos Payment Simulator Direct Testing", () => {
    it("respects delay configuration and failure rate", async () => {
      const dispatched: any[] = [];
      const sim = new ChaosPaymentSimulator(
        { minDelayMs: 5, maxDelayMs: 10, failureRate: 1.0 },
        (payload) => {
          dispatched.push(payload);
        }
      );

      const payload = await sim.processPayment({
        reservationId: resId,
        saleId,
        userId,
        quantity: 1,
      });

      expect(payload.event).toBe("payment.failed");
      expect(dispatched.length).toBe(1);
      expect(dispatched[0].event).toBe("payment.failed");
    });

    it("respects forceOutcome override", async () => {
      const sim = new ChaosPaymentSimulator({ failureRate: 1.0 });
      const payload = await sim.processPayment({
        reservationId: resId,
        saleId,
        userId,
        quantity: 1,
        delayMs: 1,
        forceOutcome: "succeeded",
      });

      expect(payload.event).toBe("payment.succeeded");
    });
  });
});
