import { randomUUID } from "crypto";
import type { ReserveService } from "../reservation/reserve.service.js";

export interface StampedeOptions {
  /** Number of concurrent virtual buyers. */
  buyers: number;
  /** Fraction of successful holds that proceed to checkout; the rest are abandoned. */
  checkoutRatio: number;
  /** Injectable RNG (0 <= x < 1) for reproducible runs. */
  random?: () => number;
}

export interface StampedeSummary {
  runId: string;
  saleId: string;
  buyers: number;
  held: number;
  rejected: number;
  failed: number;
  heldUnits: number;
  checkedOut: number;
  abandoned: number;
  durationMs: number;
}

/**
 * Spawns virtual buyers inside the backend process. Buyers call the service
 * layer directly (same code path as the HTTP routes, minus HTTP and rate limit).
 *
 * Abandoned holds are not touched: the Reaper reclaims them once the hold TTL
 * elapses, which is exactly the behaviour being demonstrated.
 */
export class StampedeRunner {
  private running = new Set<string>();

  constructor(private reserveService: ReserveService) {}

  isRunning(saleId: string): boolean {
    return this.running.has(saleId);
  }

  async run(saleId: string, options: StampedeOptions): Promise<StampedeSummary> {
    if (this.running.has(saleId)) {
      throw new Error(`Stampede already running for sale ${saleId}`);
    }
    this.running.add(saleId);

    const started = Date.now();
    const runId = randomUUID();
    const rand = options.random ?? Math.random;

    try {
      const buyers = Array.from({ length: options.buyers }, (_, i) => ({
        userId: `stampede-${runId.slice(0, 8)}-${i}`,
        quantity: rand() < 0.5 ? 1 : 2,
      }));

      // Phase 1: everyone hits reserve at once.
      const outcomes = await Promise.all(
        buyers.map(async (b) => {
          try {
            const res = await this.reserveService.reserveStock({
              saleId,
              userId: b.userId,
              quantity: b.quantity,
              idempotencyKey: `stampede:${runId}:${b.userId}`,
            });
            return { ...b, res };
          } catch (err) {
            console.error("Stampede buyer failed:", err);
            return { ...b, res: null };
          }
        })
      );

      const holds = outcomes.flatMap((o) =>
        o.res && o.res.status === 201
          ? [{ userId: o.userId, reservationId: o.res.data.reservationId, quantity: o.quantity }]
          : []
      );
      const failed = outcomes.filter((o) => o.res === null).length;
      const rejected = outcomes.length - holds.length - failed;

      // Phase 2: Fisher-Yates shuffle, then split checkout / abandon.
      for (let i = holds.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [holds[i], holds[j]] = [holds[j], holds[i]];
      }
      const checkoutCount = Math.round(holds.length * options.checkoutRatio);
      const checkingOut = holds.slice(0, checkoutCount);

      let checkedOut = 0;
      await Promise.all(
        checkingOut.map(async (h) => {
          try {
            const payment = await this.reserveService.initiatePayment({
              reservationId: h.reservationId,
              userId: h.userId,
            });
            if (payment.status === 200) checkedOut++;
          } catch (err) {
            console.error("Stampede checkout failed:", err);
          }
        })
      );

      return {
        runId,
        saleId,
        buyers: options.buyers,
        held: holds.length,
        rejected,
        failed,
        heldUnits: holds.reduce((acc, h) => acc + h.quantity, 0),
        checkedOut,
        abandoned: holds.length - checkingOut.length,
        durationMs: Date.now() - started,
      };
    } finally {
      this.running.delete(saleId);
    }
  }
}
