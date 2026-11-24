import { createHash, randomUUID } from 'node:crypto';
import type { ActorContext } from '../../../contracts/src/identity.js';
import { idSchema } from '../../../contracts/src/base.js';
import type {
  Database,
  SqlExecutor,
} from '../../../persistence/src/database.js';
import { listProjectAccess, requireProject } from '../access/policy.js';
import { canonicalJson } from '../operations/service.js';
import { DomainError } from '../errors.js';
import type { WorkspaceAccessMode } from '../../../contracts/src/workspace-access.js';
import type { AiContextResetReason } from '../../../contracts/src/ai-context.js';

export interface AiCheckpointScope {
  ownerId: string;
  conversationId: string;
  projectId: string | null;
  accessDigest: string;
  threadKey: string;
  runId: string;
  contextReset: boolean;
  contextRevision?: string;
  contextResetReason?: AiContextResetReason;
  retainedThreadKey?: string;
  mayReadRetainedToolHistory?: boolean;
}
interface RuntimeThread {
  owner_id: string;
  project_id: string | null;
  access_digest: string;
  active_run_id: string | null;
  deleted_at: Date | null;
}

export class AiRuntimeAccess {
  constructor(readonly db: Database) {}

  async begin(
    actor: ActorContext,
    conversationId: string,
    projectId?: string,
    contextRevision?: string,
    context: {
      accessMode?: WorkspaceAccessMode;
      sourcesChanged?: boolean;
    } = {},
  ): Promise<AiCheckpointScope> {
    idSchema.parse(conversationId);
    if (projectId !== undefined) idSchema.parse(projectId);
    return this.db.transaction(async (tx) => {
      const facts = await this.authorizationFacts(tx, actor);
      const digest = createHash('sha256')
        .update(
          canonicalJson({ ...facts, contextRevision: contextRevision ?? null }),
        )
        .digest('hex');
      // Classification metadata only. The full access digest and its live
      // authorization/fencing checks retain their existing authority.
      const stamp = createHash('sha256')
        .update(canonicalJson(facts))
        .digest('hex');
      if (projectId) await requireProject(tx, actor, projectId, 'project.read');
      await tx.query(
        `INSERT INTO app.ai_runtime_threads(conversation_id,owner_id,project_id,access_digest)
        VALUES($1,$2,$3,$4) ON CONFLICT(conversation_id) DO NOTHING`,
        [conversationId, actor.userId, projectId ?? null, digest],
      );
      const row = (
        await tx.query<RuntimeThread>(
          'SELECT * FROM app.ai_runtime_threads WHERE conversation_id=$1 FOR UPDATE',
          [conversationId],
        )
      ).rows[0];
      if (!row || row.owner_id !== actor.userId || row.deleted_at)
        throw new DomainError(
          'NOT_FOUND',
          '没有此账号可用的AI运行上下文。',
          404,
        );
      if (row.project_id !== (projectId ?? null))
        throw new DomainError(
          'BUSINESS_CONFLICT',
          '已有运行上下文的项目归属不可静默变更。',
          409,
        );
      if (row.active_run_id)
        throw new DomainError(
          'BUSINESS_CONFLICT',
          '此上下文已有未结束运行；请查询原运行，不自动接管或重放。',
          409,
        );
      const previousBase = `ath:${actor.userId}:${conversationId}:${row.access_digest}`;
      const previous = (
        await tx.query<{ thread_key: string }>(
          `SELECT thread_key FROM app.ai_runtime_checkpoints
           WHERE conversation_id=$1 AND checkpoint_ns=''
           AND (thread_key=$2 OR thread_key LIKE ($2 || ':auth-v2:%'))
           ORDER BY checkpoint_id DESC LIMIT 1`,
          [conversationId, previousBase],
        )
      ).rows[0]?.thread_key;
      const mode = context.accessMode ?? 'legacy';
      const threadKey = `ath:${actor.userId}:${conversationId}:${digest}:auth-v2:${stamp}:mode:${mode}`;
      const previousStamp = previous
        ?.slice(previousBase.length)
        .match(/^:auth-v2:([a-f0-9]{64}):mode:(full|restricted|legacy)$/);
      const sameAuthorization = previousStamp?.[1] === stamp;
      const sameMode = previousStamp?.[2] === mode;
      const contextReset =
        row.access_digest !== digest ||
        Boolean(previous && previous !== threadKey);
      const resetReason: AiContextResetReason = !previousStamp
        ? 'context-rebuilt'
        : !sameAuthorization
          ? 'authorization-scope-changed'
          : !sameMode
            ? 'access-mode-changed'
            : context.sourcesChanged
              ? 'source-context-changed'
              : 'run-recovery';
      const runId = randomUUID();
      await tx.query(
        'UPDATE app.ai_runtime_threads SET access_digest=$2,active_run_id=$3,updated_at=clock_timestamp() WHERE conversation_id=$1',
        [conversationId, digest, runId],
      );
      return {
        ownerId: actor.userId,
        conversationId,
        projectId: projectId ?? null,
        accessDigest: digest,
        threadKey,
        runId,
        contextReset,
        ...(contextReset ? { contextResetReason: resetReason } : {}),
        ...(previous && previous !== threadKey
          ? { retainedThreadKey: previous }
          : {}),
        mayReadRetainedToolHistory:
          Boolean(previous && previous !== threadKey) &&
          sameAuthorization &&
          sameMode,
        ...(contextRevision ? { contextRevision } : {}),
      };
    });
  }

  async assert(actor: ActorContext, scope: AiCheckpointScope): Promise<void> {
    await this.withAccess(actor, scope, async () => undefined);
  }
  async assertActive(
    actor: ActorContext,
    scope: AiCheckpointScope,
  ): Promise<void> {
    await this.withAccess(actor, scope, async () => undefined, true);
  }

  async withAccess<T>(
    actor: ActorContext,
    scope: AiCheckpointScope,
    work: (tx: SqlExecutor) => Promise<T>,
    requireActiveRun = false,
  ): Promise<T> {
    return this.db.transaction(async (tx) => {
      const digest = await this.digest(tx, actor, scope.contextRevision);
      const row = (
        await tx.query<RuntimeThread>(
          'SELECT * FROM app.ai_runtime_threads WHERE conversation_id=$1 FOR SHARE',
          [scope.conversationId],
        )
      ).rows[0];
      if (
        actor.userId !== scope.ownerId ||
        !row ||
        row.owner_id !== actor.userId ||
        row.deleted_at
      )
        throw new DomainError(
          'NOT_FOUND',
          '没有此账号可用的AI运行上下文。',
          404,
        );
      if (scope.accessDigest !== digest || row.access_digest !== digest) {
        throw new DomainError(
          'PRECONDITIONS_MISSING',
          '资料授权已变化，旧运行上下文不可继续读取；请重新建立当前授权范围。',
          422,
        );
      }
      if (requireActiveRun && row.active_run_id !== scope.runId)
        throw new DomainError(
          'BUSINESS_CONFLICT',
          '此运行已失去检查点写入资格，不能覆盖后续运行。',
          409,
        );
      if (scope.projectId)
        await requireProject(tx, actor, scope.projectId, 'project.read');
      return work(tx);
    });
  }

  async finish(scope: AiCheckpointScope): Promise<void> {
    // This only releases this worker's bookkeeping grant, even if the user was disabled mid-call.
    await this.db.query(
      'UPDATE app.ai_runtime_threads SET active_run_id=NULL,updated_at=clock_timestamp() WHERE conversation_id=$1 AND owner_id=$2 AND active_run_id=$3',
      [scope.conversationId, scope.ownerId, scope.runId],
    );
  }

  private async digest(
    tx: SqlExecutor,
    actor: ActorContext,
    contextRevision?: string,
  ): Promise<string> {
    const facts = await this.authorizationFacts(tx, actor);
    return createHash('sha256')
      .update(
        canonicalJson({ ...facts, contextRevision: contextRevision ?? null }),
      )
      .digest('hex');
  }

  private async authorizationFacts(tx: SqlExecutor, actor: ActorContext) {
    const projects = await listProjectAccess(tx, actor);
    return {
      userId: actor.userId,
      keyId: actor.keyId ?? null,
      capabilities: actor.allowedCapabilities
        ? [...actor.allowedCapabilities].sort()
        : null,
      projects: projects
        .map(
          ({
            id,
            roles,
            memberVersion,
            rowVersion,
            inheritsPlatformAdmin,
          }) => ({
            id,
            roles,
            member_version: memberVersion,
            project_version: rowVersion,
            ...(inheritsPlatformAdmin && { inheritsPlatformAdmin }),
          }),
        )
        .sort((left, right) => left.id.localeCompare(right.id)),
    };
  }
}
