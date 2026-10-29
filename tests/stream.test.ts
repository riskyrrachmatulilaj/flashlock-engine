import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fastify, { type FastifyInstance } from "fastify";
import RedisMock from "ioredis-mock";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { registerLuaCommands, type FlashLockRedis } from "../src/redis/client.js";
import { ReserveService } from "../src/modules/reservation/reserve.service.js";
import { SaleService } from "../src/modules/sale/sale.service.js";
import { PaymentService } from "../src/modules/payment-sim/payment.service.js";
import { ChaosPaymentSimulator } from "../src/modules/payment-sim/simulator.js";
import { StampedeRunner } from "../src/modules/simulator-runner/stampede.js";
import { saleRoutes } from "../src/modules/sale/sale.routes.js";
import { buildTelemetry } from "../src/modules/sale/telemetry.js";

const SALE_ID = "a0000000-0000-0000-0000-0000000000aa";

describe("Task 5.1: SSE telemetry & stampede trigger", () => {
  let redis: FlashLockRedis;
  let app: FastifyInstance;
  let simulator: ChaosPaymentSimulator;
  let runner: StampedeRunner;
  let baseUrl: string;

  const mockDb: any = {
    insert: () => ({ values: async () => [] }),
    update: () => ({ set: () => ({ where: async () => [] }) }),
    select: () => ({ from: () => ({ where: async () => [] }) }),
  };

  async function seed(total: number) {
    await redis.hset(`sale:${SALE_ID}:state`, {
      total_stock: String(total),
      available_stock: String(total),
      held_stock: "0",
      sold_stock: "0",
      start_time: "0",
    });
  }

  /** Reads SSE frames from the stream until `count` telemetry events are parsed. */
  async function readEvents(count: number, signal: AbortSignal) {
    const res = await fetch(`${baseUrl}/api/v1/sales/${SALE_ID}/stream`, { signal });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    const events: any[] = [];
    let buf = "";
    while (events.length < count) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf("\n\n")) !== -1) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const ev = /^event: (.+)$/m.exec(frame)?.[1];
        const data = /^data: (.+)$/m.exec(frame)?.[1];
        if (ev === "telemetry" && data) events.push(JSON.parse(data));
      }
    }
    await reader.cancel();
    return events;
  }

  beforeEach(async () => {
    redis = registerLuaCommands(new RedisMock() as any);
    await redis.flushall();

    simulator = new ChaosPaymentSimulator({ minDelayMs: 0, maxDelayMs: 0, failureRate: 0 });
    const paymentService = new PaymentService(mockDb, redis);
    simulator.setOnDispatch((p) => paymentService.processWebhook(p));
    const reserveService = new ReserveService(mockDb, redis, simulator);
    runner = new StampedeRunner(reserveService);

    app = fastify({ logger: false }).withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    await app.register(saleRoutes, {
      saleService: new SaleService(mockDb, redis),
      redis,
      stampedeRunner: runner,
      streamIntervalMs: 20,
    });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const addr = app.server.address();
    baseUrl = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
  });

  afterEach(async () => {
    simulator.clearAll();
    await app.close();
  });

  describe("buildTelemetry", () => {
    it("flags invariantValid true when Available + Held + Sold === Total", () => {
      const t = buildTelemetry("s", {
        total_stock: "100",
        available_stock: "60",
        held_stock: "10",
        sold_stock: "30",
      });
      expect(t).toMatchObject({
        totalStock: 100,
        availableStock: 60,
        heldStock: 10,
        soldStock: 30,
        accountedStock: 100,
        invariantValid: true,
      });
    });

    it("flags invariantValid false on drift or negative counters", () => {
      const drift = buildTelemetry("s", {
        total_stock: "100",
        available_stock: "60",
        held_stock: "10",
        sold_stock: "31",
      });
      expect(drift!.invariantValid).toBe(false);

      const negative = buildTelemetry("s", {
        total_stock: "100",
        available_stock: "101",
        held_stock: "-1",
        sold_stock: "0",
      });
      expect(negative!.invariantValid).toBe(false);
    });

    it("returns null for unknown sale", () => {
      expect(buildTelemetry("s", {})).toBeNull();
    });
  });

  describe("GET /api/v1/sales/:id/stream", () => {
    it("returns 404 for unknown sale", async () => {
      const res = await fetch(`${baseUrl}/api/v1/sales/${SALE_ID}/stream`);
      expect(res.status).toBe(404);
    });

    it("rejects invalid sale id with 400", async () => {
      const res = await fetch(`${baseUrl}/api/v1/sales/not-a-uuid/stream`);
      expect(res.status).toBe(400);
    });

    it("streams repeated telemetry events with invariantValid", async () => {
      await seed(100);
      const ac = new AbortController();
      const events = await readEvents(4, ac.signal);
      ac.abort();

      expect(events).toHaveLength(4);
      for (const e of events) {
        expect(e).toMatchObject({
          saleId: SALE_ID,
          totalStock: 100,
          availableStock: 100,
          heldStock: 0,
          soldStock: 0,
          invariantValid: true,
        });
      }
      // Ticks advance over time (~20ms test interval).
      expect(events[3].timestamp).toBeGreaterThan(events[0].timestamp);
    });

    it("closes active SSE connections when server shuts down", async () => {
      await seed(100);
      const controller = new AbortController();
      const response = await fetch(`${baseUrl}/api/v1/sales/${SALE_ID}/stream`, {
        signal: controller.signal,
      });
      const reader = response.body!.getReader();
      await reader.read();
      try {
        await app.close();
        let done = false;
        while (!done) done = (await reader.read()).done;
        expect(done).toBe(true);
      } finally {
        controller.abort();
      }
    });

    it("reports invariantValid=false when counters drift", async () => {
      await seed(100);
      await redis.hset(`sale:${SALE_ID}:state`, "sold_stock", "5"); // forced drift
      const ac = new AbortController();
      const events = await readEvents(2, ac.signal);
      ac.abort();
      expect(events.every((e) => e.invariantValid === false)).toBe(true);
    });
  });

  describe("POST /api/v1/sales/:id/stampede", () => {
    it("returns 404 for unknown sale", async () => {
      const res = await app.inject({ method: "POST", url: `/api/v1/sales/${SALE_ID}/stampede` });
      expect(res.statusCode).toBe(404);
    });

    it("rejects out-of-range buyers with 400", async () => {
      await seed(100);
      const res = await app.inject({
        method: "POST",
        url: `/api/v1/sales/${SALE_ID}/stampede`,
        payload: { buyers: 999999 },
      });
      expect(res.statusCode).toBe(400);
    });

    it("returns 202 and spawns buyers; invariant holds and nothing is oversold", async () => {
      await seed(100);
      const res = await app.inject({
        method: "POST",
        url: `/api/v1/sales/${SALE_ID}/stampede`,
        payload: { buyers: 1000, checkoutRatio: 0.7 },
      });
      expect(res.statusCode).toBe(202);
      expect(JSON.parse(res.body)).toMatchObject({ status: "STARTED", buyers: 1000 });

      // Wait for run to finish (real timers; simulator delay is 0).
      for (let i = 0; i < 400 && runner.isRunning(SALE_ID); i++) {
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(runner.isRunning(SALE_ID)).toBe(false);
      await new Promise((r) => setTimeout(r, 50)); // let webhooks settle

      const t = buildTelemetry(SALE_ID, await redis.hgetall(`sale:${SALE_ID}:state`))!;
      expect(t.invariantValid).toBe(true);
      expect(t.soldStock + t.heldStock).toBeLessThanOrEqual(100);
      expect(t.soldStock).toBeGreaterThan(0);
      expect(t.availableStock).toBeLessThanOrEqual(1);
    }, 30_000);

    it("returns 409 when a stampede is already running", async () => {
      await seed(100);

      // Deterministic: first run blocks on a gate until released.
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const gatedService: any = {
        reserveStock: async () => {
          await gate;
          return { status: 409 };
        },
        initiatePayment: async () => ({ status: 200 }),
      };
      const gatedRunner = new StampedeRunner(gatedService);
      const app2 = fastify({ logger: false }).withTypeProvider<ZodTypeProvider>();
      app2.setValidatorCompiler(validatorCompiler);
      app2.setSerializerCompiler(serializerCompiler);
      await app2.register(saleRoutes, {
        saleService: new SaleService(mockDb, redis),
        redis,
        stampedeRunner: gatedRunner,
      });

      const first = await app2.inject({
        method: "POST",
        url: `/api/v1/sales/${SALE_ID}/stampede`,
        payload: { buyers: 5 },
      });
      expect(first.statusCode).toBe(202);
      expect(gatedRunner.isRunning(SALE_ID)).toBe(true);

      const second = await app2.inject({
        method: "POST",
        url: `/api/v1/sales/${SALE_ID}/stampede`,
        payload: { buyers: 5 },
      });
      expect(second.statusCode).toBe(409);

      release();
      for (let i = 0; i < 100 && gatedRunner.isRunning(SALE_ID); i++) {
        await new Promise((r) => setTimeout(r, 5));
      }
      expect(gatedRunner.isRunning(SALE_ID)).toBe(false);
      await app2.close();
    });
  });
});
