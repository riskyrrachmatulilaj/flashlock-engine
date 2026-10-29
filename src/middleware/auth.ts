import type { FastifyRequest, FastifyReply } from "fastify";

declare module "fastify" {
  interface FastifyRequest {
    userId?: string;
  }
}

export async function authMiddleware(request: FastifyRequest, reply: FastifyReply) {
  const userIdHeader = request.headers["x-user-id"];
  const userId = Array.isArray(userIdHeader) ? userIdHeader[0] : userIdHeader;

  if (!userId || typeof userId !== "string" || userId.trim() === "") {
    return reply.status(401).send({
      statusCode: 401,
      error: "Unauthorized",
      message: "Missing or empty x-user-id header",
    });
  }

  request.userId = userId.trim();
}
