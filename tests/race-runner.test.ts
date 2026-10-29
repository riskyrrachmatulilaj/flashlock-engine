import { afterEach, expect, it } from "vitest";
import { randomUUID } from "crypto";
import { createHarness, type Harness } from "./helpers/harness.js";
import { RaceRunner } from "../src/modules/simulator-runner/race.js";
import { saleRoutes } from "../src/modules/sale/sale.routes.js";
import type { SaleService } from "../src/modules/sale/sale.service.js";
import fastify from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";

let h: Harness;
afterEach(async () => { if (h) await h.close(); });

it("isolates race inventory, reaps at expiry and records REFUNDED_LATE", async () => {
  h = await createHarness();
  const sourceId = randomUUID();
  await h.initSale(sourceId, 100);
  const isolatedId = randomUUID();
  const sales = {
    createSale: async () => {
      await h.initSale(isolatedId, 100);
      return { id: isolatedId };
    },
  } as unknown as SaleService;
  const runner = new RaceRunner(sales, h.reserveService, h.paymentService, h.reaper, h.redis);
  const clockBefore = Date.now();
  const app = fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(saleRoutes, { redis: h.redis, saleService: sales, raceRunner: runner });
  let result: Awaited<ReturnType<RaceRunner["run"]>>;
  try {
    const invalid = await app.inject({ method: "POST", url: "/api/v1/sales/not-a-uuid/race" });
    expect(invalid.statusCode).toBe(400);
    const missing = await app.inject({ method: "POST", url: `/api/v1/sales/${randomUUID()}/race` });
    expect(missing.statusCode).toBe(404);
    const response = await app.inject({ method: "POST", url: `/api/v1/sales/${sourceId}/race` });
    expect(response.statusCode).toBe(200);
    result = response.json();
  } finally {
    await app.close();
  }
  expect(result.saleId).toBe(isolatedId);
  expect(result.status).toBe("REFUNDED_LATE");
  expect(result.timeline.webhookAt - result.timeline.reapedAt).toBe(1000);
  expect(result.before).toMatchObject({ availableStock: 98, heldStock: 2, soldStock: 0 });
  expect(result.after).toMatchObject({ availableStock: 100, heldStock: 0, soldStock: 0, invariantValid: true });
  expect(await h.readState(sourceId)).toEqual({ total: 100, available: 100, held: 0, sold: 0 });
  expect(h.persistedOrders).toContainEqual(expect.objectContaining({ status: "REFUNDED_LATE" }));
  expect(Date.now() - clockBefore).toBeLessThan(10000);
});

it("rejects concurrent race demos and releases guard after failure", async () => {
  h = await createHarness();
  const id = randomUUID();
  await h.initSale(id, 100);
  let reject!: (error: Error) => void;
  const gate = new Promise<never>((_, fail) => { reject = fail; });
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const runner = { run: () => { entered(); return gate; } } as unknown as RaceRunner;
  const app = fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(saleRoutes, { redis: h.redis, raceRunner: runner });
  try {
    const first = app.inject({ method: "POST", url: `/api/v1/sales/${id}/race` }).then(r => r);
    await started;
    const second = await app.inject({ method: "POST", url: `/api/v1/sales/${id}/race` });
    expect(second.statusCode).toBe(409);
    reject(new Error("Injected failure"));
    expect((await first).statusCode).toBe(500);
    const third = await app.inject({ method: "POST", url: `/api/v1/sales/${id}/race` });
    expect(third.statusCode).toBe(500); // Not stuck at 409 after failure.
  } finally {
    await app.close();
  }
});
