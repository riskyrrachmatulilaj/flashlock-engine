import { eq } from "drizzle-orm";
import { db as defaultDb } from "../../db/index.js";
import { sales } from "../../db/schema.js";
import { getRedisClient, type FlashLockRedis } from "../../redis/client.js";
import type { CreateSaleInput } from "./sale.schema.js";

export class SaleService {
  constructor(
    private db = defaultDb,
    private redis: FlashLockRedis = getRedisClient()
  ) {}

  async createSale(input: CreateSaleInput) {
    const startTime = input.startTime ?? new Date();
    const now = new Date();
    const initialStatus = startTime.getTime() <= now.getTime() ? "ACTIVE" : "SCHEDULED";

    // 1. Insert into PostgreSQL
    const [createdSale] = await this.db
      .insert(sales)
      .values({
        title: input.title,
        totalStock: input.totalStock,
        availableStock: input.totalStock,
        startTime,
        endTime: input.endTime ?? null,
        status: initialStatus,
      })
      .returning();

    const saleId = createdSale.id;
    const saleStateKey = `sale:${saleId}:state`;

    // 2. Initialize Redis hot state
    await this.redis.hset(saleStateKey, {
      id: saleId,
      title: input.title,
      total_stock: input.totalStock.toString(),
      available_stock: input.totalStock.toString(),
      held_stock: "0",
      sold_stock: "0",
      start_time: startTime.getTime().toString(),
      status: initialStatus,
    });

    // 3. Track active sale in Redis set for Reaper scanning
    await this.redis.sadd("sales:active", saleId);

    return {
      id: createdSale.id,
      title: createdSale.title,
      totalStock: createdSale.totalStock,
      availableStock: createdSale.availableStock,
      heldStock: 0,
      soldStock: 0,
      startTime: createdSale.startTime.toISOString(),
      endTime: createdSale.endTime ? createdSale.endTime.toISOString() : null,
      status: createdSale.status,
      createdAt: createdSale.createdAt.toISOString(),
      updatedAt: createdSale.updatedAt.toISOString(),
    };
  }

  async getSaleById(id: string) {
    const saleStateKey = `sale:${id}:state`;
    const redisState = await this.redis.hgetall(saleStateKey);

    if (redisState && redisState.total_stock) {
      return {
        id,
        title: redisState.title || "",
        totalStock: parseInt(redisState.total_stock, 10),
        availableStock: parseInt(redisState.available_stock || "0", 10),
        heldStock: parseInt(redisState.held_stock || "0", 10),
        soldStock: parseInt(redisState.sold_stock || "0", 10),
        startTime: new Date(Number(redisState.start_time)).toISOString(),
        status: redisState.status || "ACTIVE",
      };
    }

    const [sale] = await this.db.select().from(sales).where(eq(sales.id, id)).limit(1);
    if (!sale) return null;

    return {
      id: sale.id,
      title: sale.title,
      totalStock: sale.totalStock,
      availableStock: sale.availableStock,
      heldStock: 0,
      soldStock: 0,
      startTime: sale.startTime.toISOString(),
      endTime: sale.endTime ? sale.endTime.toISOString() : null,
      status: sale.status,
      createdAt: sale.createdAt.toISOString(),
      updatedAt: sale.updatedAt.toISOString(),
    };
  }
}
