import { AgentScheduleService } from './service.js';
import type { Database } from '../../../persistence/src/database.js';
import type { ConversationsService } from '../conversations/service.js';
import type { AiTasksService } from '../conversations/tasks.js';

/** Reconcile only the original task with the policy fixed by its occurrence snapshot. */
export function createAgentScheduleService(
  db: Database,
  conversations: ConversationsService,
  tasks: AiTasksService,
) {
  return new AgentScheduleService(db, {
    validateDraft: (actor, cid, template) =>
      conversations.validateScheduledDraft(actor, cid, template),
    enqueue: (id, token) => conversations.sendFromSchedule(id, token),
    lookup: async (id) => {
      const row = (
        await db.query<{ id: string; state: string }>(
          "SELECT t.id,t.state FROM app.agent_schedule_occurrences o JOIN app.ai_tasks t ON t.id=o.task_id AND t.owner_id=o.owner_id AND t.conversation_id=o.conversation_id WHERE o.id=$1 AND (t.execution_policy=CASE o.snapshot->>'kind' WHEN 'draft' THEN 'draftOnly' WHEN 'office' THEN 'officeOnly' END OR (o.snapshot IS NULL AND t.execution_policy IN ('draftOnly','officeOnly')))",
          [id],
        )
      ).rows[0];
      return row ? { taskId: row.id, state: row.state } : null;
    },
    cancelTask: async (id) => {
      const row = (
        await db.query<{ owner_id: string; task_id: string }>(
          "SELECT o.owner_id,o.task_id FROM app.agent_schedule_occurrences o JOIN app.ai_tasks t ON t.id=o.task_id AND t.owner_id=o.owner_id AND t.conversation_id=o.conversation_id WHERE o.id=$1 AND (t.execution_policy=CASE o.snapshot->>'kind' WHEN 'draft' THEN 'draftOnly' WHEN 'office' THEN 'officeOnly' END OR (o.snapshot IS NULL AND t.execution_policy IN ('draftOnly','officeOnly')))",
          [id],
        )
      ).rows[0];
      if (row)
        await tasks.cancel(
          { userId: row.owner_id, entrypoint: 'web', requestId: id },
          row.task_id,
          { commandId: id },
        );
    },
  });
}
