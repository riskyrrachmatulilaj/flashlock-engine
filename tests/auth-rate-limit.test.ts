import { describe, it, expect, beforeEach } from "vitest";
import fastify, { type FastifyInstance } from "fastify";
import RedisMock from "ioredis-mock";
import { registerLuaCommands, type FlashLockRedis } from "../src/redis/client.js";
import { authMiddleware } from "../src/middleware/auth.js";
import { createRateLimiter } from "../src/middleware/rate-limit.js";

describe("Phase 2.2: Auth & Rate Limit Middleware", () => {
  let redis: FlashLockRedis;
  let app: FastifyInstance;

  beforeEach(async () => {
    const rawMock = new RedisMock();
    redis = registerLuaCommands(rawMock as any);
    await redis.flushall();

    app = fastify({ logger: false });

    // Test route with auth and rate limiter
    const rateLimiter = createRateLimiter({ redis, max: 5, windowMs: 10000 });
    app.post("/test-protected", { preHandler: [authMiddleware, rateLimiter] }, async (req) => {
      return { success: true, userId: req.userId };
    });
  });

  describe("Auth Middleware", () => {
    it("rejects request missing x-user-id with 401", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/test-protected",
      });

      expect(res.statusCode).toBe(401);
      const body = JSON.parse(res.body);
      expect(body.error).toBe("Unauthorized");
      expect(body.message).toMatch(/Missing or empty x-user-id/);
    });

    it("rejects request with empty/whitespace x-user-id with 401", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/test-protected",
        headers: {
          "x-user-id": "   ",
        },
      });

      expect(res.statusCode).toBe(401);
    });

    it("accepts request with valid x-user-id", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/test-protected",
        headers: {
          "x-user-id": "user-42",
        },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.userId).toBe("user-42");
    });
  });

  describe("Sliding-Window Rate Limiter Middleware", () => {
    it("allows up to 5 requests per 10s per user and blocks 6th with 429", async () => {
      const headers = { "x-user-id": "spammer-99" };

      for (let i = 1; i <= 5; i++) {
        const res = await app.inject({
          method: "POST",
          url: "/test-protected",
          headers,
        });
        expect(res.statusCode).toBe(200);
      }

      // 6th request must be rejected
      const blockedRes = await app.inject({
        method: "POST",
        url: "/test-protected",
        headers,
      });

      expect(blockedRes.statusCode).toBe(429);
      const body = JSON.parse(blockedRes.body);
      expect(body.error).toBe("Too Many Requests");
      expect(body.message).toMatch(/Rate limit exceeded/);
    });

    it("tracks rate limits per user independently", async () => {
      const userA = { "x-user-id": "user-a" };
      const userB = { "x-user-id": "user-b" };

      // User A uses all 5 quota
      for (let i = 1; i <= 5; i++) {
        await app.inject({ method: "POST", url: "/test-protected", headers: userA });
      }

      // User A blocked
      const resA = await app.inject({ method: "POST", url: "/test-protected", headers: userA });
      expect(resA.statusCode).toBe(429);

      // User B is still permitted
      const resB = await app.inject({ method: "POST", url: "/test-protected", headers: userB });
      expect(resB.statusCode).toBe(200);
    });
  });
});
