import { z } from 'zod';
import {
  modelConnectionObservationSchema,
  modelConnectionProbeInputSchema,
  modelConnectionProbeReceiptSchema,
} from '../../../contracts/src/model-connections.js';
import { idSchema } from '../../../contracts/src/base.js';
import {
  modelProtocolSchema,
  modelAuthSchemeSchema,
} from '../../../contracts/src/model-protocol.js';
import type { ActorContext } from '../../../contracts/src/identity.js';
import type {
  Database,
  SqlExecutor,
} from '../../../persistence/src/database.js';
import { requirePlatformAdmin } from '../access/policy.js';
import { audit } from '../events.js';
import { DomainError, stale } from '../errors.js';
import { assertNewWorkAllowed } from '../recovery/maintenance.js';
import { resolveModelOutputBudget } from '../ai/model-output-budget.js';
import type { SecretBroker } from './secrets.js';
import type { ModelConfigurationV2Service } from './v2-service.js';

const count = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,29})$/)
  .nullable();
export const modelConnectionOutcomeSchema = z.strictObject({
  state: z.enum(['connected', 'failed', 'unknown']),
  code: z
    .string()
    .regex(/^[A-Z0-9_]{1,80}$/)
    .nullable(),
  upstreamHttpStatus: z.number().int().min(100).max(599).nullable(),
  attemptedRequests: z.union([z.literal(0), z.literal(1), z.null()]),
  dispatchCertainty: z.enum(['notDispatched', 'responseReceived', 'unknown']),
  clientRequestId: z.uuid().nullable(),
  providerRequestId: z
    .string()
    .regex(/^[A-Za-z0-9_.:/-]{1,200}$/)
    .nullable(),
  usage: z.strictObject({
    inputTokens: count,
    outputTokens: count,
    totalTokens: count,
    cachedInputTokens: count,
    reasoningOutputTokens: count,
  }),
});
export interface ModelConnectionProbePort {
  readonly executionOrigin: 'liveProvider' | 'fixture';
  run(input: {
    protocol: z.infer<typeof modelProtocolSchema>;
    authScheme: z.infer<typeof modelAuthSchemeSchema>;
    baseUrl: string;
    modelId: string;
    effort: string | null;
    maxTokens: number;
    credential: () => Promise<string>;
    dispatched: (clientRequestId: string) => Promise<void>;
  }): Promise<z.infer<typeof modelConnectionOutcomeSchema>>;
}
interface ProbeRow {
  id: string;
  initiator_user_id: string | null;
  source: string;
  task_id: string | null;
  auxiliary_task_id: string | null;
  logical_call_id: string | null;
  model_service_id: string;
  model_entry_id: string | null;
  model_config_revision: number;
  status: string;
  started_at: Date;
  finished_at: Date | null;
  code: string | null;
  http_status: number | null;
}
interface TargetRow {
  protocol: unknown;
  auth_scheme: unknown;
  base_url: string;
  credential_ref: string | null;
  config_revision: number;
  service_enabled: boolean;
  service_removed: Date | null;
  model_id: string;
  entry_enabled: boolean;
  entry_removed: Date | null;
  default_effort: string | null;
  context_limit: string | null;
  max_output: string | null;
}

/** Read live call evidence only for this exact saved connection/model revision.
 * This never rewrites capability matrices or immutable configuration history. */
export async function currentModelConnections(tx: SqlExecutor) {
  const rows = await tx.query<{
    model_service_id: string;
    model_entry_id: string;
    model_config_revision: number;
    status: string;
    checked_at: Date;
    source: string;
  }>(
    `SELECT DISTINCT ON(l.model_service_id,l.model_entry_id)
       l.model_service_id,l.model_entry_id,l.model_config_revision,l.status,
       COALESCE(l.finished_at,l.started_at) checked_at,l.source
     FROM app.model_call_ledger l JOIN app.model_services s
       ON s.id=l.model_service_id AND s.config_revision=l.model_config_revision
     JOIN app.model_entries e ON e.model_service_id=l.model_service_id AND e.id=l.model_entry_id
     WHERE l.execution_origin='liveProvider' AND l.model_entry_id IS NOT NULL
       AND l.model_id=e.model_id AND l.model_protocol=s.protocol
       AND ((l.status='completed' AND l.request_count=1) OR
         (l.status<>'completed' AND (l.request_count IS DISTINCT FROM 0 OR
           (l.source='background' AND l.logical_call_id=l.id AND l.task_id IS NULL AND l.auxiliary_task_id IS NULL))))
     ORDER BY l.model_service_id,l.model_entry_id,l.started_at DESC,l.id DESC`,
  );
  return rows.rows.map((row) =>
    modelConnectionObservationSchema.parse({
      modelServiceId: row.model_service_id,
      modelEntryId: row.model_entry_id,
      serviceRevision: row.model_config_revision,
      state:
        row.status === 'completed'
          ? 'connected'
          : row.status === 'failed'
            ? 'failed'
            : 'pending',
      checkedAt: row.checked_at.toISOString(),
      source: row.source,
    }),
  );
}

export class ModelConnectionsService {
  constructor(
    private readonly db: Database,
    private readonly broker: SecretBroker,
    private readonly configuration: ModelConfigurationV2Service,
    private readonly port?: ModelConnectionProbePort,
  ) {}
  private async target(
    tx: SqlExecutor,
    actor: ActorContext,
    serviceId: string,
    entryId: string,
    revision: number,
  ) {
    await requirePlatformAdmin(tx, actor);
    await this.configuration.ready(tx);
    const row = (
      await tx.query<TargetRow>(
        `SELECT s.protocol,s.auth_scheme,s.base_url,s.credential_ref,s.config_revision,
         s.enabled service_enabled,s.removed_at service_removed,e.model_id,
         e.enabled entry_enabled,e.removed_at entry_removed,e.default_effort,e.context_limit,e.max_output
       FROM app.model_services s JOIN app.model_entries e ON e.model_service_id=s.id
       WHERE s.id=$1 AND e.id=$2 FOR SHARE OF s,e`,
        [serviceId, entryId],
      )
    ).rows[0];
    if (!row)
      throw new DomainError('NOT_FOUND', '模型服务或模型行不存在。', 404);
    if (row.config_revision !== revision) stale();
    if (
      row.service_removed ||
      row.entry_removed ||
      !row.service_enabled ||
      !row.entry_enabled ||
      !row.credential_ref
    )
      throw new DomainError(
        'MODEL_NOT_CONFIGURED',
        '请启用此服务和模型，并安全配置 Key 后再测试连接。',
        422,
      );
    return row;
  }
  private async stored(tx: SqlExecutor, id: string) {
    return (
      await tx.query<ProbeRow>(
        `SELECT l.*,a.payload->>'code' code,(a.payload->>'upstreamHttpStatus')::integer http_status
       FROM app.model_call_ledger l LEFT JOIN LATERAL (
         SELECT payload FROM app.audit_events WHERE action='configuration.model-connection-tested' AND object_id=l.id ORDER BY created_at DESC,id DESC LIMIT 1
       ) a ON true WHERE l.id=$1`,
        [id],
      )
    ).rows[0];
  }
  private receipt(row: ProbeRow) {
    return modelConnectionProbeReceiptSchema.parse({
      probe: {
        commandId: row.id,
        modelServiceId: row.model_service_id,
        modelEntryId: row.model_entry_id,
        serviceRevision: row.model_config_revision,
        state:
          row.status === 'completed'
            ? 'connected'
            : row.status === 'failed'
              ? 'failed'
              : row.status === 'dispatchIntent'
                ? 'testing'
                : 'unknown',
        checkedAt: (row.finished_at ?? row.started_at).toISOString(),
        code: row.code,
        upstreamHttpStatus: row.http_status,
      },
    });
  }
  private ownProbe(
    row: ProbeRow | undefined,
    actor: ActorContext,
    serviceId: string,
  ) {
    return (
      row &&
      row.initiator_user_id === actor.userId &&
      row.model_service_id === serviceId &&
      row.source === 'background' &&
      row.task_id === null &&
      row.auxiliary_task_id === null &&
      row.logical_call_id === row.id &&
      row.model_entry_id !== null
    );
  }
  async get(actor: ActorContext, serviceId: string, commandId: string) {
    idSchema.parse(serviceId);
    idSchema.parse(commandId);
    return this.db.transaction(async (tx) => {
      await requirePlatformAdmin(tx, actor);
      await this.configuration.ready(tx);
      const row = await this.stored(tx, commandId);
      if (!row || !this.ownProbe(row, actor, serviceId))
        throw new DomainError('NOT_FOUND', '没有此账号的连接测试回执。', 404);
      return this.receipt(row);
    });
  }
  async test(actor: ActorContext, serviceId: string, raw: unknown) {
    idSchema.parse(serviceId);
    const input = modelConnectionProbeInputSchema.parse(raw),
      port = this.port;
    const prepared = await this.db.transaction(async (tx) => {
      await requirePlatformAdmin(tx, actor);
      await this.configuration.ready(tx);
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        `model-connection:${input.commandId}`,
      ]);
      const prior = await this.stored(tx, input.commandId);
      if (prior) {
        if (
          !this.ownProbe(prior, actor, serviceId) ||
          prior.model_entry_id !== input.modelEntryId ||
          prior.model_config_revision !== input.serviceRevision
        )
          throw new DomainError(
            'IDEMPOTENCY_CONFLICT',
            '原连接测试标识已经用于另一目标或修订。',
            409,
          );
        return { prior };
      }
      const target = await this.target(
        tx,
        actor,
        serviceId,
        input.modelEntryId,
        input.serviceRevision,
      );
      if (!port)
        throw new DomainError(
          'UNSUPPORTED_OPERATION',
          '当前服务器未接入连接测试传输。',
          422,
        );
      await assertNewWorkAllowed(tx, true);
      const maxTokens = resolveModelOutputBudget({
        maxOutput:
          target.max_output === null ? null : Number(target.max_output),
        contextLimit:
          target.context_limit === null ? null : Number(target.context_limit),
      });
      await tx.query(
        `INSERT INTO app.model_call_ledger(id,initiator_user_id,source,model_service_id,model_config_revision,model_id,model_entry_id,model_protocol,effort,status,execution_origin,request_count,dispatch_certainty,logical_call_id,attempt_no)
         VALUES($1,$2,'background',$3,$4,$5,$6,$7,$8,'dispatchIntent',$9,0,'notDispatched',$1,0)`,
        [
          input.commandId,
          actor.userId,
          serviceId,
          input.serviceRevision,
          target.model_id,
          input.modelEntryId,
          target.protocol,
          target.default_effort,
          port.executionOrigin,
        ],
      );
      return { target, maxTokens };
    });
    if ('prior' in prepared) return this.receipt(prepared.prior);
    if (!port) throw new Error('Connection port composition changed');
    let dispatched = false;
    let outcome: z.infer<typeof modelConnectionOutcomeSchema>;
    try {
      outcome = modelConnectionOutcomeSchema.parse(
        await port.run({
          protocol: modelProtocolSchema.parse(prepared.target.protocol),
          authScheme: modelAuthSchemeSchema.parse(prepared.target.auth_scheme),
          baseUrl: prepared.target.base_url,
          modelId: prepared.target.model_id,
          effort: prepared.target.default_effort,
          maxTokens: prepared.maxTokens,
          credential: async () => {
            const current = await this.db.transaction((tx) =>
              this.target(
                tx,
                actor,
                serviceId,
                input.modelEntryId,
                input.serviceRevision,
              ),
            );
            if (!current.credential_ref)
              throw new DomainError(
                'MODEL_NOT_CONFIGURED',
                '模型 Key 已不可用。',
                422,
              );
            return this.broker.resolve(current.credential_ref, {
              ownerScope: 'platform',
              ownerId: serviceId,
              purpose: 'model-api-key',
            });
          },
          dispatched: async (clientRequestId) => {
            idSchema.parse(clientRequestId);
            await this.db.transaction(async (tx) => {
              await this.target(
                tx,
                actor,
                serviceId,
                input.modelEntryId,
                input.serviceRevision,
              );
              await assertNewWorkAllowed(tx, true);
              const updated = await tx.query(
                `UPDATE app.model_call_ledger SET client_request_id=$2,request_count=NULL,dispatch_certainty='unknown'
               WHERE id=$1 AND initiator_user_id=$3 AND source='background' AND status='dispatchIntent' AND request_count=0`,
                [input.commandId, clientRequestId, actor.userId],
              );
              if (!updated.rowCount)
                throw new DomainError(
                  'BUSINESS_CONFLICT',
                  '原连接测试已发送或关闭，不会重发。',
                  409,
                );
            });
            dispatched = true;
          },
        }),
      );
      if (
        outcome.state === 'connected' &&
        (!dispatched ||
          outcome.attemptedRequests !== 1 ||
          outcome.dispatchCertainty !== 'responseReceived')
      )
        throw new Error('Unproven connection receipt');
    } catch {
      outcome = {
        state: dispatched ? 'unknown' : 'failed',
        code: dispatched ? 'RESULT_UNCONFIRMED' : 'REQUEST_NOT_DISPATCHED',
        upstreamHttpStatus: null,
        attemptedRequests: dispatched ? null : 0,
        dispatchCertainty: dispatched ? 'unknown' : 'notDispatched',
        clientRequestId: null,
        providerRequestId: null,
        usage: {
          inputTokens: null,
          outputTokens: null,
          totalTokens: null,
          cachedInputTokens: null,
          reasoningOutputTokens: null,
        },
      };
    }
    await this.db.transaction(async (tx) => {
      const result = await tx.query(
        `UPDATE app.model_call_ledger SET status=$2,request_count=$3,dispatch_certainty=$4,
           provider_request_id=$5,client_request_id=COALESCE($6,client_request_id),input_tokens=$7,output_tokens=$8,total_tokens=$9,cached_input_tokens=$10,reasoning_output_tokens=$11,finished_at=clock_timestamp()
         WHERE id=$1 AND initiator_user_id=$12 AND source='background' AND status='dispatchIntent' RETURNING id`,
        [
          input.commandId,
          outcome.state === 'connected' ? 'completed' : outcome.state,
          outcome.attemptedRequests,
          outcome.dispatchCertainty,
          outcome.providerRequestId,
          outcome.clientRequestId,
          outcome.usage.inputTokens,
          outcome.usage.outputTokens,
          outcome.usage.totalTokens,
          outcome.usage.cachedInputTokens,
          outcome.usage.reasoningOutputTokens,
          actor.userId,
        ],
      );
      if (!result.rowCount)
        throw new DomainError(
          'OPERATION_RESULT_UNKNOWN',
          '连接测试结果保存待核对，请查询原测试，不要重新发送。',
          409,
        );
      await audit(
        tx,
        actor,
        'configuration.model-connection-tested',
        input.commandId,
        null,
        {
          modelServiceId: serviceId,
          modelEntryId: input.modelEntryId,
          serviceRevision: input.serviceRevision,
          state: outcome.state,
          code: outcome.code,
          upstreamHttpStatus: outcome.upstreamHttpStatus,
        },
      );
    });
    return this.get(actor, serviceId, input.commandId);
  }
}
