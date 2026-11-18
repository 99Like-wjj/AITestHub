import type { ActorContext } from '../../../contracts/src/identity.js';
import { automaticAliasReceiptSchema } from '../../../contracts/src/automatic-auxiliary.js';
import { personalActor } from '../conversations/common.js';
import { requireProject } from '../access/policy.js';
import { DomainError } from '../errors.js';
import type { AuxiliaryService } from './service.js';
import {
  automaticIntentDto,
  automaticTableReady,
  type AutomaticIntentRow,
} from './automatic-common.js';

/** Historical naming receipts. New requirements schedule their own background name. */
export class AutomaticAuxiliaryService {
  constructor(readonly auxiliary: AuxiliaryService) {}

  async receipt(actor: ActorContext, id: string) {
    const current = await this.auxiliary.db.transaction(async (tx) => {
      await personalActor(tx, actor);
      if (!(await automaticTableReady(tx)))
        throw new DomainError('NOT_FOUND', '没有此历史命名回执。', 404);
      const intent = (
        await tx.query<AutomaticIntentRow>(
          "SELECT * FROM app.automatic_auxiliary_intents WHERE id=$1 AND owner_id=$2 AND purpose='groupAlias'",
          [id, actor.userId],
        )
      ).rows[0];
      if (!intent)
        throw new DomainError('NOT_FOUND', '没有此历史命名回执。', 404);
      await requireProject(tx, actor, intent.project_id, 'project.read');
      const group = (
        await tx.query<{ title: string }>(
          `SELECT r.title FROM app.ai_requirement_groups g
           JOIN app.requirements r ON r.id=g.requirement_id AND r.project_id=g.project_id
           JOIN app.requirement_participants p ON p.requirement_id=r.id AND p.user_id=g.owner_id AND p.active
           WHERE g.owner_id=$1 AND g.requirement_id=$2 AND g.project_id=$3
             AND NOT g.hidden AND g.archived_at IS NULL FOR SHARE OF r,g,p`,
          [actor.userId, intent.requirement_id, intent.project_id],
        )
      ).rows[0];
      if (!group)
        throw new DomainError('NOT_FOUND', '原命名分组当前不可访问。', 404);
      return { intent, group };
    });
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
