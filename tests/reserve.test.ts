import { describe, it, expect, beforeEach } from "vitest";
import fastify, { type FastifyInstance } from "fastify";
import RedisMock from "ioredis-mock";
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from "fastify-type-provider-zod";
import { registerLuaCommands, type FlashLockRedis } from "../src/redis/client.js";
import { ReserveService } from "../src/modules/reservation/reserve.service.js";
import { authMiddleware } from "../src/middleware/auth.js";
import { createRateLimiter } from "../src/middleware/rate-limit.js";
import { reserveParamsSchema, reserveBodySchema } from "../src/modules/reservation/reserve.schema.js";

describe("Phase 2.3: Reservation Route (POST /api/v1/sales/:id/reserve)", () => {
  let redis: FlashLockRedis;
  let mockDb: any;
  let reserveService: ReserveService;
  let app: FastifyInstance;
  const saleId = "a0000000-0000-0000-0000-000000000001";
  const persistedReservations: any[] = [];

  beforeEach(async () => {
    persistedReservations.length = 0;
    const rawMock = new RedisMock();
    redis = registerLuaCommands(rawMock as any);
    await redis.flushall();

    mockDb = {
      insert: () => ({
        values: async (data: any) => {
          persistedReservations.push(data);
          return [data];
        },
      }),
    };

    reserveService = new ReserveService(mockDb, redis);

    app = fastify({ logger: false }).withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);

    const rateLimiter = createRateLimiter({ redis, max: 10, windowMs: 10000 });

    app.post(
      "/api/v1/sales/:id/reserve",
      {
        preHandler: [authMiddleware, rateLimiter],
        schema: {
          params: reserveParamsSchema,
          body: reserveBodySchema,
        },
      },
      async (request, reply) => {
        const id = request.params.id;
        const userId = request.userId!;
        const quantity = request.body?.quantity ?? 1;

        const headerKey = request.headers["idempotency-key"];
        const rawHeaderKey = Array.isArray(headerKey) ? headerKey[0] : headerKey;
        const idempotencyKey = rawHeaderKey || request.body?.idempotencyKey || `auto:${userId}:${id}`;

        const result = await reserveService.reserveStock({
          saleId: id,
          userId,
          quantity,
          idempotencyKey,
        });

        if (result.status === 201 || result.status === 200) {
          return reply.status(result.status).send(result.data);
        }

        return reply.status(result.status).send({
          statusCode: result.status,
          error: result.error,
          message: result.message,
        });
      }
    );
  });

  it("returns 401 when missing x-user-id header", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/sales/${saleId}/reserve`,
      payload: { quantity: 1 },
    });

    expect(res.statusCode).toBe(401);
  });

  it("returns 404 when sale does not exist", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/sales/${saleId}/reserve`,
      headers: { "x-user-id": "user-1", "idempotency-key": "idemp-1" },
      payload: { quantity: 1 },
    });

    expect(res.statusCode).toBe(404);
    const body = JSON.parse(res.body);
    expect(body.error).toBe("Not Found");
  });

  it("returns 403 when sale has not started yet", async () => {
    const futureTime = Date.now() + 60000;
    await redis.hset(`sale:${saleId}:state`, {
      total_stock: "100",
      available_stock: "100",
      held_stock: "0",
      sold_stock: "0",
      start_time: futureTime.toString(),
    });

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/sales/${saleId}/reserve`,
      headers: { "x-user-id": "user-1", "idempotency-key": "idemp-1" },
      payload: { quantity: 1 },
    });

    expect(res.statusCode).toBe(403);
    const body = JSON.parse(res.body);
    expect(body.error).toBe("Forbidden");
    expect(body.message).toMatch(/Sale has not started yet/);
  });

  it("returns 201 Created and persists reservation to PostgreSQL and updates Redis", async () => {
    const pastTime = Date.now() - 1000;
    await redis.hset(`sale:${saleId}:state`, {
      total_stock: "10",
      available_stock: "10",
      held_stock: "0",
      sold_stock: "0",
      start_time: pastTime.toString(),
    });

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/sales/${saleId}/reserve`,
      headers: { "x-user-id": "user-1", "idempotency-key": "idemp-1" },
      payload: { quantity: 2 },
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.saleId).toBe(saleId);
    expect(body.userId).toBe("user-1");
    expect(body.quantity).toBe(2);
    expect(body.status).toBe("HELD");
    expect(body.expiresAt).toBeDefined();

    // Redis state updated
    const state = await redis.hgetall(`sale:${saleId}:state`);
    expect(state.available_stock).toBe("8");
    expect(state.held_stock).toBe("2");

    // PostgreSQL persisted
    expect(persistedReservations).toHaveLength(1);
    expect(persistedReservations[0].id).toBe(body.reservationId);
    expect(persistedReservations[0].userId).toBe("user-1");
    expect(persistedReservations[0].quantity).toBe(2);
  });

  it("returns 200 OK with existing reservation on duplicate user request (idempotency)", async () => {
    const pastTime = Date.now() - 1000;
    await redis.hset(`sale:${saleId}:state`, {
      total_stock: "10",
      available_stock: "10",
      held_stock: "0",
      sold_stock: "0",
      start_time: pastTime.toString(),
    });

    // First request
    const res1 = await app.inject({
      method: "POST",
      url: `/api/v1/sales/${saleId}/reserve`,
      headers: { "x-user-id": "user-dup", "idempotency-key": "idemp-dup" },
      payload: { quantity: 1 },
    });
    expect(res1.statusCode).toBe(201);
    const body1 = JSON.parse(res1.body);

    // Second request (same user, multi-tab or repeat click)
    const res2 = await app.inject({
      method: "POST",
      url: `/api/v1/sales/${saleId}/reserve`,
      headers: { "x-user-id": "user-dup", "idempotency-key": "idemp-dup-newkey" },
      payload: { quantity: 1 },
    });
    expect(res2.statusCode).toBe(200);
    const body2 = JSON.parse(res2.body);
    expect(body2.reservationId).toBe(body1.reservationId);
    expect(body2.status).toBe("HELD");

    // Stock should not be deducted twice
    const state = await redis.hgetall(`sale:${saleId}:state`);
    expect(state.available_stock).toBe("9");
    expect(state.held_stock).toBe("1");
  });

  it("returns 409 Conflict when requested quantity exceeds available stock", async () => {
    const pastTime = Date.now() - 1000;
    await redis.hset(`sale:${saleId}:state`, {
      total_stock: "10",
      available_stock: "1",
      held_stock: "9",
      sold_stock: "0",
      start_time: pastTime.toString(),
    });

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/sales/${saleId}/reserve`,
      headers: { "x-user-id": "user-99", "idempotency-key": "idemp-99" },
      payload: { quantity: 2 },
    });

    expect(res.statusCode).toBe(409);
    const body = JSON.parse(res.body);
    expect(body.error).toBe("Conflict");
    expect(body.message).toMatch(/Insufficient stock/);
  });

  it("returns 410 Gone when completely sold out (available=0, held=0)", async () => {
    const pastTime = Date.now() - 1000;
    await redis.hset(`sale:${saleId}:state`, {
      total_stock: "10",
      available_stock: "0",
      held_stock: "0",
      sold_stock: "10",
      start_time: pastTime.toString(),
    });

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/sales/${saleId}/reserve`,
      headers: { "x-user-id": "user-100", "idempotency-key": "idemp-100" },
      payload: { quantity: 1 },
    });

    expect(res.statusCode).toBe(410);
    const body = JSON.parse(res.body);
    expect(body.error).toBe("Gone");
    expect(body.message).toMatch(/Sold out/i);
  });
});
