import fastify, { type FastifyInstance } from "fastify";
import RedisMock from "ioredis-mock";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { registerLuaCommands, type FlashLockRedis } from "../../src/redis/client.js";
import { ReserveService } from "../../src/modules/reservation/reserve.service.js";
import { PaymentService } from "../../src/modules/payment-sim/payment.service.js";
import { ChaosPaymentSimulator } from "../../src/modules/payment-sim/simulator.js";
import { reserveRoutes } from "../../src/modules/reservation/reserve.routes.js";
import { webhookRoutes } from "../../src/modules/payment-sim/webhook.routes.js";
import { ReaperWorker } from "../../src/workers/reaper.worker.js";

export interface SaleState {
  total: number;
  available: number;
  held: number;
  sold: number;
}

export interface Harness {
  redis: FlashLockRedis;
  app: FastifyInstance;
  simulator: ChaosPaymentSimulator;
  reserveService: ReserveService;
  paymentService: PaymentService;
  reaper: ReaperWorker;
  persistedOrders: any[];
  persistedAuditLogs: any[];
  dispatched: Array<Promise<any>>;
  initSale(saleId: string, totalStock: number): Promise<void>;
  readState(saleId: string): Promise<SaleState>;
  waitForDispatches(count: number, timeoutMs?: number): Promise<void>;
  close(): Promise<void>;
}

/**
 * Deterministic seeded PRNG (mulberry32) so stampede runs are reproducible.
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function sumOfParts(state: SaleState): number {
  return state.available + state.held + state.sold;
}

export async function createHarness(): Promise<Harness> {
  const redis = registerLuaCommands(new RedisMock() as any);
  await redis.flushall();

  const persistedOrders: any[] = [];
  const persistedAuditLogs: any[] = [];

  const mockDb: any = {
    insert: () => ({
      values: async (data: any) => {
        if (data.eventType) persistedAuditLogs.push(data);
        else if (data.paymentReference) persistedOrders.push(data);
        return [data];
      },
    }),
    update: () => ({
      set: (data: any) => ({
        where: async () => [data],
      }),
    }),
    select: () => ({
      from: () => ({
        where: async () => [],
      }),
    }),
  };

  // Real delays are irrelevant: tests override delayMs per payment.
  const simulator = new ChaosPaymentSimulator({
    minDelayMs: 0,
    maxDelayMs: 0,
    failureRate: 0,
  });
  const paymentService = new PaymentService(mockDb, redis);
  const dispatched: Array<Promise<any>> = [];
  simulator.setOnDispatch((payload) => {
    const p = paymentService.processWebhook(payload);
    dispatched.push(p);
    return p;
  });

  const reserveService = new ReserveService(mockDb, redis, simulator);
  const reaper = new ReaperWorker(mockDb, redis);

  const app = fastify({ logger: false }).withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  // Rate limiter is covered by auth-rate-limit.test.ts; bypass it here so
  // the stampede measures stock correctness, not throttling.
  const rateLimiter = async () => {};
  await app.register(reserveRoutes, { reserveService, rateLimiter });
  await app.register(webhookRoutes, { paymentService });
  await app.ready();

  const readState = async (saleId: string): Promise<SaleState> => {
    const s = await redis.hgetall(`sale:${saleId}:state`);
    return {
      total: Number(s.total_stock),
      available: Number(s.available_stock),
      held: Number(s.held_stock),
      sold: Number(s.sold_stock),
    };
  };

  return {
    redis,
    app,
    simulator,
    reserveService,
    paymentService,
    reaper,
    persistedOrders,
    persistedAuditLogs,
    dispatched,
    async initSale(saleId, totalStock) {
      await redis.hset(`sale:${saleId}:state`, {
        total_stock: String(totalStock),
        available_stock: String(totalStock),
        held_stock: "0",
        sold_stock: "0",
        start_time: "0",
      });
      reaper.registerSale(saleId);
    },
    readState,
    async waitForDispatches(count, timeoutMs = 15000) {
      // Date may be faked by the test; cap by iteration count, not wall clock.
      let spins = 0;
      const maxSpins = Math.ceil(timeoutMs / 5);
      while (dispatched.length < count) {
        if (spins++ > maxSpins) {
          throw new Error(
            `Timed out waiting for dispatches: ${dispatched.length}/${count}`
          );
        }
        await new Promise((r) => setTimeout(r, 5));
      }
      await Promise.all(dispatched);
    },
    async close() {
      simulator.clearAll();
      reaper.stop();
      await app.close();
    },
  };
}
