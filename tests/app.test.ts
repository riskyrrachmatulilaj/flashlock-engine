import { describe, it, expect } from "vitest";
import { buildApp } from "../src/app.js";

describe("Fastify Application Integration", () => {
  it("GET /health responds with status ok", async () => {
    const app = buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/health",
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.status).toBe("ok");
    expect(body.timestamp).toBeDefined();
  });

  it("POST /api/v1/webhooks/payment validates payload schema", async () => {
    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/webhooks/payment",
      payload: {
        event: "invalid.event",
      },
    });

    expect(res.statusCode).toBe(400);
  });
});
