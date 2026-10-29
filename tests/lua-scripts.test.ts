import { describe, it, expect, beforeEach } from "vitest";
import RedisMock from "ioredis-mock";
import { registerLuaCommands, type FlashLockRedis } from "../src/redis/client.js";

describe("Redis Lua Scripts Unit Tests", () => {
  let redis: FlashLockRedis;
  const saleId = "sale-123";
  const saleStateKey = `sale:${saleId}:state`;
  const userHoldsKey = `sale:${saleId}:user_holds`;
  const expiryQueueKey = `sale:${saleId}:expiry_queue`;
  const userPurchasesKey = `sale:${saleId}:user_purchases`;

  beforeEach(async () => {
    const rawMock = new RedisMock();
    redis = registerLuaCommands(rawMock as any);
    await redis.flushall();
  });

  describe("reserve_stock.lua", () => {
    it("rejects if sale does not exist", async () => {
      const res = await redis.reserveStock(
        saleStateKey,
        userHoldsKey,
        expiryQueueKey,
        "reservation:res-1",
        userPurchasesKey,
        "idempotency:key-1",
        "res-1",
        "user-1",
        1,
        1000,
        300000,
        saleId,
        "key-1"
      );
      expect(res[0]).toBe("ERR_SALE_NOT_FOUND");
    });

    it("rejects if sale has not started yet", async () => {
      await redis.hset(saleStateKey, {
        total_stock: "100",
        available_stock: "100",
        held_stock: "0",
        sold_stock: "0",
        start_time: "5000",
      });

      const res = await redis.reserveStock(
        saleStateKey,
        userHoldsKey,
        expiryQueueKey,
        "reservation:res-1",
        userPurchasesKey,
        "idempotency:key-1",
        "res-1",
        "user-1",
        1,
        1000, // now < start_time
        300000,
        saleId,
        "key-1"
      );
      expect(res[0]).toBe("ERR_SALE_NOT_STARTED");
    });

    it("successfully reserves stock and updates counters atomically", async () => {
      await redis.hset(saleStateKey, {
        total_stock: "10",
        available_stock: "10",
        held_stock: "0",
        sold_stock: "0",
        start_time: "1000",
      });

      const res = await redis.reserveStock(
        saleStateKey,
        userHoldsKey,
        expiryQueueKey,
        "reservation:res-1",
        userPurchasesKey,
        "idempotency:key-1",
        "res-1",
        "user-1",
        2,
        2000,
        300000,
        saleId,
        "key-1"
      );

      expect(res[0]).toBe("OK_CREATED");
      expect(res[1]).toBe("res-1");
      expect(res[2]).toBe("302000"); // 2000 + 300000

      // Check counters
      const state = await redis.hgetall(saleStateKey);
      expect(state.available_stock).toBe("8");
      expect(state.held_stock).toBe("2");

      // Check reservation record
      const reservation = await redis.hgetall("reservation:res-1");
      expect(reservation.status).toBe("HELD");
      expect(reservation.quantity).toBe("2");
      expect(reservation.user_id).toBe("user-1");

      // Check expiry queue
      const score = await redis.zscore(expiryQueueKey, "res-1");
      expect(score).toBe("302000");

      // Check user hold mapping
      const heldResId = await redis.hget(userHoldsKey, "user-1");
      expect(heldResId).toBe("res-1");
    });

    it("returns existing reservation on duplicate click / multi-tab without deducting extra stock", async () => {
      await redis.hset(saleStateKey, {
        total_stock: "10",
        available_stock: "10",
        held_stock: "0",
        sold_stock: "0",
        start_time: "1000",
      });

      // First reservation
      await redis.reserveStock(
        saleStateKey,
        userHoldsKey,
        expiryQueueKey,
        "reservation:res-1",
        userPurchasesKey,
        "idempotency:key-1",
        "res-1",
        "user-1",
        2,
        2000,
        300000,
        saleId,
        "key-1"
      );

      // Second attempt by same user (different resId, different or same key)
      const duplicateRes = await redis.reserveStock(
        saleStateKey,
        userHoldsKey,
        expiryQueueKey,
        "reservation:res-2",
        userPurchasesKey,
        "idempotency:key-2",
        "res-2",
        "user-1",
        1,
        2500,
        300000,
        saleId,
        "key-2"
      );

      expect(duplicateRes[0]).toBe("OK_EXISTING");
      expect(duplicateRes[1]).toBe("res-1");

      // Stock remains exactly 8 available, 2 held
      const state = await redis.hgetall(saleStateKey);
      expect(state.available_stock).toBe("8");
      expect(state.held_stock).toBe("2");
    });

    it("rejects when stock is insufficient", async () => {
      await redis.hset(saleStateKey, {
        total_stock: "1",
        available_stock: "1",
        held_stock: "0",
        sold_stock: "0",
        start_time: "1000",
      });

      const res = await redis.reserveStock(
        saleStateKey,
        userHoldsKey,
        expiryQueueKey,
        "reservation:res-1",
        userPurchasesKey,
        "idempotency:key-1",
        "res-1",
        "user-1",
        2, // Requesting 2 with only 1 available
        2000,
        300000,
        saleId,
        "key-1"
      );

      expect(res[0]).toBe("ERR_INSUFFICIENT_STOCK");
      const state = await redis.hgetall(saleStateKey);
      expect(state.available_stock).toBe("1");
      expect(state.held_stock).toBe("0");
    });

    it("rejects with sold out when available is 0 and held is 0", async () => {
      await redis.hset(saleStateKey, {
        total_stock: "5",
        available_stock: "0",
        held_stock: "0",
        sold_stock: "5",
        start_time: "1000",
      });

      const res = await redis.reserveStock(
        saleStateKey,
        userHoldsKey,
        expiryQueueKey,
        "reservation:res-1",
        userPurchasesKey,
        "idempotency:key-1",
        "res-1",
        "user-1",
        1,
        2000,
        300000,
        saleId,
        "key-1"
      );

      expect(res[0]).toBe("ERR_SOLD_OUT");
    });
  });

  describe("reap_expired.lua", () => {
    it("reclaims stock from expired holds and updates counters", async () => {
      await redis.hset(saleStateKey, {
        total_stock: "10",
        available_stock: "8",
        held_stock: "2",
        sold_stock: "0",
      });

      // Add active hold expiring at 5000
      await redis.hset("reservation:res-1", {
        id: "res-1",
        sale_id: saleId,
        user_id: "user-1",
        quantity: "2",
        status: "HELD",
        expires_at: "5000",
      });
      await redis.zadd(expiryQueueKey, 5000, "res-1");
      await redis.hset(userHoldsKey, "user-1", "res-1");

      // Reap at t=4000 (not expired yet)
      const nonExpired = await redis.reapExpired(
        saleStateKey,
        expiryQueueKey,
        userHoldsKey,
        4000,
        100
      );
      expect(nonExpired).toHaveLength(0);

      // Reap at t=5001 (now expired)
      const reaped = await redis.reapExpired(
        saleStateKey,
        expiryQueueKey,
        userHoldsKey,
        5001,
        100
      );
      expect(reaped).toEqual(["res-1"]);

      // Invariant check: Stock restored
      const state = await redis.hgetall(saleStateKey);
      expect(state.available_stock).toBe("10");
      expect(state.held_stock).toBe("0");

      const resRecord = await redis.hgetall("reservation:res-1");
      expect(resRecord.status).toBe("EXPIRED");

      // User hold freed
      const userHold = await redis.hget(userHoldsKey, "user-1");
      expect(userHold).toBeNull();
    });
  });

  describe("confirm_order.lua", () => {
    it("confirms order on payment.succeeded and moves held stock to sold stock", async () => {
      await redis.hset(saleStateKey, {
        total_stock: "10",
        available_stock: "8",
        held_stock: "2",
        sold_stock: "0",
      });

      await redis.hset("reservation:res-1", {
        id: "res-1",
        sale_id: saleId,
        user_id: "user-1",
        quantity: "2",
        status: "HELD",
        expires_at: "5000",
      });
      await redis.zadd(expiryQueueKey, 5000, "res-1");
      await redis.hset(userHoldsKey, "user-1", "res-1");

      const res = await redis.confirmOrder(
        saleStateKey,
        expiryQueueKey,
        userHoldsKey,
        userPurchasesKey,
        "reservation:res-1",
        "res-1",
        "succeeded",
        3000
      );

      expect(res[0]).toBe("OK_CONFIRMED");
      expect(res[1]).toBe("2");
      expect(res[2]).toBe("user-1");

      // Counter check: held 2 -> 0, sold 0 -> 2
      const state = await redis.hgetall(saleStateKey);
      expect(state.available_stock).toBe("8");
      expect(state.held_stock).toBe("0");
      expect(state.sold_stock).toBe("2");

      // Expiry queue cleared
      const score = await redis.zscore(expiryQueueKey, "res-1");
      expect(score).toBeNull();

      // Marked purchased
      const hasPurchased = await redis.hget(userPurchasesKey, "user-1");
      expect(hasPurchased).toBe("res-1");
    });

    it("handles the Late Webhook Race Condition without corrupting stock invariant", async () => {
      // Setup: Stock was already reaped and returned to available_stock!
      await redis.hset(saleStateKey, {
        total_stock: "10",
        available_stock: "10", // already reaped back
        held_stock: "0",
        sold_stock: "0",
      });

      await redis.hset("reservation:res-1", {
        id: "res-1",
        sale_id: saleId,
        user_id: "user-1",
        quantity: "2",
        status: "EXPIRED", // reaper set status to EXPIRED
        expires_at: "5000",
      });

      // Late webhook arrives after expiration
      const res = await redis.confirmOrder(
        saleStateKey,
        expiryQueueKey,
        userHoldsKey,
        userPurchasesKey,
        "reservation:res-1",
        "res-1",
        "succeeded",
        6000
      );

      expect(res[0]).toBe("LATE_PAYMENT_DETECTED");

      // Critical Invariant: Stock must NOT change!
      const state = await redis.hgetall(saleStateKey);
      expect(state.available_stock).toBe("10");
      expect(state.held_stock).toBe("0");
      expect(state.sold_stock).toBe("0");
    });

    it("releases stock back to available pool on payment.failed", async () => {
      await redis.hset(saleStateKey, {
        total_stock: "10",
        available_stock: "8",
        held_stock: "2",
        sold_stock: "0",
      });

      await redis.hset("reservation:res-1", {
        id: "res-1",
        sale_id: saleId,
        user_id: "user-1",
        quantity: "2",
        status: "HELD",
        expires_at: "5000",
      });

      const res = await redis.confirmOrder(
        saleStateKey,
        expiryQueueKey,
        userHoldsKey,
        userPurchasesKey,
        "reservation:res-1",
        "res-1",
        "failed",
        3000
      );

      expect(res[0]).toBe("OK_EXPIRED_ON_FAILURE");

      const state = await redis.hgetall(saleStateKey);
      expect(state.available_stock).toBe("10");
      expect(state.held_stock).toBe("0");
      expect(state.sold_stock).toBe("0");
    });
  });

  describe("extend_hold.lua", () => {
    it("extends reservation TTL and changes status to PAYMENT_PENDING", async () => {
      await redis.hset("reservation:res-1", {
        id: "res-1",
        sale_id: saleId,
        user_id: "user-1",
        status: "HELD",
        expires_at: "5000",
      });
      await redis.zadd(expiryQueueKey, 5000, "res-1");

      const res = await redis.extendHold(
        expiryQueueKey,
        "reservation:res-1",
        "res-1",
        "user-1",
        2000,
        60000
      );

      expect(res[0]).toBe("OK_EXTENDED");
      expect(res[1]).toBe("65000"); // 5000 + 60000

      const rec = await redis.hgetall("reservation:res-1");
      expect(rec.status).toBe("PAYMENT_PENDING");
      expect(rec.expires_at).toBe("65000");

      const newScore = await redis.zscore(expiryQueueKey, "res-1");
      expect(newScore).toBe("65000");
    });
  });
});
