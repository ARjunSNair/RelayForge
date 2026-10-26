import type { Queryable } from '@relayforge/database';
import type { FastifyRequest } from 'fastify';
import { tenantOf } from './auth.js';

export type AuditAction =
  | 'endpoint.created'
  | 'endpoint.updated'
  | 'endpoint.secret_rotated'
  | 'delivery.replayed';

export async function recordAudit(
  db: Queryable,
  request: FastifyRequest,
  action: AuditAction,
  resource: { type: 'endpoint' | 'delivery'; id: string },
): Promise<void> {
  const { tenantId, apiKeyId } = tenantOf(request);
  await db.query(
    `INSERT INTO audit_events (tenant_id, api_key_id, action, resource_type, resource_id, request_id)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [tenantId, apiKeyId, action, resource.type, resource.id, request.id],
  );
}
