import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { randomUUID } from "crypto";
import { authMiddleware } from "../../middleware/auth.js";
import { rateLimitMiddleware } from "../../middleware/rate-limit.js";
import {
  reserveParamsSchema,
  reserveBodySchema,
  payParamsSchema,
  payBodySchema,
} from "./reserve.schema.js";
import { ReserveService } from "./reserve.service.js";

export interface ReserveRoutesOptions {
  reserveService?: ReserveService;
  rateLimiter?: (request: any, reply: any) => Promise<any> | any;
}

export const reserveRoutes: FastifyPluginAsyncZod<ReserveRoutesOptions> = async (
  fastify,
  opts
) => {
  const reserveService = opts?.reserveService || new ReserveService();
  const rateLimiter = opts?.rateLimiter || rateLimitMiddleware;

  fastify.post(
    "/api/v1/sales/:id/reserve",
    {
      preHandler: [authMiddleware, rateLimiter],
      schema: {
        params: reserveParamsSchema,
        body: reserveBodySchema,
      },
    },
    async (request, reply) => {
      const saleId = request.params.id;
      const userId = request.userId!;
      const quantity = request.body?.quantity ?? 1;

      // Extract idempotency key from header or body, or generate one
      const headerKey = request.headers["idempotency-key"] || request.headers["x-idempotency-key"];
      const rawHeaderKey = Array.isArray(headerKey) ? headerKey[0] : headerKey;
      const idempotencyKey = rawHeaderKey || request.body?.idempotencyKey || `auto:${userId}:${saleId}:${randomUUID()}`;

      const result = await reserveService.reserveStock({
        saleId,
        userId,
        quantity,
        idempotencyKey,
      });

      if (result.status === 201 || result.status === 200) {
        return reply.status(result.status).send(result.data);
      }

      return reply.status(result.status).send({
        statusCode: result.status,
        error: result.error,
        message: result.message,
      });
    }
  );

  fastify.post(
    "/api/v1/reservations/:id/pay",
    {
      preHandler: [authMiddleware, rateLimiter],
      schema: {
        params: payParamsSchema,
        body: payBodySchema,
      },
    },
    async (request, reply) => {
      const reservationId = request.params.id;
      const userId = request.userId!;
      const body = request.body;

      const result = await reserveService.initiatePayment({
        reservationId,
        userId,
        delayMs: body?.delayMs,
        forceOutcome: body?.forceOutcome,
      });

      if (result.status === 200) {
        return reply.status(200).send(result.data);
      }

      return reply.status(result.status).send({
        statusCode: result.status,
        error: result.error,
        message: result.message,
      });
    }
  );
};
