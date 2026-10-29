import { describe, it, expect, beforeEach } from "vitest";
import fastify, { type FastifyInstance } from "fastify";
import RedisMock from "ioredis-mock";
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from "fastify-type-provider-zod";
import { registerLuaCommands, type FlashLockRedis } from "../src/redis/client.js";
import { SaleService } from "../src/modules/sale/sale.service.js";
import { createSaleSchema, saleParamsSchema } from "../src/modules/sale/sale.schema.js";

describe("Phase 2.1: Sale Initialization Module", () => {
  let redis: FlashLockRedis;
  let mockDb: any;
  let saleService: SaleService;
  let app: FastifyInstance;
  let storedSales: any[] = [];

  beforeEach(async () => {
    storedSales = [];
    const rawMock = new RedisMock();
    redis = registerLuaCommands(rawMock as any);
    await redis.flushall();

    mockDb = {
      insert: () => ({
        values: (data: any) => ({
          returning: async () => {
            const row = {
              id: "550e8400-e29b-41d4-a716-446655440000",
              title: data.title,
              totalStock: data.totalStock,
              availableStock: data.availableStock,
              startTime: data.startTime,
              endTime: data.endTime,
              status: data.status,
              createdAt: new Date(),
              updatedAt: new Date(),
            };
            storedSales.push(row);
            return [row];
          },
        }),
      }),
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => [storedSales[0]],
          }),
        }),
      }),
    };

    saleService = new SaleService(mockDb, redis);

    app = fastify({ logger: false }).withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);

    app.post("/api/v1/sales", { schema: { body: createSaleSchema } }, async (req, reply) => {
      const sale = await saleService.createSale(req.body);
      return reply.status(201).send(sale);
    });

    app.get("/api/v1/sales/:id", { schema: { params: saleParamsSchema } }, async (req, reply) => {
      const sale = await saleService.getSaleById(req.params.id);
      if (!sale) {
        return reply.status(404).send({ error: "Not Found", message: "Sale not found" });
      }
      return reply.send(sale);
    });
  });

  it("POST /api/v1/sales inserts into DB and initializes Redis state", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/sales",
      payload: {
        title: "RTX 5090 Flash Sale",
        totalStock: 100,
        startTime: new Date().toISOString(),
      },
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.id).toBe("550e8400-e29b-41d4-a716-446655440000");
    expect(body.title).toBe("RTX 5090 Flash Sale");
    expect(body.totalStock).toBe(100);
    expect(body.availableStock).toBe(100);
    expect(body.heldStock).toBe(0);
    expect(body.soldStock).toBe(0);

    // Verify Redis hot state hash
    const redisState = await redis.hgetall(`sale:${body.id}:state`);
    expect(redisState.total_stock).toBe("100");
    expect(redisState.available_stock).toBe("100");
    expect(redisState.held_stock).toBe("0");
    expect(redisState.sold_stock).toBe("0");

    // Verify Redis active sales set
    const isActive = await redis.sismember("sales:active", body.id);
    expect(isActive).toBe(1);
  });

  it("GET /api/v1/sales/:id fetches state reflecting live Redis counters", async () => {
    const createRes = await app.inject({
      method: "POST",
      url: "/api/v1/sales",
      payload: {
        title: "RTX 5090 Flash Sale",
        totalStock: 50,
      },
    });
    const saleId = JSON.parse(createRes.body).id;

    // Mutate Redis counters directly
    await redis.hset(`sale:${saleId}:state`, {
      available_stock: "40",
      held_stock: "8",
      sold_stock: "2",
    });

    const getRes = await app.inject({
      method: "GET",
      url: `/api/v1/sales/${saleId}`,
    });

    expect(getRes.statusCode).toBe(200);
    const getBody = JSON.parse(getRes.body);
    expect(getBody.totalStock).toBe(50);
    expect(getBody.availableStock).toBe(40);
    expect(getBody.heldStock).toBe(8);
    expect(getBody.soldStock).toBe(2);
  });
});
