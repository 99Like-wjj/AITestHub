import { randomUUID } from 'node:crypto';
import type { ActorContext } from '../../../contracts/src/identity.js';
import {
  acceptAutomaticAliasInputSchema,
  automaticAliasPreviewSchema,
  automaticAliasReceiptSchema,
  automaticAuxiliaryListSchema,
} from '../../../contracts/src/automatic-auxiliary.js';
import { auxiliaryModelSnapshotSchema } from '../../../contracts/src/auxiliary.js';
import type { SqlExecutor } from '../../../persistence/src/database.js';
import { personalActor } from '../conversations/common.js';
import { requireProject } from '../access/policy.js';
import { DomainError } from '../errors.js';
import { assertNewWorkAllowed } from '../recovery/maintenance.js';
import { AuxiliaryService } from './service.js';
import { resolveNewAuxiliarySelection } from './model-snapshot.js';
import {
  automaticDigest,
  automaticNameHash,
  automaticIntentDto,
  automaticTableReady,
  type AutomaticIntentRow,
} from './automatic-common.js';
export class AutomaticAuxiliaryService {
  constructor(readonly auxiliary: AuxiliaryService) {}
  get db() {
    return this.auxiliary.db;
  }
  private async schema(tx: SqlExecutor, actor: ActorContext) {
    await personalActor(tx, actor);
    if (!(await automaticTableReady(tx)))
      throw new DomainError(
        'DEPENDENCY_UNAVAILABLE',
        '自动辅助入口迁移尚未部署；人工主流程仍可使用。',
        503,
      );
  }
  private async group(
    tx: SqlExecutor,
    actor: ActorContext,
    id: string,
    lock = false,
  ) {
    await this.schema(tx, actor);
    let intent = (
      await tx.query<AutomaticIntentRow>(
        `SELECT * FROM app.automatic_auxiliary_intents WHERE id=$1 AND owner_id=$2 AND purpose='groupAlias'`,
        [id, actor.userId],
      )
    ).rows[0];
    if (!intent)
      throw new DomainError('NOT_FOUND', '没有此本人自动命名意图。', 404);
    await requireProject(tx, actor, intent.project_id, 'project.read');
    const group = (
      await tx.query<{
        title: string;
        row_version: number;
        alias: string | null;
      }>(
        `SELECT r.title,g.row_version,g.alias FROM app.ai_requirement_groups g JOIN app.requirements r ON r.id=g.requirement_id AND r.project_id=g.project_id JOIN app.requirement_participants p ON p.requirement_id=g.requirement_id AND p.user_id=g.owner_id AND p.active WHERE g.owner_id=$1 AND g.requirement_id=$2 AND NOT g.hidden AND g.archived_at IS NULL FOR SHARE OF r,g,p`,
        [actor.userId, intent.requirement_id],
      )
    ).rows[0];
    if (!group)
      throw new DomainError(
        'NOT_FOUND',
        '自动命名来源已隐藏、归档或不再参与。',
        404,
      );
    if (lock) {
      intent = (
        await tx.query<AutomaticIntentRow>(
          "SELECT * FROM app.automatic_auxiliary_intents WHERE id=$1 AND owner_id=$2 AND purpose='groupAlias' FOR UPDATE",
          [id, actor.userId],
        )
      ).rows[0];
      if (!intent)
        throw new DomainError('NOT_FOUND', '原命名意图已变化。', 404);
    }
    return { intent, group };
  }
  async list(actor: ActorContext, projectId?: string, afterId?: string) {
    return this.db.transaction(async (tx) => {
      await this.schema(tx, actor);
      if (projectId) await requireProject(tx, actor, projectId, 'project.read');
      if (
        afterId &&
        !(
          await tx.query(
            'SELECT 1 FROM app.automatic_auxiliary_intents WHERE id=$1 AND owner_id=$2',
            [afterId, actor.userId],
          )
        ).rowCount
      )
        throw new DomainError(
          'PRECONDITIONS_MISSING',
          '原任务游标已变化，请刷新任务列表。',
          422,
        );
      let modelAvailable = true,
        modelUnavailableReason: string | null = null;
      try {
        await resolveNewAuxiliarySelection(
          this.auxiliary.configuration,
          tx,
          actor,
        );
      } catch (error) {
        if (!(error instanceof DomainError)) throw error;
        modelAvailable = false;
        modelUnavailableReason = error.code;
      }
      const rows = (
        await tx.query<AutomaticIntentRow & { title: string }>(
          `SELECT i.*,r.title FROM app.automatic_auxiliary_intents i JOIN app.ai_requirement_groups g ON g.owner_id=i.owner_id AND g.requirement_id=i.requirement_id JOIN app.requirements r ON r.id=g.requirement_id AND r.project_id=i.project_id JOIN app.requirement_participants p ON p.requirement_id=r.id AND p.user_id=i.owner_id AND p.active JOIN app.project_members m ON m.project_id=i.project_id AND m.user_id=i.owner_id AND m.active JOIN app.projects pr ON pr.id=i.project_id AND pr.active WHERE i.owner_id=$1 AND i.purpose='groupAlias' AND ($2::uuid IS NULL OR i.project_id=$2) AND ($3::uuid IS NULL OR (i.created_at,i.id)<(SELECT created_at,id FROM app.automatic_auxiliary_intents WHERE id=$3 AND owner_id=$1)) AND NOT g.hidden AND g.archived_at IS NULL AND (g.alias IS NULL OR i.state<>'pendingPermission') ORDER BY i.created_at DESC,i.id LIMIT 101`,
          [actor.userId, projectId ?? null, afterId ?? null],
        )
      ).rows;
      return automaticAuxiliaryListSchema.parse({
        intents: rows
          .slice(0, 100)
          .map((row) => automaticIntentDto(row, row.title)),
        hasMore: rows.length > 100,
        nextCursor: rows.length > 100 ? rows[99]!.id : null,
        modelAvailable,
        modelUnavailableReason,
      });
    });
  }
  async previewAlias(actor: ActorContext, id: string) {
    const current = await this.db.transaction((tx) =>
      this.group(tx, actor, id),
    );
    if (current.intent.state !== 'pendingPermission')
      throw new DomainError(
        'BUSINESS_CONFLICT',
        '原自动命名已受理或结束，只查询原回执。',
        409,
      );
    if (current.group.alias !== null)
      throw new DomainError(
        'BUSINESS_CONFLICT',
        '已有人工作出的个人别名，不覆盖。',
        409,
      );
    const preflight = await this.auxiliary.preflight(actor, {
      source: {
        purpose: 'alias',
        projectId: current.intent.project_id,
        requirementId: current.intent.requirement_id,
        baseRowVersion: current.group.row_version,
        text: current.group.title,
      },
    });
    return this.db.transaction(async (tx) => {
      const { intent, group } = await this.group(tx, actor, id, true);
      if (
        intent.state !== 'pendingPermission' ||
        group.alias !== null ||
        group.title !== current.group.title ||
        group.row_version !== current.group.row_version
      )
        throw new DomainError(
          'STALE_BASE_REVISION',
          '分组来源已变化，请重新查看资料。',
          412,
        );
      const digest = automaticDigest({
        intentId: id,
        disclosureId: preflight.disclosure.id,
        disclosureDigest: preflight.disclosure.scopeDigest,
      });
      const updated = (
        await tx.query<AutomaticIntentRow>(
          'UPDATE app.automatic_auxiliary_intents SET disclosure_id=$2,scope_digest=$3,source_digest=$4,source_name_hash=$5,model_snapshot=$6,updated_at=clock_timestamp() WHERE id=$1 RETURNING *',
          [
            id,
            preflight.disclosure.id,
            digest,
            preflight.disclosure.sourceDigest,
            automaticNameHash(group.title),
            JSON.stringify(preflight.disclosure.model),
          ],
        )
      ).rows[0]!;
      return automaticAliasPreviewSchema.parse({
        intent: automaticIntentDto(updated, group.title),
        preflight,
      });
    });
  }
  async acceptAlias(actor: ActorContext, id: string, raw: unknown) {
    const input = acceptAutomaticAliasInputSchema.parse(raw),
      acceptHash = automaticDigest(input);
    const reserved = await this.db.transaction(async (tx) => {
      const { intent, group } = await this.group(tx, actor, id, true);
      if (intent.accept_command_key) {
        if (
          intent.accept_command_key !== input.commandId ||
          intent.accept_hash !== acceptHash
        )
          throw new DomainError(
            'IDEMPOTENCY_CONFLICT',
            '该意图已使用另一份确认；请查询原任务。',
            409,
          );
        return { intent, group, first: false };
      }
      await assertNewWorkAllowed(tx, true);
      if (
        intent.state !== 'pendingPermission' ||
        !intent.disclosure_id ||
        intent.scope_digest !== input.scopeDigest ||
        intent.source_name_hash !== automaticNameHash(group.title) ||
        group.alias !== null
      )
        throw new DomainError(
          'STALE_BASE_REVISION',
          '自动命名资料或模型已变化，请重新查看许可范围。',
          412,
        );
      const updated = (
        await tx.query<AutomaticIntentRow>(
          "UPDATE app.automatic_auxiliary_intents SET state='accepting',accept_command_key=$2,accept_hash=$3,data_scope=$4,consented_at=clock_timestamp(),protected_history=true,updated_at=clock_timestamp() WHERE id=$1 RETURNING *",
          [id, input.commandId, acceptHash, input.dataScope],
        )
      ).rows[0]!;
      tx.noteSecurityControlChange?.({
        action: 'automatic-auxiliary.accepting',
        objectId: id,
        projectId: intent.project_id,
      });
      return { intent: updated, group, first: true };
    });
    if (!reserved.first) return this.receipt(actor, id);
    try {
      const disclosure = (
        await this.db.query<{ scope_digest: string; model_snapshot: unknown }>(
          'SELECT scope_digest,model_snapshot FROM app.auxiliary_disclosures WHERE id=$1 AND owner_id=$2',
          [reserved.intent.disclosure_id, actor.userId],
        )
      ).rows[0];
      if (
        !disclosure ||
        automaticDigest(
          auxiliaryModelSnapshotSchema.parse(disclosure.model_snapshot),
        ) !==
          automaticDigest(
            auxiliaryModelSnapshotSchema.parse(reserved.intent.model_snapshot),
          )
      )
        throw new DomainError(
          'STALE_BASE_REVISION',
          '原模型预检不再有效。',
          412,
        );
      const task = await this.auxiliary.request(actor, {
        purpose: 'alias',
        projectId: reserved.intent.project_id,
        requirementId: reserved.intent.requirement_id,
        baseRowVersion: reserved.group.row_version,
        text: reserved.group.title,
        commandId: reserved.intent.auxiliary_command_id,
        dataScope: input.dataScope,
        disclosureId: reserved.intent.disclosure_id,
        disclosureDigest: disclosure.scope_digest,
        dataConsent: true,
      });
      await this.db.transaction(async (tx) => {
        await this.schema(tx, actor);
        await tx.query(
          "UPDATE app.automatic_auxiliary_intents SET auxiliary_task_id=$2,state=CASE WHEN state='accepting' THEN 'accepted' ELSE state END,updated_at=clock_timestamp() WHERE id=$1",
          [id, task.task.id],
        );
        tx.noteSecurityControlChange?.({
          action: 'automatic-auxiliary.accepted',
          objectId: id,
          projectId: reserved.intent.project_id,
        });
      });
      return this.receipt(actor, id);
    } catch (error) {
      const known = error instanceof DomainError && error.status < 500;
      await this.db.transaction(async (tx) => {
        await tx.query(
          "UPDATE app.automatic_auxiliary_intents SET state=$2,protected_history=$3,error_code=$4,updated_at=clock_timestamp() WHERE id=$1 AND state='accepting'",
          [
            id,
            known ? 'failed' : 'unknown',
            !known,
            error instanceof DomainError
              ? error.code
              : 'OPERATION_RESULT_UNKNOWN',
          ],
        );
        tx.noteSecurityControlChange?.({
          action: 'automatic-auxiliary.accept-failed',
          objectId: id,
          projectId: reserved.intent.project_id,
        });
      });
      if (known) throw error;
      return this.receipt(actor, id);
    }
  }
  async retryAlias(actor: ActorContext, id: string) {
    return this.db.transaction(async (tx) => {
      const { intent, group } = await this.group(tx, actor, id, true);
      if (
        (!['failed', 'cancelled', 'superseded'].includes(intent.state) &&
          !(
            intent.state === 'completed' &&
            intent.error_code === 'RESTORED_RESULT_NOT_AVAILABLE'
          )) ||
        group.alias !== null
      )
        throw new DomainError(
          'BUSINESS_CONFLICT',
          '原意图尚未明确结束或已有人工作出的别名，只能查询原回执。',
          409,
        );
      const existing = (
        await tx.query<AutomaticIntentRow>(
          "SELECT * FROM app.automatic_auxiliary_intents WHERE owner_id=$1 AND requirement_id=$2 AND purpose='groupAlias' AND state IN ('pendingPermission','accepting','accepted','unknown')",
          [actor.userId, intent.requirement_id],
        )
      ).rows[0];
      if (existing)
        return automaticAliasReceiptSchema.parse({
          intent: automaticIntentDto(existing, group.title),
          task: null,
        });
      const next = randomUUID(),
        row = (
          await tx.query<AutomaticIntentRow>(
            "INSERT INTO app.automatic_auxiliary_intents(id,owner_id,purpose,project_id,requirement_id,command_key,auxiliary_command_id) VALUES($1,$2,'groupAlias',$3,$4,$5,$6) RETURNING *",
            [
              next,
              actor.userId,
              intent.project_id,
              intent.requirement_id,
              'group-alias:' + next,
              'auto-alias:' + next,
            ],
          )
        ).rows[0]!;
      return automaticAliasReceiptSchema.parse({
        intent: automaticIntentDto(row, group.title),
        task: null,
      });
    });
  }
  async receipt(actor: ActorContext, id: string) {
    const current = await this.db.transaction((tx) =>
      this.group(tx, actor, id),
    );
    let task = null;
    if (
      current.intent.auxiliary_task_id ||
      ['accepting', 'accepted', 'unknown', 'completed'].includes(
        current.intent.state,
      )
    ) {
      try {
        task = await this.auxiliary.byCommand(
          actor,
          current.intent.auxiliary_command_id,
        );
      } catch (error) {
        if (!(error instanceof DomainError) || error.code !== 'NOT_FOUND')
          throw error;
      }
    }
    return automaticAliasReceiptSchema.parse({
      intent: automaticIntentDto(current.intent, current.group.title),
      task,
    });
  }
}
