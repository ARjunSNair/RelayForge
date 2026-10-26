import { AppError, type ErrorBody, type ErrorCode } from '@relayforge/contracts';
import { errorFields } from '@relayforge/observability';
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

function send(
  reply: FastifyReply,
  request: FastifyRequest,
  status: number,
  code: ErrorCode,
  message: string,
) {
  const body: ErrorBody = { error: { code, message, requestId: request.id } };
  return reply.status(status).send(body);
}

/** Uniform error envelope (design §6). Never exposes stack traces or internal messages. */
export function registerErrorHandling(app: FastifyInstance): void {
  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (error instanceof AppError) {
      return send(reply, request, error.statusCode, error.code, error.message);
    }
    if (error.validation) {
      const first = error.validation[0];
      const where = first?.instancePath
        ? `${error.validationContext ?? 'request'}${first.instancePath}`
        : error.validationContext;
      const detail = first?.message ?? 'is invalid';
      return send(reply, request, 400, 'VALIDATION_ERROR', `${where ?? 'request'}: ${detail}`);
    }
    if (error.code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
      return send(reply, request, 413, 'PAYLOAD_TOO_LARGE', 'Request body is too large');
    }
    if (error.code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE') {
      return send(
        reply,
        request,
        415,
        'UNSUPPORTED_MEDIA_TYPE',
        'Content-Type must be application/json',
      );
    }
    if (error.statusCode === 400) {
      return send(reply, request, 400, 'VALIDATION_ERROR', 'Malformed request');
    }
    request.log.error({ ...errorFields(error), operation: 'http_request' }, 'unhandled error');
    return send(reply, request, 500, 'INTERNAL_ERROR', 'An internal error occurred');
  });

  app.setNotFoundHandler((request, reply) =>
    send(reply, request, 404, 'NOT_FOUND', 'Route not found'),
  );
}
