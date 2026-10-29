import type { FastifyRequest, FastifyReply } from "fastify";
import { randomUUID } from "crypto";
import { getRedisClient, type FlashLockRedis } from "../redis/client.js";

export interface RateLimitOptions {
  windowMs?: number;
  max?: number;
  redis?: FlashLockRedis;
}

export function createRateLimiter(options: RateLimitOptions = {}) {
  const windowMs = options.windowMs ?? 10000;
  const max = options.max ?? 5;

  return async function rateLimitMiddleware(request: FastifyRequest, reply: FastifyReply) {
    const userId = request.userId;
    if (!userId) {
      return;
    }

    const redis = options.redis ?? getRedisClient();
    const key = `ratelimit:${userId}`;
    const now = Date.now();
    const member = `${now}:${randomUUID()}`;

    const allowed = await redis.checkRateLimit(key, now, windowMs, max, member);

    if (Number(allowed) !== 1) {
      return reply.status(429).send({
        statusCode: 429,
        error: "Too Many Requests",
        message: `Rate limit exceeded (max ${max} requests per ${windowMs / 1000}s)`,
      });
    }
  };
}

export const rateLimitMiddleware = createRateLimiter();
