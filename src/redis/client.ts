import { Redis } from "ioredis";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { env } from "../config/env.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export const reserveStockLua = readFileSync(
  join(__dirname, "lua/reserve_stock.lua"),
  "utf-8"
);
export const reapExpiredLua = readFileSync(
  join(__dirname, "lua/reap_expired.lua"),
  "utf-8"
);
export const confirmOrderLua = readFileSync(
  join(__dirname, "lua/confirm_order.lua"),
  "utf-8"
);
export const extendHoldLua = readFileSync(
  join(__dirname, "lua/extend_hold.lua"),
  "utf-8"
);
export const checkRateLimitLua = readFileSync(
  join(__dirname, "lua/check_rate_limit.lua"),
  "utf-8"
);

export interface FlashLockRedis extends Redis {
  checkRateLimit(
    key: string,
    now: number | string,
    windowMs: number | string,
    limit: number | string,
    member: string
  ): Promise<number>;

  reserveStock(
    saleStateKey: string,
    userHoldsKey: string,
    expiryQueueKey: string,
    reservationKey: string,
    userPurchasesKey: string,
    idempotencyKey: string,
    resId: string,
    userId: string,
    qty: number | string,
    now: number | string,
    ttlMs: number | string,
    saleId: string,
    rawIdempotencyKey: string
  ): Promise<string[]>;

  reapExpired(
    saleStateKey: string,
    expiryQueueKey: string,
    userHoldsKey: string,
    now: number | string,
    batchSize: number | string
  ): Promise<string[]>;

  confirmOrder(
    saleStateKey: string,
    expiryQueueKey: string,
    userHoldsKey: string,
    userPurchasesKey: string,
    reservationKey: string,
    resId: string,
    outcome: string,
    now: number | string
  ): Promise<string[]>;

  extendHold(
    expiryQueueKey: string,
    reservationKey: string,
    resId: string,
    userId: string,
    now: number | string,
    extensionMs: number | string
  ): Promise<string[]>;
}

export function registerLuaCommands(redis: Redis): FlashLockRedis {
  redis.defineCommand("reserveStock", {
    numberOfKeys: 6,
    lua: reserveStockLua,
  });

  redis.defineCommand("reapExpired", {
    numberOfKeys: 3,
    lua: reapExpiredLua,
  });

  redis.defineCommand("confirmOrder", {
    numberOfKeys: 5,
    lua: confirmOrderLua,
  });

  redis.defineCommand("extendHold", {
    numberOfKeys: 2,
    lua: extendHoldLua,
  });

  redis.defineCommand("checkRateLimit", {
    numberOfKeys: 1,
    lua: checkRateLimitLua,
  });

  return redis as FlashLockRedis;
}

let redisInstance: FlashLockRedis | null = null;

export function getRedisClient(): FlashLockRedis {
  if (!redisInstance) {
    const rawClient = new Redis(env.REDIS_URL, {
      maxRetriesPerRequest: null,
      enableReadyCheck: true,
      lazyConnect: true,
    });
    redisInstance = registerLuaCommands(rawClient);
  }
  return redisInstance;
}
