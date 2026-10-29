import { randomUUID } from "crypto";
import type { FlashLockRedis } from "../../redis/client.js";
import type { SaleService } from "../sale/sale.service.js";
import type { ReserveService } from "../reservation/reserve.service.js";
import type { PaymentService } from "../payment-sim/payment.service.js";
import type { ReaperWorker } from "../../workers/reaper.worker.js";
import { readTelemetry } from "../sale/telemetry.js";

/** Uses an isolated sale and explicit reaper time; never alters process clock. */
export class RaceRunner {
  constructor(
    private sales: SaleService,
    private reservations: ReserveService,
    private payments: PaymentService,
    private reaper: ReaperWorker,
    private redis: FlashLockRedis
  ) {}

  async run() {
    const sale = await this.sales.createSale({
      title: "Isolated late-payment race",
      totalStock: 100,
      startTime: new Date(),
    });
    const userId = `race-${randomUUID()}`;
    const hold = await this.reservations.reserveStock({
      saleId: sale.id, userId, quantity: 2, idempotencyKey: randomUUID(),
    });
    if (hold.status !== 201) throw new Error("Race demo could not create hold");
    const reservationId = hold.data.reservationId;
    const expiry = Date.parse(hold.data.expiresAt);
    const before = await readTelemetry(this.redis, sale.id);
    // Logical t=300s: run actual Lua reaper at this hold's expiry boundary.
    await this.reaper.reapSale(sale.id, 1, expiry);
    const reaped = await readTelemetry(this.redis, sale.id);
    // Logical t=301s: real webhook handler, after reaper has completed.
    const result = await this.payments.processWebhook({
      event: "payment.succeeded",
      eventId: `race-${randomUUID()}`,
      data: { saleId: sale.id, reservationId, userId, paymentReference: `race-${randomUUID()}` },
    });
    if (result.status !== 200 || result.data.status !== "REFUNDED_LATE") {
      throw new Error("Race demo did not produce REFUNDED_LATE");
    }
    const after = await readTelemetry(this.redis, sale.id);
    return {
      saleId: sale.id, reservationId, status: result.data.status,
      simulated: true,
      timeline: { reapedAt: expiry, webhookAt: expiry + 1000 },
      before, reaped, after,
    };
  }
}
