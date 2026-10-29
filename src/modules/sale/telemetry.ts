import type { FlashLockRedis } from "../../redis/client.js";

export interface SaleTelemetry {
  saleId: string;
  totalStock: number;
  availableStock: number;
  heldStock: number;
  soldStock: number;
  /** availableStock + heldStock + soldStock */
  accountedStock: number;
  /** true iff Available + Held + Sold === Total and no counter is negative */
  invariantValid: boolean;
  timestamp: number;
}

export function buildTelemetry(
  saleId: string,
  state: Record<string, string>,
  now = Date.now()
): SaleTelemetry | null {
  if (!state || state.total_stock === undefined) return null;

  const totalStock = Number(state.total_stock);
  const availableStock = Number(state.available_stock ?? 0);
  const heldStock = Number(state.held_stock ?? 0);
  const soldStock = Number(state.sold_stock ?? 0);
  const accountedStock = availableStock + heldStock + soldStock;

  const finite = [totalStock, availableStock, heldStock, soldStock].every(Number.isFinite);
  const nonNegative = availableStock >= 0 && heldStock >= 0 && soldStock >= 0;

  return {
    saleId,
    totalStock,
    availableStock,
    heldStock,
    soldStock,
    accountedStock,
    invariantValid: finite && nonNegative && accountedStock === totalStock,
    timestamp: now,
  };
}

/**
 * Reads all counters with a single HGETALL, so the snapshot is atomic with
 * respect to the Lua scripts (they mutate the hash inside one script call).
 */
export async function readTelemetry(
  redis: FlashLockRedis,
  saleId: string
): Promise<SaleTelemetry | null> {
  const state = await redis.hgetall(`sale:${saleId}:state`);
  return buildTelemetry(saleId, state);
}
