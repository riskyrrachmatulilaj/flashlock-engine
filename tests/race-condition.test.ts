import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { randomUUID } from "crypto";
import { createHarness, sumOfParts, type Harness } from "./helpers/harness.js";

const TOTAL_STOCK = 100;
const HOLD_TTL_MS = 300_000;

describe("Task 4.2: Deterministic Late-Webhook Race Test", () => {
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

  async function reserve(userId: string, quantity: number) {
    const res = await h.app.inject({
      method: "POST",
      url: `/api/v1/sales/${saleId}/reserve`,
      headers: { "x-user-id": userId },
      payload: { quantity },
    });
    expect(res.statusCode).toBe(201);
    return JSON.parse(res.body).reservationId as string;
  }

  function webhook(reservationId: string, userId: string, event: string, ref: string) {
    return h.app.inject({
      method: "POST",
      url: "/api/v1/webhooks/payment",
      payload: {
        eventId: `evt_${ref}`,
        event,
        data: { reservationId, saleId, userId, paymentReference: ref },
      },
    });
  }

  it("reservation reaped at t=300s then payment.succeeded at t=301s: Sold_Stock stays 0, status REFUNDED_LATE", async () => {
    const userId = "late-buyer";
    const qty = 2;

    // t = 0: reserve 2 units.
    const resId = await reserve(userId, qty);
    let s = await h.readState(saleId);
    expect(s).toEqual({ total: 100, available: 98, held: 2, sold: 0 });

    // t = 300s: hold expires, Reaper reclaims stock.
    vi.setSystemTime(T0 + HOLD_TTL_MS);
    const reaped = await h.reaper.reapOnce();
    expect(reaped[saleId]).toEqual([resId]);

    s = await h.readState(saleId);
    expect(s).toEqual({ total: 100, available: 100, held: 0, sold: 0 });
    expect(await h.redis.hget(`reservation:${resId}`, "status")).toBe("EXPIRED");

    // t = 301s: late payment.succeeded webhook arrives.
    vi.setSystemTime(T0 + HOLD_TTL_MS + 1_000);
    const res = await webhook(resId, userId, "payment.succeeded", "pay_late_301");

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.status).toBe("REFUNDED_LATE");
    expect(body.reservationId).toBe(resId);

    // Sold_Stock must NOT increment; counters untouched by the late webhook.
    s = await h.readState(saleId);
    expect(s.sold).toBe(0);
    expect(s).toEqual({ total: 100, available: 100, held: 0, sold: 0 });
    expect(sumOfParts(s)).toBe(TOTAL_STOCK);

    // Status is REFUNDED_LATE in Redis.
    expect(await h.redis.hget(`reservation:${resId}`, "status")).toBe("REFUNDED_LATE");

    // Durable records: refunded order + audit entry, no CONFIRMED order.
    const lateOrder = h.persistedOrders.find((o) => o.status === "REFUNDED_LATE");
    expect(lateOrder).toBeDefined();
    expect(lateOrder.reservationId).toBe(resId);
    expect(lateOrder.paymentReference).toBe("pay_late_301");
    expect(h.persistedOrders.some((o) => o.status === "CONFIRMED")).toBe(false);
    expect(h.persistedAuditLogs.some((a) => a.eventType === "REFUNDED_LATE")).toBe(true);
    expect(h.persistedAuditLogs.some((a) => a.eventType === "ORDER_CONFIRMED")).toBe(false);

    // User holds / purchases not granted.
    expect(await h.redis.hexists(`sale:${saleId}:user_purchases`, userId)).toBe(0);
  });

  it("reclaimed stock is resold to another buyer; the late webhook cannot oversell it", async () => {
    // Only 2 units: buyer A holds everything, buyer B is rejected.
    await h.redis.hset(`sale:${saleId}:state`, {
      total_stock: "2",
      available_stock: "2",
      held_stock: "0",
      sold_stock: "0",
    });
    const total = 2;

    const resA = await reserve("buyer-A", 2);
    const rejected = await h.app.inject({
      method: "POST",
      url: `/api/v1/sales/${saleId}/reserve`,
      headers: { "x-user-id": "buyer-B" },
      payload: { quantity: 2 },
    });
    expect(rejected.statusCode).toBe(409);

    // t = 300s: A's hold is reaped; B reserves the freed units and pays.
    vi.setSystemTime(T0 + HOLD_TTL_MS);
    await h.reaper.reapOnce();
    const resB = await reserve("buyer-B", 2);
    const payB = await webhook(resB, "buyer-B", "payment.succeeded", "pay_B");
    expect(JSON.parse(payB.body).status).toBe("CONFIRMED");

    // t = 301s: A's late payment.succeeded arrives.
    vi.setSystemTime(T0 + HOLD_TTL_MS + 1_000);
    const lateA = await webhook(resA, "buyer-A", "payment.succeeded", "pay_A_late");
    expect(JSON.parse(lateA.body).status).toBe("REFUNDED_LATE");

    const s = await h.readState(saleId);
    expect(s).toEqual({ total, available: 0, held: 0, sold: 2 });
    expect(sumOfParts(s)).toBe(total);
    expect(await h.redis.hget(`reservation:${resA}`, "status")).toBe("REFUNDED_LATE");
    expect(await h.redis.hget(`reservation:${resB}`, "status")).toBe("CONFIRMED");
  });

  it("duplicate late webhook is a no-op for stock counters", async () => {
    const userId = "dup-late";
    const resId = await reserve(userId, 1);

    vi.setSystemTime(T0 + HOLD_TTL_MS);
    await h.reaper.reapOnce();
    vi.setSystemTime(T0 + HOLD_TTL_MS + 1_000);

    const first = await webhook(resId, userId, "payment.succeeded", "pay_dup_1");
    expect(JSON.parse(first.body).status).toBe("REFUNDED_LATE");

    // Replay: Redis status is now REFUNDED_LATE; must not credit sold stock.
    await webhook(resId, userId, "payment.succeeded", "pay_dup_2");

    const s = await h.readState(saleId);
    expect(s).toEqual({ total: 100, available: 100, held: 0, sold: 0 });
    expect(sumOfParts(s)).toBe(TOTAL_STOCK);
  });
});
