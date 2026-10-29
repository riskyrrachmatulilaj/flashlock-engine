import fastify, { type FastifyInstance } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { saleRoutes } from "./modules/sale/sale.routes.js";
import { reserveRoutes } from "./modules/reservation/reserve.routes.js";
import { webhookRoutes } from "./modules/payment-sim/webhook.routes.js";

export function buildApp(): FastifyInstance {
  const app = fastify({
    logger: false,
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  // Health check
  app.get("/health", async () => {
    return { status: "ok", timestamp: new Date().toISOString() };
  });

  // Core API routes
  app.register(saleRoutes);
  app.register(reserveRoutes);
  app.register(webhookRoutes);

  return app;
}
