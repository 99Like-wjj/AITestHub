import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { multipartFileInputSchema } from '../../../contracts/src/api-multipart.js';
import type { ApiMultipartFiles } from '../files/api-multipart.js';
import { apiRequestVariableReferences } from '../../../contracts/src/api-variable-refs.js';
import {
  apiCaseCompletionInputSchema,
  apiExecutionStatusSchema,
  apiResultTraceSchema,
  apiAttemptDetailSchema,
  apiStopInputSchema,
  apiStopStatusSchema,
  attemptReceiptInputSchema,
  localStepFailureInputSchema,
  workerActionInputSchema,
  workerInstanceInputSchema,
  type ApiPhase,
  type ApiScopeItem,
  type JsonValue,
  type RuntimeVariables,
  type SendPermit,
  type WorkerTransport,
} from '../../../contracts/src/api-execution.js';
import {
  apiCaseContentSchema,
  resultItemSchema,
  type ResultItem,
} from '../../../contracts/src/domain.js';
import type { ActorContext } from '../../../contracts/src/identity.js';
import type {
  Database,
  SqlExecutor,
} from '../../../persistence/src/database.js';
import { requireProject } from '../access/policy.js';
import { SecretBroker } from '../configuration/secrets.js';
import { DomainError } from '../errors.js';
import {
  canonicalJson,
  operationRequestHash,
  OperationService,
} from '../operations/service.js';
import { PlanService } from '../plans/service.js';
import { recordApiCaseInTransaction } from '../results/service.js';
import { persistReportRevision } from '../reports/service.js';
import {
  ExecutionGateway,
  profileFor,
  publicEnvironment,
  requestFor,
  type TargetPolicy,
  targetPolicySchema,
} from './gateway.js';
import { contextVariables, nonEmpty, readPath } from './expressions.js';
import {
  redact,
  redactExtraction,
  redactResponse,
  validSensitiveExtraction,
} from './redaction.js';
import { ApiDebugService } from './debug.js';
import { ApiRegressionService } from '../assets/api-regression.js';
import { assertNewWorkAllowed } from '../recovery/maintenance.js';
import { hasDispatchFence, recordDispatchFence } from '../recovery/fences.js';
import {
  ApiRunAdmission,
  type ApiRunAdmissionPort,
} from '../resource-concurrency/worker-admission.js';
import { resourcePolicyReaderFromEnvironment } from '../resource-policy/environment.js';
import {
  configurationFor,
  parseScope,
  runActor,
  type ExecutionRunRow,
  type FrozenConfiguration,
} from './types.js';

interface GrantedRun extends ExecutionRunRow {
  grant_id: string;
  worker_instance_id: string;
  fence: number;
  expires_at: Date;
  revoked_at: Date | null;
}
type ScopeItem = ApiScopeItem;
interface AttemptRow {
  id: string;
  phase: ApiPhase;
  step_id: string;
  request_digest: string;
  state: string;
  outcome: 'passed' | 'failed' | null;
  send_intent_at: Date | null;
  side_effect_certainty: 'known' | 'unknown' | 'notApplicable';
  response_safe: unknown;
  receipt_digest: string | null;
  extractions_safe: unknown;
  assertions_safe: unknown;
  reason: string;
  request_safe: unknown;
}
const hash = (value: string) =>
  createHash('sha256').update(value).digest('hex');
const runSelect = `SELECT r.*,COALESCE(r.origin_key_id,q.origin_key_id) origin_key_id FROM app.runs r LEFT JOIN app.api_execution_requests q ON q.run_id=r.id`;
const protectedBinding = (itemId: string) => ({
  ownerScope: 'project' as const,
  ownerId: itemId,
  purpose: 'api-redaction-value',
});
const taintedBinding = (itemId: string) => ({
  ownerScope: 'project' as const,
  ownerId: itemId,
  purpose: 'api-tainted-variable',
});
const authBinding = (itemId: string) => ({
  ownerScope: 'project' as const,
  ownerId: itemId,
  purpose: 'api-auth-token',
});
const terminal = new Set([
  'completed',
  'terminated',
  'interrupted',
  'recoveryRequired',
]);
function summarize(
  content: z.infer<typeof apiCaseContentSchema>,
  attempts: AttemptRow[],
) {
  const business = attempts.filter((entry) => entry.phase === 'business');
  const allPassed = content.steps.every((step) =>
    business.some(
      (entry) => entry.step_id === step.stepId && entry.outcome === 'passed',
    ),
  );
  const assertionCount = business.reduce(
    (count, entry) =>
      count + z.array(z.unknown()).parse(entry.assertions_safe).length,
    0,
  );
  const businessPassed = allPassed && assertionCount > 0;
  const cleanup = attempts.filter(
    (entry) => entry.phase === 'cleanupHttp' || entry.phase === 'cleanupSql',
  );
  const cleanupState =
    content.cleanup.mode === 'none'
      ? 'notConfigured'
      : content.cleanup.mode === 'onSuccess' && !businessPassed
        ? 'skipped'
        : cleanup.some((entry) => entry.state === 'unknown')
          ? 'interrupted'
          : cleanup.some(
                (entry) =>
                  entry.outcome === 'failed' || entry.state === 'failed',
              )
            ? 'failed'
            : cleanup.some((entry) => entry.state === 'skipped')
              ? 'skipped'
              : cleanup.length === content.cleanup.steps.length &&
                  cleanup.every((entry) => entry.outcome === 'passed')
                ? 'succeeded'
                : 'interrupted';
  const unknown = attempts.some(
    (entry) =>
      entry.state === 'unknown' || entry.side_effect_certainty === 'unknown',
  );
  const sideEffect: 'known' | 'unknown' | 'notApplicable' = unknown
    ? 'unknown'
    : attempts.some((entry) => entry.send_intent_at !== null)
      ? 'known'
      : 'notApplicable';
  return {
    allPassed,
    assertionCount,
    businessPassed,
    cleanupState,
    unknown,
    sideEffect,
  };
}
export class ApiExecutionControlService {
  readonly gateway: ExecutionGateway;
  readonly operations: OperationService;
  readonly debug: ApiDebugService;
  readonly regression: ApiRegressionService;
  constructor(
    readonly db: Database,
    readonly plans: PlanService,
    readonly secrets: SecretBroker,
    private readonly bootstrapHash: string | null,
    policy?: TargetPolicy,
    readonly leaseMs = 30000,
    debugRetentionDays = 7,
    private readonly admission: ApiRunAdmissionPort = new ApiRunAdmission(),
    private readonly multipartFiles?: ApiMultipartFiles,
  ) {
    this.gateway = new ExecutionGateway(plans.configurations, secrets, policy);
    this.operations = new OperationService(db);
    this.debug = new ApiDebugService(
      db,
      plans,
      this.gateway,
      debugRetentionDays,
    );
    this.regression = new ApiRegressionService(db);
  }
  private isDraftDebug(run: ExecutionRunRow) {
    return parseScope(run).schemaVersion === 'ath.debug-execution-scope.v1';
  }
  private async assertVisible(transaction: SqlExecutor, runId: string) {
    const schema = (
      await transaction.query<{ schema: string }>(
        "SELECT scope_snapshot->>'schemaVersion' schema FROM app.runs WHERE id=$1",
        [runId],
      )
    ).rows[0]?.schema;
    if (
      schema === 'ath.expired-debug.v1' ||
      (schema === 'ath.debug-execution-scope.v1' &&
        !(
          await transaction.query(
            `SELECT 1 FROM app.api_debug_drafts d WHERE d.run_id=$1 AND
             (d.expires_at>clock_timestamp() OR EXISTS
              (SELECT 1 FROM app.api_regression_qualifications q WHERE q.debug_run_id=d.run_id))`,
            [runId],
          )
        ).rowCount)
    )
      throw new DomainError('NOT_FOUND', '调试诊断已过临时保留期。', 404);
  }
  async status(actor: ActorContext, projectId: string, runId: string) {
    return this.db.transaction(async (transaction) => {
      await requireProject(transaction, actor, projectId, 'project.read');
      const run = (
        await transaction.query<ExecutionRunRow>(
          `${runSelect} WHERE r.id=$1 AND r.project_id=$2 AND r.kind='API'`,
          [runId, projectId],
        )
      ).rows[0];
      if (!run) throw new DomainError('NOT_FOUND', '没有此平台接口运行。', 404);
      await this.assertVisible(transaction, runId);
      return apiExecutionStatusSchema.parse({
        run: {
          id: run.id,
          runSnapshotId: run.run_snapshot_id,
          state: run.state,
          deliveryStatus: run.delivery_status,
          cleanupState: run.cleanup_state,
          scope: parseScope(run),
          createdAt: run.created_at.toISOString(),
        },
      });
    });
  }
  private async archiveResult(
    transaction: SqlExecutor,
    run: ExecutionRunRow,
    item: ScopeItem,
    result: ResultItem,
    outcomeOverride?: 'passed' | 'failed' | 'notExecuted' | null,
  ) {
    if (!this.isDraftDebug(run))
      return recordApiCaseInTransaction(
        transaction,
        runActor(run),
        run.project_id,
        run.id,
        item.runItemId,
        result,
      );
    const outcome =
      outcomeOverride === undefined ? result.originalOutcome : outcomeOverride;
    await transaction.query(
      'UPDATE app.run_items SET outcome=$2,side_effect_certainty=$3,state=$4,ended_at=$5 WHERE id=$1',
      [
        item.runItemId,
        outcome,
        result.sideEffectCertainty,
        outcome === 'notExecuted' ? 'notExecuted' : 'completed',
        result.endedAt ?? null,
      ],
    );
    if (outcome === 'notExecuted')
      await transaction.query(
        `INSERT INTO app.api_case_facts(run_item_id,project_id,run_id,original_outcome,reason,ended_at)
      VALUES($1,$2,$3,'notExecuted',$4,clock_timestamp()) ON CONFLICT(run_item_id) DO NOTHING`,
        [item.runItemId, run.project_id, run.id, result.reason ?? '未执行'],
      );
    return { resultId: null, revisionId: null, replayed: false };
  }
  private async report(
    transaction: SqlExecutor,
    run: ExecutionRunRow,
    reason: string,
    actor = runActor(run),
  ) {
    if (this.isDraftDebug(run)) {
      await transaction.query(
        "UPDATE app.runs SET delivery_status='complete' WHERE id=$1",
        [run.id],
      );
      return { reportId: null };
    }
    return persistReportRevision(
      transaction,
      actor,
      run.project_id,
      run.id,
      reason,
    );
  }
  /** AI tools need authorized business operations, never private worker authentication. */
  static forBusinessTools(
    db: Database,
    plans: PlanService,
    secrets: SecretBroker,
    environment: NodeJS.ProcessEnv = process.env,
  ): Pick<
    ApiExecutionControlService,
    'events' | 'attemptDetail' | 'stop' | 'status' | 'debug' | 'regression'
  > {
    const service = new ApiExecutionControlService(
      db,
      plans,
      secrets,
      null,
      undefined,
      30000,
      z.coerce
        .number()
        .int()
        .min(1)
        .max(30)
        .parse(environment.AITESTHUB_API_DEBUG_RETENTION_DAYS ?? 7),
    );
    return {
      events: service.events.bind(service),
      attemptDetail: service.attemptDetail.bind(service),
      stop: service.stop.bind(service),
      status: service.status.bind(service),
      debug: service.debug,
      regression: service.regression,
    };
  }
  static async fromEnvironment(
    db: Database,
    plans: PlanService,
    secrets: SecretBroker,
    environment: NodeJS.ProcessEnv = process.env,
    multipartFiles?: ApiMultipartFiles,
  ) {
    const root =
      environment.AITESTHUB_LOCAL_ROOT ??
      (environment.LOCALAPPDATA
        ? join(environment.LOCALAPPDATA, 'AITestHub')
        : undefined);
    const path =
      environment.AITESTHUB_API_WORKER_BOOTSTRAP_FILE ??
      (root ? join(root, 'secrets', 'api-worker-bootstrap') : undefined);
    if (!path)
      throw new Error('AITESTHUB_API_WORKER_BOOTSTRAP_FILE is required.');
    let value: string;
    try {
      value = (await readFile(path, 'utf8')).trim();
    } catch {
      throw new Error('API worker bootstrap file could not be read.');
    }
    if (value.length < 32)
      throw new Error('API worker bootstrap credential is invalid.');
    let policy: TargetPolicy | undefined;
    if (environment.AITESTHUB_TEST_TARGET_POLICY_FILE) {
      try {
        const body = await readFile(
          environment.AITESTHUB_TEST_TARGET_POLICY_FILE,
          'utf8',
        );
        if (Buffer.byteLength(body) > 1048576) throw new Error();
        policy = targetPolicySchema.parse(JSON.parse(body) as unknown);
      } catch {
        throw new Error(
          'AITESTHUB_TEST_TARGET_POLICY_FILE could not be read or is invalid.',
        );
      }
    }
    const control = new ApiExecutionControlService(
      db,
      plans,
      secrets,
      hash(value),
      policy,
      30000,
      z.coerce
        .number()
        .int()
        .min(1)
        .max(30)
        .parse(environment.AITESTHUB_API_DEBUG_RETENTION_DAYS ?? 7),
      new ApiRunAdmission(() =>
        resourcePolicyReaderFromEnvironment(environment),
      ),
      multipartFiles,
    );
    await control.debug.cleanupExpired();
    return control;
  }
  verifyBootstrap(value: string | undefined): void {
    if (
      !this.bootstrapHash ||
      !value ||
      !timingSafeEqual(
        Buffer.from(hash(value), 'hex'),
        Buffer.from(this.bootstrapHash, 'hex'),
      )
    )
      throw new DomainError('UNAUTHENTICATED', '执行worker认证无效。', 401);
  }
  private async event(
    transaction: SqlExecutor,
    runId: string,
    type: string,
    payload: unknown,
  ) {
    await transaction.query(
      'INSERT INTO app.api_run_events(run_id,event_type,payload) VALUES($1,$2,$3)',
      [runId, type, JSON.stringify(payload)],
    );
  }
  private async grant(
    transaction: SqlExecutor,
    token: string,
  ): Promise<GrantedRun> {
    const row = (
      await transaction.query<GrantedRun>(
        `SELECT r.*,COALESCE(r.origin_key_id,q.origin_key_id) origin_key_id,g.id grant_id,g.worker_instance_id,g.fence,g.expires_at,g.revoked_at
      FROM app.api_worker_grants g JOIN app.runs r ON r.id=g.run_id LEFT JOIN app.api_execution_requests q ON q.run_id=r.id
      WHERE g.grant_hash=$1 FOR UPDATE OF g,r`,
        [hash(token)],
      )
    ).rows[0];
    if (
      !row ||
      row.revoked_at ||
      row.expires_at.getTime() <= Date.now() ||
      row.kind !== 'API' ||
      terminal.has(row.state)
    )
      throw new DomainError(
        'UNAUTHENTICATED',
        '运行授权已失效；不得重新发送在途请求。',
        401,
      );
    return row;
  }
  private item(run: ExecutionRunRow, id: string): ScopeItem {
    const item = parseScope(run).items.find((item) => item.runItemId === id);
    if (!item) throw new DomainError('NOT_FOUND', '授权运行中没有此项。', 404);
    return item;
  }
  private async available(
    transaction: SqlExecutor,
    run: ExecutionRunRow,
  ): Promise<boolean> {
    try {
      await requireProject(
        transaction,
        runActor(run),
        run.project_id,
        'runs.organize',
      );
      return true;
    } catch (error: unknown) {
      if (error instanceof DomainError && [401, 403].includes(error.status))
        return false;
      throw error;
    }
  }
  private async remember(
    transaction: SqlExecutor,
    itemId: string,
    values: string[],
  ) {
    for (const value of new Set(values.filter(Boolean))) {
      const fingerprint = this.secrets.fingerprint(
        value,
        protectedBinding(itemId),
      );
      if (
        (
          await transaction.query(
            'SELECT 1 FROM app.api_protected_values WHERE run_item_id=$1 AND value_fingerprint=$2',
            [itemId, fingerprint],
          )
        ).rowCount
      )
        continue;
      const reference = await this.secrets.store(
        transaction,
        value,
        protectedBinding(itemId),
      );
      await transaction.query(
        'INSERT INTO app.api_protected_values(run_item_id,value_fingerprint,secret_ref) VALUES($1,$2,$3)',
        [itemId, fingerprint, reference],
      );
    }
  }
  private async protection(
    transaction: SqlExecutor,
    itemId: string,
  ): Promise<string[]> {
    const rows = await transaction.query<{ secret_ref: string }>(
      'SELECT secret_ref FROM app.api_protected_values WHERE run_item_id=$1',
      [itemId],
    );
    const values = [];
    for (const row of rows.rows)
      values.push(
        await this.secrets.resolveInTransaction(
          transaction,
          row.secret_ref,
          protectedBinding(itemId),
        ),
      );
    return values;
  }
  private async variables(
    transaction: SqlExecutor,
    itemId: string,
    input: RuntimeVariables,
    run: ExecutionRunRow,
    configuration: FrozenConfiguration,
    requiredReferences: readonly string[],
  ): Promise<{ variables: RuntimeVariables; fromMultipartFile: boolean }> {
    const extracts: Record<string, JsonValue> = {};
    let fromMultipartFile = false;
    const attempts = await transaction.query<{ extractions_safe: unknown }>(
      "SELECT extractions_safe FROM app.api_step_attempts WHERE run_item_id=$1 AND state='completed' ORDER BY created_at,id",
      [itemId],
    );
    for (const attempt of attempts.rows)
      Object.assign(
        extracts,
        z.record(z.string(), z.json()).parse(attempt.extractions_safe),
      );
    const protectedVariables = await transaction.query<{
      name: string;
      secret_ref: string;
    }>(
      'SELECT name,secret_ref FROM app.api_tainted_variables WHERE run_item_id=$1',
      [itemId],
    );
    for (const entry of protectedVariables.rows) {
      const references = requiredReferences.filter(
        (reference) =>
          reference === `extract.${entry.name}` ||
          reference.startsWith(`extract.${entry.name}.`) ||
          reference.startsWith(`extract.${entry.name}[`),
      );
      if (!references.length) continue;
      const raw: unknown = JSON.parse(
        await this.secrets.resolveInTransaction(
          transaction,
          entry.secret_ref,
          taintedBinding(itemId),
        ),
      );
      const parsed = z
        .strictObject({
          value: z.json(),
          sourceIntentId: z.uuid(),
          protectedPaths: z.array(z.string()),
          fromMultipartFile: z.literal(true).optional(),
        })
        .safeParse(raw);
      if (!parsed.success)
        throw new DomainError(
          'PRECONDITIONS_MISSING',
          '受保护提取值缺少来源证明，未注入。',
          422,
        );
      const envelope = parsed.data;
      const pointers = references.map((reference) =>
        reference
          .slice(`extract.${entry.name}`.length)
          .replace(/\[(\d+)\]/g, '.$1')
          .split('.')
          .filter(Boolean)
          .map((part) => `/${part.replace(/~/g, '~0').replace(/\//g, '~1')}`)
          .join(''),
      );
      if (
        !pointers.some((pointer) =>
          envelope.protectedPaths.some(
            (protectedPath) =>
              protectedPath === pointer ||
              protectedPath.startsWith(`${pointer}/`) ||
              pointer.startsWith(`${protectedPath}/`),
          ),
        )
      )
        continue;
      const source = (
        await transaction.query<{ phase: ApiPhase; step_id: string }>(
          "SELECT phase,step_id FROM app.api_step_attempts WHERE id=$1 AND run_item_id=$2 AND state='completed'",
          [envelope.sourceIntentId, itemId],
        )
      ).rows[0];
      if (
        !source ||
        (source.phase !== 'business' && source.phase !== 'cleanupHttp')
      )
        throw new DomainError(
          'PRECONDITIONS_MISSING',
          '受保护提取值缺少可追溯原始来源，未注入。',
          422,
        );
      const content = apiCaseContentSchema.parse(
        this.item(run, itemId).content,
      );
      const original = requestFor(content, source.phase, source.step_id);
      await this.gateway.validateConfiguration(
        transaction,
        run.project_id,
        this.gateway.actionConfiguration(configuration, original),
      );
      extracts[entry.name] = envelope.value;
      if (envelope.fromMultipartFile) fromMultipartFile = true;
    }
    for (const name of Object.keys(input.case))
      if (['__proto__', 'prototype', 'constructor'].includes(name))
        throw new DomainError(
          'VALIDATION_ERROR',
          '变量名称不符合隔离约束。',
          400,
        );
    return {
      variables: { case: input.case, extract: extracts },
      fromMultipartFile,
    };
  }
  async claim(raw: unknown) {
    const input = workerInstanceInputSchema.parse(raw);
    await this.reconcileExpired();
    await this.debug.cleanupExpired();
    return this.db.transaction(async (transaction) => {
      await assertNewWorkAllowed(transaction, true);
      const slot = await this.admission.checkInTransaction(transaction);
      await transaction.query(
        'INSERT INTO app.api_worker_instances(id) VALUES($1) ON CONFLICT(id) DO UPDATE SET last_seen_at=clock_timestamp()',
        [input.workerInstanceId],
      );
      const busy = await transaction.query(
        'SELECT 1 FROM app.api_worker_grants WHERE worker_instance_id=$1 AND revoked_at IS NULL AND expires_at>clock_timestamp()',
        [input.workerInstanceId],
      );
      if (busy.rowCount)
        return { assigned: false, reason: 'worker-already-assigned' };
      if (!slot.allowed) return { assigned: false, reason: 'capacity' };
      let run = (
        await transaction.query<ExecutionRunRow>(
          `${runSelect} WHERE r.kind='API' AND r.state='prepared' AND ($1::uuid IS NULL OR r.id=$1) AND $2::uuid IS NULL
        AND NOT EXISTS(SELECT 1 FROM app.api_worker_grants g WHERE g.run_id=r.id) ORDER BY r.created_at,r.id LIMIT 1 FOR UPDATE OF r SKIP LOCKED`,
          [input.desiredRunId ?? null, input.desiredRequestId ?? null],
        )
      ).rows[0];
      if (!run && !input.desiredRunId) {
        for (let index = 0; index < 50 && !run; index++) {
          const queued = (
            await transaction.query<{ id: string }>(
              "SELECT id FROM app.api_execution_requests WHERE state='queued' AND ($1::uuid IS NULL OR id=$1) ORDER BY created_at,id LIMIT 1 FOR UPDATE SKIP LOCKED",
              [input.desiredRequestId ?? null],
            )
          ).rows[0];
          if (!queued) break;
          const started = await this.plans.startQueuedInTransaction(
            transaction,
            queued.id,
          );
          if (started.run)
            run = (
              await transaction.query<ExecutionRunRow>(
                `${runSelect} WHERE r.id=$1`,
                [started.run.id],
              )
            ).rows[0];
        }
      }
      if (!run) return { assigned: false, reason: 'idle' };
      if (run.source === 'scheduled') {
        try {
          await this.plans.validateScheduledPreparedInTransaction(
            transaction,
            run.id,
          );
        } catch (error: unknown) {
          if (!(error instanceof DomainError)) throw error;
          await this.plans.rejectUnclaimedScheduledInTransaction(
            transaction,
            run.id,
            error,
          );
          return { assigned: false, reason: 'scheduled-intent-not-started' };
        }
      }
      const token = `ath_run_${randomBytes(32).toString('hex')}`;
      await transaction.query(
        "INSERT INTO app.api_worker_grants(id,run_id,worker_instance_id,grant_hash,expires_at) VALUES($1,$2,$3,$4,clock_timestamp()+$5::integer*interval '1 millisecond')",
        [
          randomUUID(),
          run.id,
          input.workerInstanceId,
          hash(token),
          this.leaseMs,
        ],
      );
      await transaction.query(
        "UPDATE app.runs SET state='running',execution_provenance='platform-api' WHERE id=$1",
        [run.id],
      );
      await this.event(transaction, run.id, 'worker.claimed', {
        workerInstanceId: input.workerInstanceId,
      });
      return {
        assigned: true,
        runId: run.id,
        runGrant: token,
        leaseMs: this.leaseMs,
        snapshotDigest: run.scope_digest,
      };
    });
  }
  async load(token: string) {
    return this.db.transaction(async (transaction) => {
      const run = await this.grant(transaction, token);
      const scope = parseScope(run);
      return {
        runId: run.id,
        snapshotDigest: run.scope_digest,
        scope,
        items: scope.items.map((item) => {
          const configuration = configurationFor(run, item.caseId);
          const content = apiCaseContentSchema.parse(item.content);
          const auth: Record<
            string,
            { mode: 'token' | 'login'; cacheKey: string }
          > = {};
          const add = (
            phase: 'business' | 'cleanupHttp',
            stepId: string,
            step: ReturnType<typeof requestFor>,
          ) => {
            const selected = profileFor(configuration, step);
            if (
              selected.profile?.content.kind === 'authProfile' &&
              selected.cacheKey
            )
              auth[`${phase}:${stepId}`] = {
                mode: selected.profile.content.authentication.mode,
                cacheKey: selected.cacheKey,
              };
          };
          for (const step of content.steps) add('business', step.stepId, step);
          if (content.cleanup.mode !== 'none')
            for (const step of content.cleanup.steps)
              if (step.type === 'http')
                add('cleanupHttp', step.cleanupStepId, step.request);
          return {
            scopeItem: item,
            environment: publicEnvironment(configuration),
            auth,
          };
        }),
      };
    });
  }
  async heartbeat(token: string) {
    return this.db.transaction(async (transaction) => {
      const run = await this.grant(transaction, token);
      await transaction.query(
        "UPDATE app.api_worker_grants SET expires_at=clock_timestamp()+$2::integer*interval '1 millisecond' WHERE id=$1",
        [run.grant_id, this.leaseMs],
      );
      await transaction.query(
        'UPDATE app.api_worker_instances SET last_seen_at=clock_timestamp() WHERE id=$1',
        [run.worker_instance_id],
      );
      return { active: true, state: run.state };
    });
  }
  async beginCase(token: string, itemId: string) {
    return this.db.transaction(async (transaction) => {
      const run = await this.grant(transaction, token);
      const item = this.item(run, itemId);
      if (
        run.stop_requested_at ||
        run.state === 'stopping' ||
        !(await this.available(transaction, run))
      )
        return {
          begin: false,
          reason:
            run.stop_requested_at || run.state === 'stopping'
              ? 'stopped'
              : 'permission-lost',
        };
      try {
        await this.gateway.validateConfiguration(
          transaction,
          run.project_id,
          this.gateway.actionConfiguration(configurationFor(run, item.caseId)),
        );
      } catch (error: unknown) {
        if (!(error instanceof DomainError)) throw error;
        await transaction.query(
          "UPDATE app.runs SET state='stopping' WHERE id=$1",
          [run.id],
        );
        await this.event(transaction, run.id, 'run.environment-unavailable', {
          stopNewCases: true,
        });
        return { begin: false, reason: 'environment-unavailable' };
      }
      if (
        (
          await transaction.query(
            "SELECT 1 FROM app.run_items WHERE run_id=$1 AND ordinal<$2 AND state NOT IN ('completed','notExecuted') LIMIT 1",
            [run.id, item.ordinal],
          )
        ).rowCount
      )
        throw new DomainError(
          'BUSINESS_CONFLICT',
          '单轮必须顺序收尾后再开始下一用例。',
          409,
        );
      const current = (
        await transaction.query<{ state: string }>(
          'SELECT state FROM app.run_items WHERE id=$1 FOR UPDATE',
          [itemId],
        )
      ).rows[0];
      if (current?.state === 'running') return { begin: true, replayed: true };
      if (current?.state !== 'pending')
        throw new DomainError(
          'BUSINESS_CONFLICT',
          '此项已执行或已终止，不能重跑。',
          409,
        );
      await transaction.query(
        "UPDATE app.run_items SET state='running',started_at=clock_timestamp() WHERE id=$1",
        [itemId],
      );
      await transaction.query(
        'INSERT INTO app.api_case_facts(run_item_id,project_id,run_id) VALUES($1,$2,$3)',
        [itemId, run.project_id, run.id],
      );
      await this.event(transaction, run.id, 'case.started', {
        runItemId: itemId,
        ordinal: item.ordinal,
      });
      return { begin: true, replayed: false };
    });
  }
  private async attempts(
    transaction: SqlExecutor,
    itemId: string,
  ): Promise<AttemptRow[]> {
    return (
      await transaction.query<AttemptRow>(
        'SELECT * FROM app.api_step_attempts WHERE run_item_id=$1 ORDER BY created_at,id',
        [itemId],
      )
    ).rows;
  }
  private async ensureActiveItem(
    transaction: SqlExecutor,
    run: ExecutionRunRow,
    itemId: string,
  ) {
    const row = (
      await transaction.query<{ state: string }>(
        'SELECT state FROM app.run_items WHERE id=$1 AND run_id=$2 FOR UPDATE',
        [itemId, run.id],
      )
    ).rows[0];
    if (row?.state !== 'running')
      throw new DomainError('BUSINESS_CONFLICT', '此用例不是当前活动项。', 409);
  }
  private async cleanupAllowed(transaction: SqlExecutor, item: ScopeItem) {
    const content = apiCaseContentSchema.parse(item.content);
    if (content.cleanup.mode === 'none') return false;
    const attempts = await this.attempts(transaction, item.runItemId);
    const business = attempts.filter((entry) => entry.phase === 'business');
    if (business.some((entry) => entry.state === 'intent'))
      throw new DomainError(
        'BUSINESS_CONFLICT',
        '当前业务请求尚未收尾，不能先清理。',
        409,
      );
    const failed =
      business.some(
        (entry) =>
          entry.outcome === 'failed' ||
          entry.state === 'failed' ||
          entry.state === 'unknown',
      ) ||
      attempts.some(
        (entry) => entry.phase === 'auth' && entry.outcome === 'failed',
      );
    const allPassed = content.steps.every((step) =>
      business.some(
        (entry) => entry.step_id === step.stepId && entry.outcome === 'passed',
      ),
    );
    if (!failed && !allPassed)
      throw new DomainError(
        'BUSINESS_CONFLICT',
        '业务步骤尚未完成，不能提前清理。',
        409,
      );
    const assertionCount = business.reduce(
      (count, entry) =>
        count + z.array(z.unknown()).parse(entry.assertions_safe).length,
      0,
    );
    return (
      content.cleanup.mode === 'always' ||
      (allPassed && !failed && assertionCount > 0)
    );
  }
  private async insertLocal(
    transaction: SqlExecutor,
    run: GrantedRun,
    item: ScopeItem,
    phase: 'business' | 'cleanupHttp' | 'cleanupSql',
    stepId: string,
    code: string,
    reason: string,
    skipped = false,
  ) {
    const existing = (await this.attempts(transaction, item.runItemId)).find(
      (entry) => entry.phase === phase && entry.step_id === stepId,
    );
    if (existing) return existing;
    const id = randomUUID();
    const safeReason = String(
      redact(reason, await this.protection(transaction, item.runItemId)),
    );
    await transaction.query(
      `INSERT INTO app.api_step_attempts(id,project_id,run_id,run_item_id,phase,step_id,worker_instance_id,fence,request_digest,request_safe,state,outcome,reason,finished_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,clock_timestamp())`,
      [
        id,
        run.project_id,
        run.id,
        item.runItemId,
        phase,
        stepId,
        run.worker_instance_id,
        run.fence,
        hash(canonicalJson({ code, reason: safeReason })),
        JSON.stringify({ code }),
        skipped ? 'skipped' : 'failed',
        skipped ? null : 'failed',
        safeReason,
      ],
    );
    await this.event(transaction, run.id, 'step.not-sent', {
      runItemId: item.runItemId,
      phase,
      stepId,
      code,
      skipped,
    });
    return (await this.attempts(transaction, item.runItemId)).find(
      (entry) => entry.id === id,
    );
  }
  async localFailure(token: string, raw: unknown) {
    const input = localStepFailureInputSchema.parse(raw);
    return this.db.transaction(async (transaction) => {
      const run = await this.grant(transaction, token);
      const item = this.item(run, input.runItemId);
      await this.ensureActiveItem(transaction, run, item.runItemId);
      const content = apiCaseContentSchema.parse(item.content);
      if (input.phase === 'business')
        requestFor(content, 'business', input.stepId);
      else if (
        content.cleanup.mode === 'none' ||
        !content.cleanup.steps.some(
          (step) =>
            step.cleanupStepId === input.stepId &&
            (step.type === 'sql') === (input.phase === 'cleanupSql'),
        )
      )
        throw new DomainError('NOT_FOUND', '没有该清理步骤。', 404);
      await this.insertLocal(
        transaction,
        run,
        item,
        input.phase,
        input.stepId,
        input.code,
        input.reason,
        input.skipped,
      );
      return { recorded: true };
    });
  }
  private requestFiles() {
    if (!this.multipartFiles)
      throw new DomainError(
        'DEPENDENCY_UNAVAILABLE',
        '本实例未开放请求文件读取，未发送。',
        503,
      );
    return this.multipartFiles;
  }

  async multipartFile(token: string, raw: unknown) {
    const input = multipartFileInputSchema.parse(raw);
    const files = this.requestFiles();
    const authorizeFile = () =>
      this.db.transaction(async (transaction) => {
        const run = await this.grant(transaction, token);
        const attempt = (
          await transaction.query<{
            run_item_id: string;
            phase: 'business' | 'cleanupHttp';
            step_id: string;
          }>(
            `SELECT run_item_id,phase,step_id FROM app.api_step_attempts
             WHERE id=$1 AND run_id=$2 AND worker_instance_id=$3 AND fence=$4
               AND state='intent' AND phase IN ('business','cleanupHttp')`,
            [input.intentId, run.id, run.worker_instance_id, run.fence],
          )
        ).rows[0];
        if (!attempt)
          throw new DomainError('NOT_FOUND', '原步骤未授权读取请求文件。', 404);
        const item = this.item(run, attempt.run_item_id);
        await this.ensureActiveItem(transaction, run, item.runItemId);
        if (!(await this.available(transaction, run)))
          throw new DomainError('FORBIDDEN', '原步骤的发起权限已失效。', 403);
        const { body } = requestFor(
          apiCaseContentSchema.parse(item.content),
          attempt.phase,
          attempt.step_id,
        );
        if (
          body.format !== 'multipart' ||
          !body.parts.some(
            (part) =>
              part.kind === 'file' &&
              part.fileResourceId === input.fileResourceId,
          )
        )
          throw new DomainError('NOT_FOUND', '原步骤未授权读取请求文件。', 404);
        return files.describe(
          transaction,
          runActor(run),
          run.project_id,
          input.fileResourceId,
        );
      });
    const file = await authorizeFile();
    const bytes = await files.read(file);
    const current = await authorizeFile();
    if (
      current.storageKey !== file.storageKey ||
      current.attachment.sha256 !== file.attachment.sha256 ||
      current.attachment.bytes !== file.attachment.bytes
    )
      throw new DomainError(
        'FILE_NOT_READY',
        '原请求文件已变化，未发送。',
        422,
      );
    return bytes;
  }

  async authorize(
    token: string,
    raw: unknown,
  ): Promise<SendPermit | { send: false; state: string; reason?: string }> {
    const input = workerActionInputSchema.parse(raw);
    return this.db.transaction(async (transaction) => {
      const run = await this.grant(transaction, token);
      const item = this.item(run, input.runItemId);
      await this.ensureActiveItem(transaction, run, item.runItemId);
      const requestDigest = this.secrets.fingerprint(
        canonicalJson(
          input.phase === 'auth'
            ? {
                runItemId: input.runItemId,
                phase: input.phase,
                stepId: input.stepId,
              }
            : input,
        ),
        {
          ownerScope: 'project',
          ownerId: item.runItemId,
          purpose: 'api-intent',
        },
      );
      const attempts = await this.attempts(transaction, item.runItemId);
      const prior = attempts.find(
        (entry) =>
          entry.phase === input.phase && entry.step_id === input.stepId,
      );
      if (prior) {
        if (prior.request_digest !== requestDigest)
          throw new DomainError(
            'IDEMPOTENCY_CONFLICT',
            '同一步发送意图内容改变，禁止再次发送。',
            409,
          );
        return { send: false, state: prior.state };
      }
      if (
        await hasDispatchFence(
          transaction,
          'api',
          run.id,
          item.runItemId,
          input.phase,
          input.stepId,
        )
      )
        throw new DomainError(
          'OPERATION_RESULT_UNKNOWN',
          '此步骤已有不可重发的外部发送控制记录；备份缺少原回执，未授予新发送许可。',
          409,
        );
      const configuration = configurationFor(run, item.caseId);
      const content = apiCaseContentSchema.parse(item.content);
      const relatedPhase =
        input.phase === 'auth' ? input.forPhase : input.phase;
      const relatedId = input.phase === 'auth' ? input.forStepId : input.stepId;
      if (!relatedPhase || !relatedId)
        throw new DomainError(
          'VALIDATION_ERROR',
          '认证必须绑定本次明确的请求步骤。',
          400,
        );
      const isCleanup =
        relatedPhase === 'cleanupHttp' || relatedPhase === 'cleanupSql';
      try {
        const previouslyLost = (
          await transaction.query(
            'SELECT 1 FROM app.api_case_facts WHERE run_item_id=$1 AND permission_lost_at IS NOT NULL',
            [item.runItemId],
          )
        ).rowCount;
        const authorizationLost =
          Boolean(previouslyLost) || !(await this.available(transaction, run));
        if (authorizationLost) {
          await transaction.query(
            'UPDATE app.api_case_facts SET permission_lost_at=COALESCE(permission_lost_at,clock_timestamp()) WHERE run_item_id=$1',
            [item.runItemId],
          );
          await transaction.query(
            "UPDATE app.runs SET state='stopping' WHERE id=$1",
            [run.id],
          );
          await this.event(transaction, run.id, 'run.authorization-lost', {
            runItemId: item.runItemId,
            stopNewBusiness: true,
            cleanupRemainsPolicyBound: true,
          });
          const debugScope = parseScope(run);
          if (
            !isCleanup ||
            (debugScope.schemaVersion === 'ath.debug-execution-scope.v1' &&
              debugScope.cleanupApprovalSnapshotId === null)
          )
            throw new DomainError(
              'FORBIDDEN',
              isCleanup
                ? '发起人失权，未审调试清理不获例外执行许可。'
                : '发起人失权，停止当前用例尚未发送的业务步骤。',
              403,
            );
        }
        if (isCleanup && !(await this.cleanupAllowed(transaction, item)))
          return {
            send: false,
            state: 'skipped',
            reason: '本轮原清理策略不适用。',
          };
        if (relatedPhase === 'business') {
          const index = content.steps.findIndex(
            (step) => step.stepId === relatedId,
          );
          if (
            index < 0 ||
            content.steps
              .slice(0, index)
              .some(
                (step) =>
                  !attempts.some(
                    (entry) =>
                      entry.phase === 'business' &&
                      entry.step_id === step.stepId &&
                      entry.outcome === 'passed',
                  ),
              )
          )
            throw new DomainError(
              'PRECONDITIONS_MISSING',
              '前一步未按已审预期完成，禁止后续业务请求。',
              422,
            );
        }
        const cleanupStep =
          isCleanup && content.cleanup.mode !== 'none'
            ? content.cleanup.steps.find(
                (step) => step.cleanupStepId === relatedId,
              )
            : undefined;
        const currentRequest =
          relatedPhase === 'business' || relatedPhase === 'cleanupHttp'
            ? requestFor(content, relatedPhase, relatedId)
            : undefined;
        const actionConfiguration = this.gateway.actionConfiguration(
          configuration,
          currentRequest,
          cleanupStep?.type === 'sql' ? cleanupStep.connectionId : undefined,
        );
        const requestReferences = apiRequestVariableReferences(
          currentRequest,
        ).filter((reference) => /^(env|case|extract)\./.test(reference));
        const requiredReferences = [
          ...requestReferences,
          ...(cleanupStep?.type === 'sql'
            ? cleanupStep.parameters.map((parameter) => parameter.valueRef)
            : []),
          ...(cleanupStep?.requiredTargets ?? []),
        ];
        const { variables, fromMultipartFile } = await this.variables(
          transaction,
          item.runItemId,
          input.variables,
          run,
          configuration,
          requiredReferences,
        );
        await this.gateway.validateConfiguration(
          transaction,
          run.project_id,
          actionConfiguration,
        );
        if (
          isCleanup &&
          (!cleanupStep ||
            cleanupStep.requiredTargets.some(
              (target) =>
                !nonEmpty(
                  readPath(
                    contextVariables(
                      publicEnvironment(configuration),
                      variables,
                    ),
                    target,
                  ),
                ),
            ))
        ) {
          if (input.phase !== 'auth')
            await this.insertLocal(
              transaction,
              run,
              item,
              input.phase === 'cleanupSql' ? 'cleanupSql' : 'cleanupHttp',
              input.stepId,
              'MISSING_CLEANUP_TARGET',
              '清理目标为空或缺失，未发送。',
              true,
            );
          return {
            send: false,
            state: 'skipped',
            reason: '清理目标为空或缺失，未发送。',
          };
        }
        const variableContext = contextVariables(
          publicEnvironment(configuration),
          variables,
        );
        if (
          requestReferences.some(
            (reference) => readPath(variableContext, reference) === undefined,
          )
        )
          throw new DomainError(
            'PRECONDITIONS_MISSING',
            '本步骤引用的变量未取得，未发送登录或业务请求。',
            422,
          );
        let transport: WorkerTransport;
        let runtimeAssertions: SendPermit['assertions'];
        let authExtractor: SendPermit['authExtractor'];
        if (input.phase === 'auth') {
          if (relatedPhase !== 'business' && relatedPhase !== 'cleanupHttp')
            throw new DomainError(
              'VALIDATION_ERROR',
              'SQL清理不使用HTTP登录步骤。',
              400,
            );
          const step = requestFor(content, relatedPhase, relatedId);
          if (step.body.format === 'multipart') {
            for (const part of step.body.parts)
              if (part.kind === 'file')
                await this.requestFiles().describe(
                  transaction,
                  runActor(run),
                  run.project_id,
                  part.fileResourceId,
                );
          }
          const selected = profileFor(configuration, step);
          if (!selected.cacheKey || selected.cacheKey !== input.stepId)
            throw new DomainError(
              'VALIDATION_ERROR',
              '认证标识与固定用途不一致。',
              400,
            );
          const login = await this.gateway.login(
            configuration,
            step,
            transaction,
          );
          transport = login.transport;
          authExtractor = login.extractor;
        } else if (input.phase === 'cleanupSql') {
          if (!cleanupStep || cleanupStep.type !== 'sql')
            throw new DomainError('NOT_FOUND', '没有该SQL清理步骤。', 404);
          transport = await this.gateway.sql(
            actionConfiguration,
            cleanupStep,
            variables,
            transaction,
          );
        } else {
          const step = requestFor(content, input.phase, input.stepId);
          const selected = profileFor(configuration, step);
          let authToken: string | undefined;
          if (
            selected.profile?.content.kind === 'authProfile' &&
            selected.profile.content.authentication.mode === 'login' &&
            selected.cacheKey
          ) {
            const cached = (
              await transaction.query<{ secret_ref: string }>(
                'SELECT secret_ref FROM app.api_auth_tokens WHERE run_item_id=$1 AND cache_key=$2 AND revoked_at IS NULL',
                [item.runItemId, selected.cacheKey],
              )
            ).rows[0];
            if (!cached)
              throw new DomainError(
                'PRECONDITIONS_MISSING',
                '当前用例尚未获得本用途登录结果，不自动重登录。',
                422,
              );
            authToken = await this.secrets.resolveInTransaction(
              transaction,
              cached.secret_ref,
              authBinding(item.runItemId),
            );
          }
          transport = await this.gateway.http(
            configuration,
            step,
            variables,
            authToken,
            transaction,
            async (fileId) =>
              (
                await this.requestFiles().describe(
                  transaction,
                  runActor(run),
                  run.project_id,
                  fileId,
                )
              ).attachment,
          );
          runtimeAssertions = await this.gateway.runtimeAssertions(
            configuration,
            step,
            variables,
            authToken,
            transaction,
          );
        }
        await this.remember(
          transaction,
          item.runItemId,
          await this.gateway.protectedValues(actionConfiguration, transaction),
        );
        const values = await this.protection(transaction, item.runItemId);
        const intentId = randomUUID();
        const responseMetadataOnly =
          fromMultipartFile ||
          (transport.type === 'http' &&
            transport.multipart?.parts.some((part) => part.kind === 'file') ===
              true);
        let requestSafe: JsonValue;
        if (fromMultipartFile) {
          requestSafe = {
            type: transport.type,
            ...(transport.type === 'http' ? { method: transport.method } : {}),
            responseMetadataOnly: true,
            note: '请求使用来自文件上传响应的受保护提取值，详情已省略。',
          };
        } else if (transport.type === 'http') {
          let body: unknown = transport.body;
          try {
            if (typeof body === 'string') body = JSON.parse(body) as unknown;
          } catch {}
          requestSafe = redact(
            {
              type: transport.type,
              url: transport.url,
              method: transport.method,
              headers: transport.multipart
                ? {
                    ...transport.headers,
                    'content-type': 'multipart/form-data',
                  }
                : transport.headers,
              body: transport.multipart
                ? {
                    format: 'multipart',
                    partCount: transport.multipart.parts.length,
                    fileCount: transport.multipart.parts.filter(
                      (part) => part.kind === 'file',
                    ).length,
                  }
                : body,
              ...(responseMetadataOnly ? { responseMetadataOnly: true } : {}),
            },
            values,
          );
        } else
          requestSafe = redact(
            {
              type: 'sql',
              driver: transport.driver,
              statement: transport.statement,
              parameters: transport.values,
            },
            values,
          );
        await transaction.query(
          `INSERT INTO app.api_step_attempts(id,project_id,run_id,run_item_id,phase,step_id,worker_instance_id,fence,request_digest,request_safe,send_intent_at,state)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,clock_timestamp(),'intent')`,
          [
            intentId,
            run.project_id,
            run.id,
            item.runItemId,
            input.phase,
            input.stepId,
            run.worker_instance_id,
            run.fence,
            requestDigest,
            JSON.stringify(requestSafe),
          ],
        );
        await recordDispatchFence(transaction, {
          id: intentId,
          namespace: 'api',
          actorId: run.created_by,
          projectId: run.project_id,
          sourceId: run.id,
          runItemId: item.runItemId,
          phase: input.phase,
          stepId: input.stepId,
          requestHash: requestDigest,
          metadata: { planId: run.plan_id ?? null, caseId: item.caseId },
        });
        await this.event(transaction, run.id, 'step.send-intent', {
          intentId,
          runItemId: item.runItemId,
          phase: input.phase,
          stepId: input.stepId,
        });
        return {
          send: true,
          intentId,
          transport,
          protectedValues: values,
          ...(responseMetadataOnly ? { responseMetadataOnly: true } : {}),
          ...(runtimeAssertions ? { assertions: runtimeAssertions } : {}),
          ...(authExtractor ? { authExtractor } : {}),
        };
      } catch (error: unknown) {
        if (!(error instanceof DomainError)) throw error;
        if (input.phase !== 'auth')
          await this.insertLocal(
            transaction,
            run,
            item,
            input.phase,
            input.stepId,
            error.code,
            error.message,
            isCleanup,
          );
        return {
          send: false,
          state: isCleanup ? 'skipped' : 'failed',
          reason: error.message,
        };
      }
    });
  }
  async completeAttempt(token: string, raw: unknown) {
    const input = attemptReceiptInputSchema.parse(raw);
    return this.db.transaction(async (transaction) => {
      const run = await this.grant(transaction, token);
      const attempt = (
        await transaction.query<AttemptRow & { run_item_id: string }>(
          'SELECT * FROM app.api_step_attempts WHERE id=$1 AND run_id=$2 FOR UPDATE',
          [input.intentId, run.id],
        )
      ).rows[0];
      if (!attempt)
        throw new DomainError('NOT_FOUND', '没有此授权发送意图。', 404);
      const item = this.item(run, attempt.run_item_id);
      const configuration = configurationFor(run, item.caseId);
      const receiptDigest = this.secrets.fingerprint(canonicalJson(input), {
        ownerScope: 'project',
        ownerId: item.runItemId,
        purpose: 'api-receipt',
      });
      if (attempt.receipt_digest) {
        if (attempt.receipt_digest !== receiptDigest)
          throw new DomainError(
            'IDEMPOTENCY_CONFLICT',
            '同一响应回执内容改变，原始事实不可覆盖。',
            409,
          );
        return {
          recorded: true,
          replayed: true,
          extractions: z
            .record(z.string(), z.json())
            .parse(attempt.extractions_safe),
        };
      }
      if (attempt.state !== 'intent')
        throw new DomainError(
          'OPERATION_RESULT_UNKNOWN',
          '发送结果已进入未知恢复状态，不接受覆盖原事实。',
          409,
        );
      let passed =
        input.passed &&
        input.response.errorCode === null &&
        input.assertions.every((assertion) => assertion.passed) &&
        (attempt.phase === 'cleanupSql' || input.response.status !== null);
      const content = apiCaseContentSchema.parse(item.content);
      if (attempt.phase === 'auth') {
        passed =
          passed &&
          input.response.status !== null &&
          input.response.status >= 200 &&
          input.response.status < 300 &&
          Boolean(input.authToken);
        if (passed && input.authToken) {
          await this.remember(transaction, item.runItemId, [input.authToken]);
          const selectedStep = [
            ...content.steps,
            ...(content.cleanup.mode === 'none'
              ? []
              : content.cleanup.steps.flatMap((step) =>
                  step.type === 'http' ? [step.request] : [],
                )),
          ]
            .map((step) => ({
              step,
              selected: profileFor(configuration, step),
            }))
            .find((entry) => entry.selected.cacheKey === attempt.step_id);
          if (!selectedStep?.selected.profile)
            throw new DomainError(
              'BUSINESS_CONFLICT',
              '登录回执不属于已审认证配置。',
              409,
            );
          const reference = await this.secrets.store(
            transaction,
            input.authToken,
            authBinding(item.runItemId),
          );
          await transaction.query(
            'INSERT INTO app.api_auth_tokens(run_item_id,cache_key,profile_id,secret_ref) VALUES($1,$2,$3,$4)',
            [
              item.runItemId,
              attempt.step_id,
              selectedStep.selected.profile.id,
              reference,
            ],
          );
        }
      } else if (input.authToken !== undefined)
        throw new DomainError(
          'VALIDATION_ERROR',
          '普通响应不得使用秘密登录通道。',
          400,
        );
      // The send gate retained exactly this action's protected values before dispatch.
      let protectedValues = await this.protection(transaction, item.runItemId);
      const extractions: Record<string, JsonValue> = {};
      const requestProof = attempt.request_safe;
      const responseMetadataOnly =
        requestProof !== null &&
        typeof requestProof === 'object' &&
        'responseMetadataOnly' in requestProof &&
        requestProof.responseMetadataOnly === true;
      const step =
        attempt.phase === 'business' || attempt.phase === 'cleanupHttp'
          ? requestFor(content, attempt.phase, attempt.step_id)
          : null;
      for (const [name, value] of Object.entries(input.extractions)) {
        const extractor = step?.extractors.find((entry) => entry.name === name);
        if (!extractor)
          throw new DomainError(
            'VALIDATION_ERROR',
            '回执含未声明提取变量。',
            400,
          );
        if (extractor.sensitive && !validSensitiveExtraction(value))
          throw new DomainError(
            'VALIDATION_ERROR',
            '敏感提取值须为非空文本，回执未受理。',
            422,
          );
        const protectedExtraction = redactExtraction(
          value,
          protectedValues,
          `${name}.${extractor.path ?? ''}`,
          extractor.sensitive,
        );
        const safe = responseMetadataOnly
          ? '[REDACTED]'
          : protectedExtraction.value;
        if (responseMetadataOnly || protectedExtraction.protectedPaths.length) {
          if (!responseMetadataOnly)
            await this.remember(
              transaction,
              item.runItemId,
              protectedExtraction.protectedValues(),
            );
          const reference = await this.secrets.store(
            transaction,
            JSON.stringify({
              value,
              sourceIntentId: input.intentId,
              protectedPaths: responseMetadataOnly
                ? ['']
                : protectedExtraction.protectedPaths,
              ...(responseMetadataOnly ? { fromMultipartFile: true } : {}),
            }),
            taintedBinding(item.runItemId),
          );
          const previous = (
            await transaction.query<{ secret_ref: string }>(
              'SELECT secret_ref FROM app.api_tainted_variables WHERE run_item_id=$1 AND name=$2',
              [item.runItemId, name],
            )
          ).rows[0];
          if (previous)
            await this.secrets.revoke(
              transaction,
              previous.secret_ref,
              taintedBinding(item.runItemId),
            );
          await transaction.query(
            'INSERT INTO app.api_tainted_variables(run_item_id,name,secret_ref) VALUES($1,$2,$3) ON CONFLICT(run_item_id,name) DO UPDATE SET secret_ref=EXCLUDED.secret_ref',
            [item.runItemId, name, reference],
          );
        } else {
          const previous = (
            await transaction.query<{ secret_ref: string }>(
              'SELECT secret_ref FROM app.api_tainted_variables WHERE run_item_id=$1 AND name=$2',
              [item.runItemId, name],
            )
          ).rows[0];
          if (previous) {
            await this.secrets.revoke(
              transaction,
              previous.secret_ref,
              taintedBinding(item.runItemId),
            );
            await transaction.query(
              'DELETE FROM app.api_tainted_variables WHERE run_item_id=$1 AND name=$2',
              [item.runItemId, name],
            );
          }
        }
        extractions[name] = safe;
      }
      protectedValues = await this.protection(transaction, item.runItemId);
      let response = redactResponse(input.response, protectedValues);
      if (attempt.phase === 'auth')
        response = {
          ...response,
          headers: {},
          body: '[authentication response withheld]',
        };
      const notDispatched =
        response.status === null &&
        response.errorCode?.startsWith('REQUEST_NOT_DISPATCHED_') === true;
      if (responseMetadataOnly)
        response = {
          ...response,
          headers: {},
          body: notDispatched
            ? { dispatchCertainty: 'notDispatched' }
            : '[multipart file response withheld]',
        };
      const reason = responseMetadataOnly
        ? notDispatched
          ? '本步未发送，被测目标未收到此请求。'
          : passed
            ? '响应已用于校验，详情已省略。'
            : '本步未通过，受保护响应详情已省略。'
        : String(redact(input.reason, protectedValues));
      const assertions = responseMetadataOnly
        ? input.assertions.map(({ passed }) => ({
            passed,
            message: passed ? '断言通过' : '断言未通过',
          }))
        : redact(input.assertions, protectedValues);
      await transaction.query(
        `UPDATE app.api_step_attempts SET state='completed',outcome=$2,side_effect_certainty=$3,response_safe=$4,receipt_digest=$5,
        extractions_safe=$6,assertions_safe=$7,reason=$8,finished_at=clock_timestamp() WHERE id=$1`,
        [
          input.intentId,
          passed ? 'passed' : 'failed',
          input.sideEffectCertainty,
          JSON.stringify(response),
          receiptDigest,
          JSON.stringify(extractions),
          JSON.stringify(assertions),
          reason,
        ],
      );
      await this.event(transaction, run.id, 'step.response-recorded', {
        intentId: input.intentId,
        phase: attempt.phase,
        passed,
        sideEffectCertainty: input.sideEffectCertainty,
      });
      return { recorded: true, replayed: false, extractions, protectedValues };
    });
  }
  private async revokeItemSecrets(transaction: SqlExecutor, itemId: string) {
    for (const [table, binding] of [
      ['api_auth_tokens', authBinding(itemId)],
      ['api_protected_values', protectedBinding(itemId)],
      ['api_tainted_variables', taintedBinding(itemId)],
    ] as const) {
      const rows = await transaction.query<{ secret_ref: string }>(
        `SELECT secret_ref FROM app.${table} WHERE run_item_id=$1`,
        [itemId],
      );
      for (const row of rows.rows)
        await this.secrets.revoke(transaction, row.secret_ref, binding);
    }
    await transaction.query(
      'UPDATE app.api_auth_tokens SET revoked_at=clock_timestamp() WHERE run_item_id=$1',
      [itemId],
    );
  }
  async completeCase(token: string, raw: unknown) {
    const input = apiCaseCompletionInputSchema.parse(raw);
    return this.db.transaction(async (transaction) => {
      const run = await this.grant(transaction, token);
      const item = this.item(run, input.runItemId);
      const completionDigest = this.secrets.fingerprint(canonicalJson(input), {
        ownerScope: 'project',
        ownerId: item.runItemId,
        purpose: 'api-case-completion',
      });
      const previous = (
        await transaction.query<{
          completion_digest: string | null;
          original_outcome: string | null;
          cleanup_state: string;
        }>(
          'SELECT completion_digest,original_outcome,cleanup_state FROM app.api_case_facts WHERE run_item_id=$1',
          [item.runItemId],
        )
      ).rows[0];
      if (previous?.completion_digest) {
        if (previous.completion_digest !== completionDigest)
          throw new DomainError(
            'IDEMPOTENCY_CONFLICT',
            '原始用例完成回执不可覆盖。',
            409,
          );
        return {
          recorded: true,
          replayed: true,
          outcome: previous.original_outcome,
          cleanupState: previous.cleanup_state,
        };
      }
      await this.ensureActiveItem(transaction, run, item.runItemId);
      const attempts = await this.attempts(transaction, item.runItemId);
      if (attempts.some((attempt) => attempt.state === 'intent'))
        throw new DomainError(
          'BUSINESS_CONFLICT',
          '仍有无回执发送意图，不得伪造用例完成。',
          409,
        );
      const content = apiCaseContentSchema.parse(item.content);
      const business = attempts.filter(
        (attempt) => attempt.phase === 'business',
      );
      const allPassed = content.steps.every((step) =>
        business.some(
          (attempt) =>
            attempt.step_id === step.stepId && attempt.outcome === 'passed',
        ),
      );
      const assertionCount = business.reduce(
        (count, attempt) =>
          count + z.array(z.unknown()).parse(attempt.assertions_safe).length,
        0,
      );
      const outcome =
        allPassed && assertionCount > 0 && input.outcome === 'passed'
          ? 'passed'
          : 'failed';
      const unjudged =
        this.isDraftDebug(run) && allPassed && assertionCount === 0;
      const archivedOutcome = unjudged ? null : outcome;
      const cleanup = attempts.filter(
        (attempt) =>
          attempt.phase === 'cleanupHttp' || attempt.phase === 'cleanupSql',
      );
      const cleanupState =
        content.cleanup.mode === 'none'
          ? 'notConfigured'
          : content.cleanup.mode === 'onSuccess' && outcome !== 'passed'
            ? 'skipped'
            : cleanup.some((attempt) => attempt.state === 'unknown')
              ? 'interrupted'
              : cleanup.some(
                    (attempt) =>
                      attempt.outcome === 'failed' ||
                      attempt.state === 'failed',
                  )
                ? 'failed'
                : cleanup.some((attempt) => attempt.state === 'skipped')
                  ? 'skipped'
                  : cleanup.length === content.cleanup.steps.length &&
                      cleanup.every((attempt) => attempt.outcome === 'passed')
                    ? 'succeeded'
                    : 'interrupted';
      const sideEffect = attempts.some(
        (attempt) => attempt.side_effect_certainty === 'unknown',
      )
        ? 'unknown'
        : attempts.some((attempt) => attempt.send_intent_at !== null)
          ? 'known'
          : 'notApplicable';
      const values = await this.protection(transaction, item.runItemId);
      const reason = String(
        redact(
          assertionCount === 0 && allPassed
            ? unjudged
              ? '响应已返回，未配置业务断言，本轮调试未作通过/失败判断。'
              : '缺少可执行断言，不能把请求完成当作业务通过。'
            : input.reason,
          values,
        ),
      );
      const facts = await transaction.query<{ started_at: Date }>(
        'SELECT started_at FROM app.api_case_facts WHERE run_item_id=$1',
        [item.runItemId],
      );
      const result = resultItemSchema.parse({
        runItemId: item.runItemId,
        localResultId: `api-${item.runItemId}`,
        originalOutcome: outcome,
        actualObservations: JSON.stringify({
          redactionVersion: 'ath.api-redaction.v1',
          recordedStepCount: attempts.length,
          summaryItemLimit: 50,
          fullSafeFactsPath: `/api/v1/projects/${run.project_id}/api-executions/${run.id}/events`,
          steps: attempts.slice(0, 50).map((attempt) => ({
            intentId: attempt.id,
            phase: attempt.phase,
            stepId: attempt.step_id,
            outcome: attempt.outcome,
            state: attempt.state,
            reason: attempt.reason.slice(0, 300),
          })),
          cleanupState,
        }),
        actualActions: attempts
          .filter((attempt) => attempt.send_intent_at !== null)
          .map((attempt) => `${attempt.phase}:${attempt.step_id}`),
        reason,
        sideEffectCertainty: sideEffect,
        evidenceRefs: [],
        startedAt: facts.rows[0]?.started_at.toISOString(),
        endedAt: new Date().toISOString(),
      });
      await this.archiveResult(transaction, run, item, result, archivedOutcome);
      await transaction.query(
        'UPDATE app.run_items SET cleanup_state=$2 WHERE id=$1',
        [item.runItemId, cleanupState],
      );
      await transaction.query(
        'UPDATE app.api_case_facts SET original_outcome=$2,cleanup_state=$3,side_effect_certainty=$4,reason=$5,completion_digest=$6,ended_at=clock_timestamp() WHERE run_item_id=$1',
        [
          item.runItemId,
          archivedOutcome,
          cleanupState,
          sideEffect,
          reason,
          completionDigest,
        ],
      );
      await this.event(transaction, run.id, 'case.completed', {
        runItemId: item.runItemId,
        outcome: archivedOutcome,
        cleanupState,
        sideEffectCertainty: sideEffect,
      });
      await this.revokeItemSecrets(transaction, item.runItemId);
      return { recorded: true, outcome: archivedOutcome, cleanupState };
    });
  }
  private async recordNotExecuted(
    transaction: SqlExecutor,
    run: ExecutionRunRow,
    item: ScopeItem,
    reason: string,
  ) {
    const result: ResultItem = {
      runItemId: item.runItemId,
      localResultId: `api-${item.runItemId}`,
      originalOutcome: 'notExecuted',
      actualObservations: '本项未取得业务发送许可。',
      reason,
      sideEffectCertainty: 'notApplicable',
      evidenceRefs: [],
    };
    await this.archiveResult(transaction, run, item, result);
    await transaction.query(
      "UPDATE app.run_items SET cleanup_state='skipped' WHERE id=$1 AND cleanup_state='pending'",
      [item.runItemId],
    );
  }
  async finish(token: string) {
    return this.db.transaction(async (transaction) => {
      const run = await this.grant(transaction, token);
      const scope = parseScope(run);
      if (
        (
          await transaction.query(
            "SELECT 1 FROM app.run_items WHERE run_id=$1 AND state='running' LIMIT 1",
            [run.id],
          )
        ).rowCount
      )
        throw new DomainError(
          'BUSINESS_CONFLICT',
          '当前用例/清理尚未收尾。',
          409,
        );
      for (const item of scope.items) {
        const row = (
          await transaction.query<{ state: string }>(
            'SELECT state FROM app.run_items WHERE id=$1',
            [item.runItemId],
          )
        ).rows[0];
        if (row?.state === 'pending')
          await this.recordNotExecuted(
            transaction,
            run,
            item,
            run.stop_requested_at
              ? '用户停止后续用例。'
              : '当前资格或执行条件变化，未继续后续用例。',
          );
      }
      const counts = await transaction.query<{ outcome: string }>(
        'SELECT outcome FROM app.run_items WHERE run_id=$1',
        [run.id],
      );
      const state = counts.rows.some((item) => item.outcome === 'notExecuted')
        ? 'terminated'
        : 'completed';
      const cleanup = await transaction.query<{ cleanup_state: string }>(
        'SELECT cleanup_state FROM app.run_items WHERE run_id=$1',
        [run.id],
      );
      const cleanupState = cleanup.rows.some(
        (item) => item.cleanup_state === 'interrupted',
      )
        ? 'interrupted'
        : cleanup.rows.some((item) => item.cleanup_state === 'failed')
          ? 'failed'
          : cleanup.rows.some((item) => item.cleanup_state === 'skipped')
            ? 'skipped'
            : cleanup.rows.some((item) => item.cleanup_state === 'succeeded')
              ? 'succeeded'
              : 'notConfigured';
      await transaction.query(
        'UPDATE app.runs SET state=$2,cleanup_state=$3,ended_at=clock_timestamp(),completed_items=$4,row_version=row_version+1 WHERE id=$1',
        [run.id, state, cleanupState, counts.rows.length],
      );
      await transaction.query(
        'UPDATE app.api_worker_grants SET revoked_at=clock_timestamp() WHERE id=$1',
        [run.grant_id],
      );
      const report = await this.report(transaction, run, 'api-run-finished');
      await this.event(transaction, run.id, 'run.finished', {
        state,
        cleanupState,
        reportId: report.reportId,
      });
      return { state, reportId: report.reportId };
    });
  }
  async stopReceipt(
    actor: ActorContext,
    projectId: string,
    runId: string,
    commandId: string,
  ) {
    return this.db.transaction(async (tx) => {
      await requireProject(tx, actor, projectId, 'project.read');
      if (
        !(
          await tx.query(
            "SELECT 1 FROM app.runs WHERE project_id=$1 AND id=$2 AND kind='API'",
            [projectId, runId],
          )
        ).rowCount
      )
        throw new DomainError('NOT_FOUND', '没有此接口运行。', 404);
      const requestHash = operationRequestHash(
        { runId, ...apiStopInputSchema.parse({ commandId }) },
        projectId,
      );
      const row = (
        await tx.query<{ status: string; response: unknown }>(
          `SELECT status,response FROM app.commands WHERE actor_id=$1 AND project_id=$2 AND operation='api-runs.stop' AND key=$3 AND request_hash=$4`,
          [actor.userId, projectId, commandId, requestHash],
        )
      ).rows[0];
      if (!row)
        throw new DomainError(
          'NOT_FOUND',
          '尚未取得本轮原停止回执，保持原标识查询，不自动重复停止。',
          404,
        );
      return apiStopStatusSchema.parse({
        commandId,
        runId,
        status: row.status,
        response: row.response,
      });
    });
  }
  async stop(
    actor: ActorContext,
    projectId: string,
    runId: string,
    raw: unknown,
  ) {
    const input = apiStopInputSchema.parse(raw);
    return this.operations.execute(
      actor,
      'api-runs.stop',
      input.commandId,
      { runId, ...input },
      async (transaction) => {
        await requireProject(transaction, actor, projectId, 'runs.organize');
      },
      async (transaction) => {
        const run = (
          await transaction.query<ExecutionRunRow>(
            `${runSelect} WHERE r.project_id=$1 AND r.id=$2 FOR UPDATE OF r`,
            [projectId, runId],
          )
        ).rows[0];
        if (!run || run.kind !== 'API')
          throw new DomainError('NOT_FOUND', '没有此平台接口运行。', 404);
        if (terminal.has(run.state)) return { state: run.state };
        await transaction.query(
          "UPDATE app.runs SET state='stopping',stop_requested_at=COALESCE(stop_requested_at,clock_timestamp()),row_version=row_version+1 WHERE id=$1",
          [runId],
        );
        await this.event(transaction, runId, 'run.stop-requested', {
          mode: 'after-current-case-and-cleanup',
        });
        const active = (
          await transaction.query(
            "SELECT 1 FROM app.run_items WHERE run_id=$1 AND state='running' LIMIT 1",
            [runId],
          )
        ).rowCount;
        if (!active) {
          for (const item of parseScope(run).items) {
            const state = (
              await transaction.query<{ state: string }>(
                'SELECT state FROM app.run_items WHERE id=$1',
                [item.runItemId],
              )
            ).rows[0]?.state;
            if (state === 'pending')
              await this.recordNotExecuted(
                transaction,
                run,
                item,
                '用户停止后续用例。',
              );
          }
          await transaction.query(
            "UPDATE app.runs SET state='terminated',ended_at=clock_timestamp() WHERE id=$1",
            [runId],
          );
          await transaction.query(
            'UPDATE app.api_worker_grants SET revoked_at=clock_timestamp() WHERE run_id=$1',
            [runId],
          );
          await this.report(
            transaction,
            run,
            'api-stop-before-next-case',
            actor,
          );
          return { state: 'terminated' };
        }
        return { state: 'stopping' };
      },
      projectId,
    );
  }
  async reconcileExpired() {
    return this.db.transaction(async (transaction) => {
      const abandoned = await transaction.query<
        ExecutionRunRow & { grant_id: string }
      >(`SELECT r.*,COALESCE(r.origin_key_id,q.origin_key_id) origin_key_id,g.id grant_id FROM app.runs r
        LEFT JOIN app.api_execution_requests q ON q.run_id=r.id JOIN app.api_worker_grants g ON g.run_id=r.id
        WHERE g.revoked_at IS NULL AND g.expires_at<=clock_timestamp() AND r.state IN ('prepared','running','stopping') FOR UPDATE OF r,g SKIP LOCKED`);
      for (const run of abandoned.rows) {
        await transaction.query(
          'UPDATE app.api_worker_grants SET revoked_at=clock_timestamp() WHERE id=$1',
          [run.grant_id],
        );
        await transaction.query(
          "UPDATE app.api_step_attempts SET state='unknown',outcome='failed',side_effect_certainty='unknown',reason='worker ownership lost after send intent; never resend' WHERE run_id=$1 AND state='intent'",
          [run.id],
        );
        await transaction.query(
          "UPDATE app.runs SET state='recoveryRequired',row_version=row_version+1 WHERE id=$1",
          [run.id],
        );
        await this.event(transaction, run.id, 'run.recovery-required', {
          reason: 'worker-lease-expired',
          automaticReplay: false,
        });
        let needsRecovery = false;
        let incompleteValidation = false;
        for (const item of parseScope(run).items) {
          const state = (
            await transaction.query<{ state: string }>(
              'SELECT state FROM app.run_items WHERE id=$1',
              [item.runItemId],
            )
          ).rows[0]?.state;
          if (state === 'pending') {
            await this.recordNotExecuted(
              transaction,
              run,
              item,
              'worker中断后本轮不再启动此项。',
            );
            continue;
          }
          if (state !== 'running') continue;
          const attempts = await this.attempts(transaction, item.runItemId);
          const content = apiCaseContentSchema.parse(item.content);
          const summary = summarize(content, attempts);
          const unjudged =
            this.isDraftDebug(run) &&
            summary.allPassed &&
            summary.assertionCount === 0;
          needsRecovery ||= summary.unknown;
          incompleteValidation ||=
            (!summary.businessPassed && !unjudged) ||
            summary.cleanupState === 'interrupted';
          const result: ResultItem = {
            runItemId: item.runItemId,
            localResultId: `api-${item.runItemId}`,
            originalOutcome: summary.businessPassed ? 'passed' : 'failed',
            actualObservations: JSON.stringify({
              workerOwnershipUncertain: true,
              automaticReplay: false,
              pureProjectionFromPersistedReceipts: true,
              unknownIntentIds: attempts
                .filter(
                  (attempt) =>
                    attempt.state === 'unknown' ||
                    attempt.side_effect_certainty === 'unknown',
                )
                .map((attempt) => attempt.id),
              cleanupState: summary.cleanupState,
            }),
            reason: summary.businessPassed
              ? '已持久业务断言通过；清理及worker中断状态独立核对。'
              : 'worker中断，业务验证未完整满足；未知意图不重新发送。',
            sideEffectCertainty: summary.sideEffect,
            evidenceRefs: [],
          };
          await this.archiveResult(
            transaction,
            run,
            item,
            result,
            unjudged
              ? null
              : result.originalOutcome === 'passed'
                ? 'passed'
                : 'failed',
          );
          await transaction.query(
            'UPDATE app.run_items SET state=$3,cleanup_state=$2 WHERE id=$1',
            [
              item.runItemId,
              summary.cleanupState,
              (summary.businessPassed || unjudged) &&
              summary.cleanupState !== 'interrupted'
                ? 'completed'
                : 'interrupted',
            ],
          );
          await transaction.query(
            'UPDATE app.api_case_facts SET original_outcome=$2,cleanup_state=$3,side_effect_certainty=$4,reason=$5,ended_at=clock_timestamp() WHERE run_item_id=$1',
            [
              item.runItemId,
              unjudged ? null : result.originalOutcome,
              summary.cleanupState,
              summary.sideEffect,
              result.reason,
            ],
          );
          await this.revokeItemSecrets(transaction, item.runItemId);
        }
        const items = await transaction.query<{
          outcome: string | null;
          cleanup_state: string;
        }>('SELECT outcome,cleanup_state FROM app.run_items WHERE run_id=$1', [
          run.id,
        ]);
        const finalState = needsRecovery
          ? 'recoveryRequired'
          : incompleteValidation
            ? 'interrupted'
            : items.rows.some((item) => item.outcome === 'notExecuted')
              ? 'terminated'
              : 'completed';
        const cleanupState = items.rows.some(
          (item) => item.cleanup_state === 'interrupted',
        )
          ? 'interrupted'
          : items.rows.some((item) => item.cleanup_state === 'failed')
            ? 'failed'
            : items.rows.some((item) => item.cleanup_state === 'skipped')
              ? 'skipped'
              : items.rows.some((item) => item.cleanup_state === 'succeeded')
                ? 'succeeded'
                : 'notConfigured';
        await transaction.query(
          "UPDATE app.runs SET state=$2,cleanup_state=$3,ended_at=CASE WHEN $2='recoveryRequired' THEN NULL ELSE clock_timestamp() END WHERE id=$1",
          [run.id, finalState, cleanupState],
        );
        const report = await this.report(
          transaction,
          run,
          'api-worker-ownership-unknown',
        );
        await this.event(transaction, run.id, 'run.reconciled', {
          state: finalState,
          pureProjection: !needsRecovery,
          automaticReplay: false,
          reportId: report.reportId,
        });
      }
      return { reconciled: abandoned.rowCount ?? 0 };
    });
  }
  async abandon(token: string) {
    await this.db.transaction(async (transaction) => {
      const run = await this.grant(transaction, token);
      await transaction.query(
        'UPDATE app.api_worker_grants SET expires_at=clock_timestamp() WHERE id=$1',
        [run.grant_id],
      );
    });
    return this.reconcileExpired();
  }
  async events(
    actor: ActorContext,
    projectId: string,
    runId: string,
    after = 0,
  ) {
    return this.db.transaction(async (transaction) => {
      await requireProject(transaction, actor, projectId, 'project.read');
      await this.assertVisible(transaction, runId);
      if (
        !(
          await transaction.query(
            'SELECT 1 FROM app.runs WHERE id=$1 AND project_id=$2',
            [runId, projectId],
          )
        ).rowCount
      )
        throw new DomainError('NOT_FOUND', '没有该运行。', 404);
      const events = await transaction.query<{
        sequence: string;
        event_type: string;
        payload: JsonValue;
        created_at: Date;
      }>(
        'SELECT sequence,event_type,payload,created_at FROM app.api_run_events WHERE run_id=$1 AND sequence>$2 ORDER BY sequence LIMIT 1000',
        [runId, after],
      );
      const attempts = await transaction.query(
        "SELECT id,run_item_id,phase,step_id,state,outcome,send_intent_at,side_effect_certainty,response_safe->'status' status,response_safe->'elapsedMs' elapsed_ms,reason FROM app.api_step_attempts WHERE run_id=$1 ORDER BY created_at,id LIMIT 200",
        [runId],
      );
      return {
        events: events.rows.map((event) => ({
          sequence: event.sequence,
          type: event.event_type,
          payload: event.payload,
          createdAt: event.created_at.toISOString(),
        })),
        attempts: attempts.rows,
      };
    });
  }
  async resultTrace(
    actor: ActorContext,
    projectId: string,
    runId: string,
    runItemId: string,
  ) {
    return this.db.transaction(async (transaction) => {
      await requireProject(transaction, actor, projectId, 'project.read');
      const {
        rows: [item],
      } = await transaction.query<{ content: unknown }>(
        `SELECT i.snapshot->'content' content FROM app.run_items i JOIN app.runs r ON r.id=i.run_id
         WHERE i.id=$1 AND i.run_id=$2 AND i.project_id=$3 AND r.kind='API'`,
        [runItemId, runId, projectId],
      );
      if (!item)
        throw new DomainError('NOT_FOUND', '没有此项目接口执行项。', 404);
      await this.assertVisible(transaction, runId);
      const content = apiCaseContentSchema.parse(item.content);
      const businessNames = new Map(
        content.steps.map(({ stepId, name }) => [stepId, name]),
      );
      const cleanupNames = new Map(
        content.cleanup.mode === 'none'
          ? []
          : content.cleanup.steps.flatMap((step) =>
              step.type === 'http'
                ? [[step.cleanupStepId, step.request.name] as const]
                : [],
            ),
      );
      const attempts = await transaction.query<{
        phase: ApiPhase;
        step_id: string;
        send_intent_at: Date | null;
      }>(
        `SELECT id,phase,step_id,state,outcome,send_intent_at,side_effect_certainty,
          response_safe->'status' status,response_safe->'elapsedMs' elapsed_ms,reason
         FROM app.api_step_attempts WHERE project_id=$1 AND run_id=$2 AND run_item_id=$3
         ORDER BY created_at,id LIMIT 1000`,
        [projectId, runId, runItemId],
      );
      return apiResultTraceSchema.parse({
        attempts: attempts.rows.map((attempt) => ({
          ...attempt,
          step_name:
            (attempt.phase === 'business'
              ? businessNames.get(attempt.step_id)
              : attempt.phase === 'cleanupHttp'
                ? cleanupNames.get(attempt.step_id)
                : null) ?? null,
          send_intent_at: attempt.send_intent_at?.toISOString() ?? null,
        })),
      });
    });
  }
  async attemptDetail(
    actor: ActorContext,
    projectId: string,
    runId: string,
    intentId: string,
  ) {
    return this.db.transaction(async (transaction) => {
      await requireProject(transaction, actor, projectId, 'project.read');
      await this.assertVisible(transaction, runId);
      const attempt = (
        await transaction.query(
          'SELECT id,phase,step_id,state,outcome,send_intent_at,side_effect_certainty,request_safe,response_safe,extractions_safe,assertions_safe,reason FROM app.api_step_attempts WHERE id=$1 AND run_id=$2 AND project_id=$3',
          [intentId, runId, projectId],
        )
      ).rows[0];
      if (!attempt)
        throw new DomainError('NOT_FOUND', '没有此项目运行的步骤事实。', 404);
      return apiAttemptDetailSchema.parse({
        attempt: {
          ...attempt,
          send_intent_at:
            attempt.send_intent_at instanceof Date
              ? attempt.send_intent_at.toISOString()
              : null,
        },
      });
    });
  }
}
