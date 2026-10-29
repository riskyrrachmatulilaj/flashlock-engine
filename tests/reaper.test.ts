import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import RedisMock from "ioredis-mock";
import { registerLuaCommands, type FlashLockRedis } from "../src/redis/client.js";
import { ReaperWorker } from "../src/workers/reaper.worker.js";

describe("Phase 2.4: Background Reaper Worker", () => {
  let redis: FlashLockRedis;
  let mockDb: any;
  let reaper: ReaperWorker;
  const saleId = "sale-reaper-1";
  const updatedReservations: Array<{ id: string; status: string }> = [];

  beforeEach(async () => {
    updatedReservations.length = 0;
    const rawMock = new RedisMock();
    redis = registerLuaCommands(rawMock as any);
    await redis.flushall();

    mockDb = {
      update: () => ({
        set: (data: any) => ({
          where: async () => {
            updatedReservations.push({ id: "mock-batch", status: data.status });
            return [];
          },
        }),
      }),
    };

    reaper = new ReaperWorker(mockDb, redis);
    reaper.registerSale(saleId);
  });

  afterEach(() => {
    reaper.stop();
  });

  it("reaps expired reservations and restores inventory atomically", async () => {
    const saleStateKey = `sale:${saleId}:state`;
    const expiryQueueKey = `sale:${saleId}:expiry_queue`;
    const userHoldsKey = `sale:${saleId}:user_holds`;

    // Setup initial state: 10 total, 8 available, 2 held
    await redis.hset(saleStateKey, {
      total_stock: "10",
      available_stock: "8",
      held_stock: "2",
      sold_stock: "0",
      start_time: "1000",
    });

    const resId = "res-expired-123";
    const resKey = `reservation:${resId}`;
    const pastExpiry = Date.now() - 5000;

    await redis.hset(resKey, {
      id: resId,
      sale_id: saleId,
      user_id: "buyer-timeout",
      quantity: "2",
      status: "HELD",
      expires_at: pastExpiry.toString(),
    });

    await redis.hset(userHoldsKey, "buyer-timeout", resId);
    await redis.zadd(expiryQueueKey, pastExpiry, resId);

    // Run reaper once
    const reapedResults = await reaper.reapOnce();

    expect(reapedResults[saleId]).toBeDefined();
    expect(reapedResults[saleId]).toContain(resId);

    // Redis reservation status updated to EXPIRED
    const resStatus = await redis.hget(resKey, "status");
    expect(resStatus).toBe("EXPIRED");

    // Stock restored atomically: available_stock is back to 10, held_stock is 0
    const state = await redis.hgetall(saleStateKey);
    expect(state.available_stock).toBe("10");
    expect(state.held_stock).toBe("0");

    // User hold cleared so buyer can reserve again
    const userHold = await redis.hget(userHoldsKey, "buyer-timeout");
    expect(userHold).toBeNull();

    // Removed from ZSET expiry queue
    const zscore = await redis.zscore(expiryQueueKey, resId);
    expect(zscore).toBeNull();

    // PostgreSQL synced with EXPIRED status
    expect(updatedReservations.length).toBeGreaterThan(0);
    expect(updatedReservations[0].status).toBe("EXPIRED");
  });

  it("does not reap unexpired active reservations", async () => {
    const saleStateKey = `sale:${saleId}:state`;
    const expiryQueueKey = `sale:${saleId}:expiry_queue`;

    await redis.hset(saleStateKey, {
      total_stock: "10",
      available_stock: "8",
      held_stock: "2",
      sold_stock: "0",
      start_time: "1000",
    });

    const resId = "res-active-456";
    const resKey = `reservation:${resId}`;
    const futureExpiry = Date.now() + 60000;

    await redis.hset(resKey, {
      id: resId,
      sale_id: saleId,
      user_id: "buyer-active",
      quantity: "2",
      status: "HELD",
      expires_at: futureExpiry.toString(),
    });

    await redis.zadd(expiryQueueKey, futureExpiry, resId);

    const reapedResults = await reaper.reapOnce();
    expect(reapedResults[saleId]).toBeUndefined();

    // Stock still held
    const state = await redis.hgetall(saleStateKey);
    expect(state.available_stock).toBe("8");
    expect(state.held_stock).toBe("2");
  });

  it("guarantees non-overlapping worker runs", async () => {
    let callCount = 0;
    const slowWorker = new ReaperWorker(mockDb, redis);
    slowWorker.registerSale(saleId);

    // Spy on reapOnce with artificial delay
    vi.spyOn(slowWorker, "reapOnce").mockImplementation(async () => {
      callCount++;
      await new Promise((resolve) => setTimeout(resolve, 50));
      return {};
    });

    slowWorker.start(10);
    await new Promise((resolve) => setTimeout(resolve, 80));
    slowWorker.stop();

    // In 80ms with 50ms task and 10ms interval, it cannot overlap
    expect(callCount).toBeGreaterThanOrEqual(1);
    expect(callCount).toBeLessThanOrEqual(3);
  });
});
