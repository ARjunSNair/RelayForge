import { AppError } from '@relayforge/contracts';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { registerErrorHandling } from './errors.js';

const apps: ReturnType<typeof Fastify>[] = [];

function build() {
  const app = Fastify({ logger: false, bodyLimit: 64 });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  registerErrorHandling(app);
  app.post('/echo', { schema: { body: z.object({ name: z.string() }) } }, async () => ({}));
  app.get('/app-error', async () => {
    throw new AppError('NOT_FOUND', 'No such thing');
  });
  app.get('/boom', async () => {
    throw new Error('secret internal detail');
  });
  apps.push(app);
  return app;
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((a) => a.close()));
});

describe('error envelope', () => {
  it('maps AppError to its status and code', async () => {
    const res = await build().inject({ method: 'GET', url: '/app-error' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toMatchObject({ code: 'NOT_FOUND', message: 'No such thing' });
    expect(res.json().error.requestId).toEqual(expect.any(String));
  });

  it('reports schema violations as VALIDATION_ERROR', async () => {
    const res = await build().inject({ method: 'POST', url: '/echo', payload: { name: 1 } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
    expect(res.json().error.message).toMatch(/^body\/name: /);
  });

  it('reports malformed JSON as VALIDATION_ERROR', async () => {
    const res = await build().inject({
      method: 'POST',
      url: '/echo',
      headers: { 'content-type': 'application/json' },
      payload: '{nope',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects oversized bodies with 413', async () => {
    const res = await build().inject({
      method: 'POST',
      url: '/echo',
      payload: { name: 'x'.repeat(200) },
    });
    expect(res.statusCode).toBe(413);
    expect(res.json().error.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('rejects non-JSON content types with 415', async () => {
    const res = await build().inject({
      method: 'POST',
      url: '/echo',
      headers: { 'content-type': 'application/xml' },
      payload: '<a/>',
    });
    expect(res.statusCode).toBe(415);
    expect(res.json().error.code).toBe('UNSUPPORTED_MEDIA_TYPE');
  });

  it('hides the message of unexpected errors', async () => {
    const res = await build().inject({ method: 'GET', url: '/boom' });
    expect(res.statusCode).toBe(500);
    expect(res.json().error).toMatchObject({
      code: 'INTERNAL_ERROR',
      message: 'An internal error occurred',
    });
    expect(res.body).not.toContain('secret internal detail');
  });

  it('answers unknown routes with the same envelope', async () => {
    const res = await build().inject({ method: 'GET', url: '/missing' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
  });
});
