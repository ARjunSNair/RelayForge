import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebhookHttpClient } from './http-client.js';

let server: Server;
let base: string;
let received: { method?: string; body: string; signature?: string } | undefined;

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const path = req.url ?? '/';
      received = {
        method: req.method,
        body: Buffer.concat(chunks).toString('utf8'),
        signature: req.headers['x-test-signature'] as string | undefined,
      };
      if (path === '/redirect') {
        res.writeHead(302, { location: '/ok' }).end();
      } else if (path === '/slow') {
        setTimeout(() => res.writeHead(200).end(), 1_000);
      } else if (path === '/retry') {
        res.writeHead(429, { 'retry-after': '7' }).end('slow down');
      } else {
        res.writeHead(204).end();
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

describe('WebhookHttpClient', () => {
  const client = new WebhookHttpClient({ timeoutMs: 200, allowInsecure: true });
  afterAll(() => client.close());

  it('posts the body and headers and reports the status', async () => {
    const result = await client.post(
      new URL(`${base}/ok`),
      { 'x-test-signature': 'v1=abc' },
      '{"a":1}',
    );
    expect(result).toMatchObject({ kind: 'response', status: 204 });
    expect(received).toEqual({ method: 'POST', body: '{"a":1}', signature: 'v1=abc' });
  });

  it('surfaces the Retry-After header', async () => {
    const result = await client.post(new URL(`${base}/retry`), {}, '{}');
    expect(result).toMatchObject({ kind: 'response', status: 429, retryAfter: '7' });
  });

  it('does not follow redirects', async () => {
    const result = await client.post(new URL(`${base}/redirect`), {}, '{}');
    expect(result).toMatchObject({ kind: 'response', status: 302 });
  });

  it('reports a slow destination as TIMEOUT', async () => {
    const result = await client.post(new URL(`${base}/slow`), {}, '{}');
    expect(result).toMatchObject({ kind: 'error', code: 'TIMEOUT' });
  });

  it('reports a refused connection as NETWORK_ERROR', async () => {
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const port = (closed.address() as AddressInfo).port;
    await new Promise((resolve) => closed.close(resolve));
    const result = await client.post(new URL(`http://127.0.0.1:${port}/`), {}, '{}');
    expect(result).toMatchObject({ kind: 'error', code: 'NETWORK_ERROR' });
  });

  it('blocks private destinations unless insecure destinations are allowed', async () => {
    const strict = new WebhookHttpClient({ timeoutMs: 500, allowInsecure: false });
    try {
      const result = await strict.post(
        new URL(base.replace('127.0.0.1', 'localhost') + '/ok'),
        {},
        '{}',
      );
      expect(result).toMatchObject({ kind: 'error', code: 'DESTINATION_BLOCKED' });
    } finally {
      await strict.close();
    }
  });
});
