import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { getRedisClient, type FlashLockRedis } from "../../redis/client.js";
import { ReserveService } from "../reservation/reserve.service.js";
import { StampedeRunner } from "../simulator-runner/stampede.js";
import { createSaleSchema, saleParamsSchema } from "./sale.schema.js";
import { SaleService } from "./sale.service.js";
import { readTelemetry } from "./telemetry.js";
import { RaceRunner } from "../simulator-runner/race.js";
import { PaymentService } from "../payment-sim/payment.service.js";
import { ReaperWorker } from "../../workers/reaper.worker.js";

export const STREAM_INTERVAL_MS = 250;

export const stampedeBodySchema = z
  .object({
    buyers: z.number().int().min(1).max(5000).default(1000),
    checkoutRatio: z.number().min(0).max(1).default(0.7),
  })
  .nullish()
  .transform((v) => ({ buyers: v?.buyers ?? 1000, checkoutRatio: v?.checkoutRatio ?? 0.7 }));

export interface SaleRoutesOptions {
  saleService?: SaleService;
  redis?: FlashLockRedis;
  stampedeRunner?: StampedeRunner;
  streamIntervalMs?: number;
  raceRunner?: RaceRunner;
}

export const saleRoutes: FastifyPluginAsyncZod<SaleRoutesOptions> = async (fastify, opts) => {
  const redis = opts?.redis || getRedisClient();
  const saleService = opts?.saleService || new SaleService(undefined, redis);
  const stampedeRunner = opts?.stampedeRunner || new StampedeRunner(new ReserveService(undefined, redis));
  const streamIntervalMs = opts?.streamIntervalMs ?? STREAM_INTERVAL_MS;
  const raceRunner = opts?.raceRunner || new RaceRunner(
    saleService, new ReserveService(undefined, redis), new PaymentService(undefined, redis),
    new ReaperWorker(undefined, redis), redis
  );
  let raceRunning = false;
  const streams = new Set<() => void>();
  fastify.addHook("preClose", async () => {
    for (const close of streams) close();
  });

  fastify.post("/api/v1/sales/:id/race", {
    schema: { params: saleParamsSchema },
  }, async (request, reply) => {
    if (!await readTelemetry(redis, request.params.id)) {
      return reply.status(404).send({ error: "Not Found", message: "Sale not found" });
    }
    if (raceRunning) {
      return reply.status(409).send({ error: "Conflict", message: "Race demo already running" });
    }
    raceRunning = true;
    try {
      return await raceRunner.run();
    } finally {
      raceRunning = false;
    }
  });

  fastify.post(
    "/api/v1/sales",
    {
      schema: {
        body: createSaleSchema,
      },
    },
    async (request, reply) => {
      const sale = await saleService.createSale(request.body);
      return reply.status(201).send(sale);
    }
  );

  fastify.get(
    "/api/v1/sales/:id",
    {
      schema: {
        params: saleParamsSchema,
      },
    },
    async (request, reply) => {
      const sale = await saleService.getSaleById(request.params.id);
      if (!sale) {
        return reply.status(404).send({
          statusCode: 404,
          error: "Not Found",
          message: "Sale not found",
        });
      }
      return reply.send(sale);
    }
  );

  // SSE telemetry: Redis counters + invariantValid every 250ms.
  fastify.get(
    "/api/v1/sales/:id/stream",
    {
      schema: {
        params: saleParamsSchema,
      },
    },
    async (request, reply) => {
      const saleId = request.params.id;

      const first = await readTelemetry(redis, saleId);
      if (!first) {
        return reply.status(404).send({
          statusCode: 404,
          error: "Not Found",
          message: "Sale not found",
        });
      }

      reply.hijack();
      const raw = reply.raw;
      raw.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
        "Access-Control-Allow-Origin": "*",
      });
      raw.write("retry: 1000\n\n");

      let closed = false;
      let inFlight = false;
      let timer: NodeJS.Timeout | null = null;

      const send = (event: string, data: unknown) => {
        if (closed || raw.destroyed || raw.writableEnded) return;
        raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      };

      const cleanup = () => {
        if (closed) return;
        closed = true;
        streams.delete(cleanup);
        if (timer) clearInterval(timer);
        if (!raw.writableEnded) raw.end();
      };

      streams.add(cleanup);
      send("telemetry", first);

      // Non-overlapping ticks: skip a tick while a read is still pending.
      timer = setInterval(async () => {
        if (inFlight || closed || raw.writableNeedDrain) return;
        inFlight = true;
        try {
          const t = await readTelemetry(redis, saleId);
          if (t) send("telemetry", t);
        } catch (err) {
          send("error", { message: err instanceof Error ? err.message : "telemetry failed" });
        } finally {
          inFlight = false;
        }
      }, streamIntervalMs);

      request.raw.on("close", cleanup);
      raw.on("close", cleanup);
    }
  );

  // Stampede trigger: spawns virtual buyers in the backend, returns immediately.
  fastify.post(
    "/api/v1/sales/:id/stampede",
    {
      schema: {
        params: saleParamsSchema,
        body: stampedeBodySchema,
      },
    },
    async (request, reply) => {
      const saleId = request.params.id;
      const { buyers, checkoutRatio } = request.body;

      const state = await readTelemetry(redis, saleId);
      if (!state) {
        return reply.status(404).send({
          statusCode: 404,
          error: "Not Found",
          message: "Sale not found",
        });
      }

      if (stampedeRunner.isRunning(saleId)) {
        return reply.status(409).send({
          statusCode: 409,
          error: "Conflict",
          message: "A stampede is already running for this sale",
        });
      }

      stampedeRunner
        .run(saleId, { buyers, checkoutRatio })
        .then((summary) => fastify.log.info({ summary }, "stampede finished"))
        .catch((err) => console.error("Stampede run failed:", err));

      return reply.status(202).send({
        status: "STARTED",
        saleId,
        buyers,
        checkoutRatio,
      });
    }
  );
};
