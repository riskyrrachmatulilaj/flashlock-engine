import { inArray } from "drizzle-orm";
import { db as defaultDb } from "../db/index.js";
import { reservations } from "../db/schema.js";
import { getRedisClient, type FlashLockRedis } from "../redis/client.js";

export class ReaperWorker {
  private isRunning = false;
  private timer: NodeJS.Timeout | null = null;
  private activeSales: Set<string> = new Set();

  constructor(
    private db = defaultDb,
    private redis: FlashLockRedis = getRedisClient()
  ) {}

  registerSale(saleId: string): void {
    this.activeSales.add(saleId);
  }

  async getActiveSales(): Promise<string[]> {
    const redisSales = await this.redis.smembers("sales:active");
    const combined = new Set([...redisSales, ...this.activeSales]);
    return Array.from(combined);
  }

  async reapSale(saleId: string, batchSize = 100, now = Date.now()): Promise<string[]> {
    const saleStateKey = `sale:${saleId}:state`;
    const expiryQueueKey = `sale:${saleId}:expiry_queue`;
    const userHoldsKey = `sale:${saleId}:user_holds`;

    const reapedIds = await this.redis.reapExpired(
      saleStateKey,
      expiryQueueKey,
      userHoldsKey,
      now,
      batchSize
    );

    if (Array.isArray(reapedIds) && reapedIds.length > 0) {
      try {
        await this.db
          .update(reservations)
          .set({
            status: "EXPIRED",
            updatedAt: new Date(now),
          })
          .where(inArray(reservations.id, reapedIds));
      } catch (err) {
        console.error(`Reaper failed to sync expired reservations to PostgreSQL for sale ${saleId}:`, err);
      }
    }

    return reapedIds || [];
  }

  async reapOnce(batchSize = 100): Promise<{ [saleId: string]: string[] }> {
    const saleIds = await this.getActiveSales();
    const results: { [saleId: string]: string[] } = {};

    for (const saleId of saleIds) {
      const reaped = await this.reapSale(saleId, batchSize);
      if (reaped.length > 0) {
        results[saleId] = reaped;
      }
    }

    return results;
  }

  start(intervalMs = 1000): void {
    if (this.timer) return;

    const tick = async () => {
      if (!this.isRunning) {
        this.isRunning = true;
        try {
          await this.reapOnce();
        } catch (err) {
          console.error("Reaper cycle error:", err);
        } finally {
          this.isRunning = false;
        }
      }
      this.timer = setTimeout(tick, intervalMs);
    };

    this.timer = setTimeout(tick, intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}

export const reaperWorker = new ReaperWorker();
