import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { randomUUID } from "crypto";
import {
  createHarness,
  mulberry32,
  sumOfParts,
  type Harness,
  type SaleState,
} from "./helpers/harness.js";

const TOTAL_STOCK = 100;
const BUYERS = 1000;
const CHECKOUT_RATIO = 0.7; // 70% checkout, 30% abandon
const HOLD_TTL_MS = 300_000;

interface Hold {
  userId: string;
  reservationId: string;
  quantity: number;
}

describe("Task 4.1: 1,000-Buyer Stampede Invariant Test", () => {
  let h: Harness;
  let saleId: string;
  const T0 = 1_800_000_000_000;

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    h = await createHarness();
    saleId = randomUUID();
    await h.initSale(saleId, TOTAL_STOCK);
  });

  afterEach(async () => {
    await h.close();
    vi.useRealTimers();
  });

  /**
   * Samples the stock counters continuously while `work` runs, recording any
   * snapshot where Available + Held + Sold !== Total or any counter is negative.
   */
  async function withInvariantSampler<T>(
    work: () => Promise<T>
  ): Promise<{ result: T; samples: number; violations: SaleState[] }> {
    const violations: SaleState[] = [];
    let samples = 0;
    let running = true;

    const sampler = (async () => {
      while (running) {
        const s = await h.readState(saleId);
        samples++;
        if (
          sumOfParts(s) !== TOTAL_STOCK ||
          s.total !== TOTAL_STOCK ||
          s.available < 0 ||
          s.held < 0 ||
          s.sold < 0
        ) {
          violations.push(s);
        }
        await new Promise((r) => setImmediate(r));
      }
    })();

    try {
      const result = await work();
      return { result, samples, violations };
    } finally {
      running = false;
      await sampler;
    }
  }

  async function expectInvariant(label: string): Promise<SaleState> {
    const s = await h.readState(saleId);
    expect(sumOfParts(s), `invariant broken at stage: ${label}`).toBe(TOTAL_STOCK);
    expect(s.available).toBeGreaterThanOrEqual(0);
    expect(s.held).toBeGreaterThanOrEqual(0);
    expect(s.sold).toBeGreaterThanOrEqual(0);
    expect(s.sold).toBeLessThanOrEqual(TOTAL_STOCK); // 0 oversold units
    return s;
  }

  it(
    "keeps Available + Held + Sold === 100 at every stage with 0 oversold units",
    async () => {
      const rand = mulberry32(0xf1a5);

      // Stage 0: initial state
      const s0 = await expectInvariant("initial");
      expect(s0).toEqual({ total: 100, available: 100, held: 0, sold: 0 });

      // ---- Stage 1: 1,000 concurrent reservation requests (qty 1 or 2) ----
      const buyers = Array.from({ length: BUYERS }, (_, i) => ({
        userId: `buyer-${i}`,
        quantity: rand() < 0.5 ? 1 : 2,
      }));

      const reserve = await withInvariantSampler(() =>
        Promise.all(
          buyers.map(async (b) => {
            const res = await h.app.inject({
              method: "POST",
              url: `/api/v1/sales/${saleId}/reserve`,
              headers: { "x-user-id": b.userId },
              payload: { quantity: b.quantity },
            });
            return { ...b, statusCode: res.statusCode, body: JSON.parse(res.body) };
          })
        )
      );

      expect(reserve.violations, "invariant violated during reservation stampede").toEqual([]);
      expect(reserve.samples).toBeGreaterThan(0);

      const responses = reserve.result;
      const created = responses.filter((r) => r.statusCode === 201);
      const rejected = responses.filter((r) => r.statusCode !== 201);

      // Only well-formed outcomes: created, insufficient stock, sold out.
      for (const r of rejected) {
        expect([409, 410]).toContain(r.statusCode);
      }

      const holds: Hold[] = created.map((r) => ({
        userId: r.userId,
        reservationId: r.body.reservationId,
        quantity: r.quantity,
      }));
      const heldUnits = holds.reduce((acc, x) => acc + x.quantity, 0);

      expect(heldUnits).toBeLessThanOrEqual(TOTAL_STOCK); // never oversold
      expect(new Set(holds.map((x) => x.reservationId)).size).toBe(holds.length);

      const s1 = await expectInvariant("after reservation stampede");
      expect(s1.held).toBe(heldUnits);
      expect(s1.available).toBe(TOTAL_STOCK - heldUnits);
      expect(s1.sold).toBe(0);
      // Demand (~1,500 units) far exceeds supply: stock must be (nearly) drained.
      expect(s1.available).toBeLessThanOrEqual(1);
      // Anyone rejected for stock must have wanted more than what was left.
      for (const r of rejected) {
        expect(r.quantity).toBeGreaterThan(s1.available);
      }

      // ---- Stage 2: 70% checkout / 30% abandonment ----
      const checkoutCount = Math.round(holds.length * CHECKOUT_RATIO);
      const shuffled = [...holds];
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
      }
      const checkingOut = shuffled.slice(0, checkoutCount);
      const abandoning = shuffled.slice(checkoutCount);
      const paidUnits = checkingOut.reduce((acc, x) => acc + x.quantity, 0);
      const abandonedUnits = abandoning.reduce((acc, x) => acc + x.quantity, 0);

      const pay = await withInvariantSampler(async () => {
        const payResponses = await Promise.all(
          checkingOut.map((x) =>
            h.app.inject({
              method: "POST",
              url: `/api/v1/reservations/${x.reservationId}/pay`,
              headers: { "x-user-id": x.userId },
              payload: { delayMs: 0, forceOutcome: "succeeded" },
            })
          )
        );
        await h.waitForDispatches(checkingOut.length);
        return payResponses;
      });

      expect(pay.violations, "invariant violated during checkout phase").toEqual([]);
      for (const r of pay.result) {
        expect(r.statusCode).toBe(200);
      }

      const s2 = await expectInvariant("after checkout settled");
      expect(s2.sold).toBe(paidUnits);
      expect(s2.held).toBe(abandonedUnits);
      expect(s2.available).toBe(s1.available);

      // ---- Stage 3: abandoned holds expire; Reaper reclaims stock ----
      vi.setSystemTime(T0 + HOLD_TTL_MS + 1_000);

      const reap = await withInvariantSampler(async () => {
        // batchSize=1: ioredis-mock (fengari) returns `undefined` for Lua scripts
        // that build a multi-element table dynamically. Real Redis is unaffected;
        // single-item batches exercise the identical reap_expired.lua path.
        const reaped: string[] = [];
        while ((await h.redis.zcard(`sale:${saleId}:expiry_queue`)) > 0) {
          const batch = await h.reaper.reapOnce(1);
          reaped.push(...Object.values(batch).flat());
        }
        return reaped;
      });

      expect(reap.violations, "invariant violated during reaping").toEqual([]);
      expect(new Set(reap.result)).toEqual(new Set(abandoning.map((x) => x.reservationId)));

      const s3 = await expectInvariant("after reaper");
      expect(s3.held).toBe(0);
      expect(s3.sold).toBe(paidUnits);
      expect(s3.available).toBe(TOTAL_STOCK - paidUnits);

      // ---- Final: durable state matches counters ----
      for (const x of checkingOut) {
        expect(await h.redis.hget(`reservation:${x.reservationId}`, "status")).toBe("CONFIRMED");
      }
      for (const x of abandoning) {
        expect(await h.redis.hget(`reservation:${x.reservationId}`, "status")).toBe("EXPIRED");
      }
      expect(await h.redis.zcard(`sale:${saleId}:expiry_queue`)).toBe(0);

      const confirmedOrders = h.persistedOrders.filter((o) => o.status === "CONFIRMED");
      expect(confirmedOrders.length).toBe(checkingOut.length);
      expect(confirmedOrders.reduce((acc, o) => acc + o.quantity, 0)).toBe(s3.sold);
      expect(h.persistedOrders.filter((o) => o.status === "REFUNDED_LATE")).toHaveLength(0);

      // Zero oversold units, final.
      expect(s3.sold).toBeLessThanOrEqual(TOTAL_STOCK);
      expect(sumOfParts(s3)).toBe(TOTAL_STOCK);
    },
    60_000
  );
});
