import { z } from 'zod';
import type { ActorContext } from '../../../contracts/src/identity.js';
import { externalCatalogToolSchema } from '../../../contracts/src/external-mcp.js';
import type { SqlExecutor } from '../../../persistence/src/database.js';
import { currentUser, requireProject } from '../access/policy.js';
import { DomainError, forbidden, stale } from '../errors.js';

/** Metadata-only current authority. No broker, external network or credential reference reaches this boundary. */
export async function externalConnectionReference(
  tx: SqlExecutor,
  actor: ActorContext,
  connectionId: string,
  pin?: {
    configRevision: number;
    credentialVersion: number;
    catalogDigest: string;
  },
) {
  if (actor.entrypoint === 'official-mcp') forbidden();
  await currentUser(tx, actor);
  const locator = (
    await tx.query<{ service_id: string }>(
      'SELECT service_id FROM app.external_mcp_connections WHERE id=$1 AND user_id=$2',
      [connectionId, actor.userId],
    )
  ).rows[0];
  if (!locator)
    throw new DomainError('NOT_FOUND', '外部连接当前不可访问。', 404);
  await tx.query(
    'SELECT id FROM app.external_mcp_services WHERE id=$1 FOR SHARE',
    [locator.service_id],
  );
  const row = (
    await tx.query<{
      connection_id: string;
      name: string;
      config_revision: number;
      credential_version: number;
      catalog_digest: string;
      tools: unknown;
    }>(
      `SELECT c.id connection_id,s.name,s.config_revision,c.credential_version,k.catalog_digest,k.tools FROM app.external_mcp_connections c
    JOIN app.external_mcp_services s ON s.id=c.service_id JOIN app.secret_records r ON r.id=c.credential_ref
    JOIN app.external_mcp_catalogs k ON k.id=c.current_catalog_id AND k.connection_id=c.id
    WHERE c.id=$1 AND c.user_id=$2 AND c.status='ready' AND r.revoked_at IS NULL AND s.enabled
    AND (s.access_policy='allActive' OR EXISTS(SELECT 1 FROM app.external_mcp_grants g WHERE g.service_id=s.id AND g.user_id=$2))
    AND k.config_revision=s.config_revision AND k.credential_version=c.credential_version FOR SHARE OF c,r`,
      [connectionId, actor.userId],
    )
  ).rows[0];
  if (!row)
    throw new DomainError(
      'NOT_FOUND',
      '外部连接当前未开放、未检查或已失效。',
      404,
    );
  if (
    pin &&
    (pin.configRevision !== row.config_revision ||
      pin.credentialVersion !== row.credential_version ||
      pin.catalogDigest !== row.catalog_digest)
  )
    stale();
  const tools = z
    .array(externalCatalogToolSchema)
    .parse(row.tools)
    .filter((tool) => tool.approved);
  return {
    connectionId: row.connection_id,
    name: row.name,
    configRevision: row.config_revision,
    credentialVersion: row.credential_version,
    catalogDigest: row.catalog_digest,
    tools,
  };
}
export async function externalInvocationReference(
  tx: SqlExecutor,
  actor: ActorContext,
  invocationId: string,
) {
  if (actor.entrypoint === 'official-mcp') forbidden();
  await currentUser(tx, actor);
  const row = (
    await tx.query<{
      id: string;
      connection_id: string;
      config_revision: number;
      credential_version: number;
      catalog_digest: string;
      project_id: string | null;
      state: string;
      result: unknown;
      source_refs: unknown;
      destination_name: string;
      tool_name: string;
    }>(
      `SELECT i.id,i.connection_id,i.config_revision,i.credential_version,k.catalog_digest,i.project_id,i.state,i.result,i.source_refs,i.destination_name,i.tool_name FROM app.external_mcp_invocations i JOIN app.external_mcp_catalogs k ON k.id=i.catalog_id WHERE i.id=$1 AND i.actor_id=$2`,
      [invocationId, actor.userId],
    )
  ).rows[0];
  if (!row || row.state !== 'completed' || row.result === null)
    throw new DomainError(
      'NOT_FOUND',
      '原外部调用没有当前可读的确定结果。',
      404,
    );
  await externalConnectionReference(tx, actor, row.connection_id, {
    configRevision: row.config_revision,
    credentialVersion: row.credential_version,
    catalogDigest: row.catalog_digest,
  });
  if (row.project_id)
    await requireProject(tx, actor, row.project_id, 'project.read');
  return row;
}
