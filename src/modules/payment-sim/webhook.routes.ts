import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { paymentWebhookSchema } from "./payment.schema.js";
import { PaymentService, defaultPaymentService } from "./payment.service.js";

export interface WebhookRoutesOptions {
  paymentService?: PaymentService;
}

export const webhookRoutes: FastifyPluginAsyncZod<WebhookRoutesOptions> = async (
  fastify,
  opts
) => {
  const paymentService = opts?.paymentService || defaultPaymentService;

  fastify.post(
    "/api/v1/webhooks/payment",
    {
      schema: {
        body: paymentWebhookSchema,
      },
    },
    async (request, reply) => {
      const result = await paymentService.processWebhook(request.body);

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
