import {
  workspaceDraftDeleteSchema,
  workspaceDraftInputSchema,
  workspaceDraftKeySchema,
  workspaceDraftSaveSchema,
} from '../../../contracts/src/workspace-drafts.js';
import type { ActorContext } from '../../../contracts/src/identity.js';
import type {
  Database,
  SqlExecutor,
} from '../../../persistence/src/database.js';
import { DomainError, stale } from '../errors.js';
import { assertSafeModelInput } from '../security/model-input.js';
import { conversationRow, personalActor } from './common.js';

interface DraftRow {
  revision_id: string;
  draft: unknown;
  updated_at: Date;
}

const maxDraftBytes = 512 * 1024;
const draftFields = 'revision_id,draft,updated_at';

function draftDto(row: DraftRow | undefined) {
  return row
    ? {
        revisionId: row.revision_id,
        draft: workspaceDraftInputSchema.parse(row.draft),
        updatedAt: row.updated_at.toISOString(),
      }
    : null;
}

async function authorizeDraft(
  tx: SqlExecutor,
  actor: ActorContext,
  key: string,
) {
  // New drafts are personal notes. Their chosen context and references are
  // editor state only. Sending a message still performs normal authorization.
  if (key.startsWith('new:')) {
    await personalActor(tx, actor);
    return null;
  }
  return (await conversationRow(tx, actor, key)).id;
}

export class WorkspaceDraftService {
  constructor(readonly db: Database) {}

  listUnsaved(actor: ActorContext) {
    return this.db.transaction(async (tx) => {
      await personalActor(tx, actor);
      const result = await tx.query<{ draft_key: string; updated_at: Date }>(
        `SELECT draft_key,updated_at FROM app.ai_workspace_drafts
         WHERE owner_id=$1 AND conversation_id IS NULL
           AND (draft->>'content' <> '' OR jsonb_array_length(draft->'references') > 0
             OR COALESCE(jsonb_array_length(draft->'skillIds'),0) > 0)
         ORDER BY updated_at DESC,draft_key LIMIT 100`,
        [actor.userId],
      );
      return {
        drafts: result.rows.map((row) => ({
          key: row.draft_key,
          updatedAt: row.updated_at.toISOString(),
        })),
      };
    });
  }

  read(actor: ActorContext, rawKey: unknown) {
    const key = workspaceDraftKeySchema.parse(rawKey);
    return this.db.transaction(async (tx) => {
      await authorizeDraft(tx, actor, key);
      const row = (
        await tx.query<DraftRow>(
          `SELECT ${draftFields} FROM app.ai_workspace_drafts WHERE owner_id=$1 AND draft_key=$2`,
          [actor.userId, key],
        )
      ).rows[0];
      return { draft: draftDto(row) };
    });
  }

  save(actor: ActorContext, rawKey: unknown, raw: unknown) {
    const key = workspaceDraftKeySchema.parse(rawKey);
    const { baseRevisionId, draft } = workspaceDraftSaveSchema.parse(raw);
    const data = JSON.stringify(draft);
    if (Buffer.byteLength(data) > maxDraftBytes)
      throw new DomainError('VALIDATION_ERROR', '草稿超过保存上限。', 400);
    assertSafeModelInput(draft);
    return this.db.transaction(async (tx) => {
      const conversationId = await authorizeDraft(tx, actor, key);
      const { rows } =
        baseRevisionId === null
          ? await tx.query<DraftRow>(
              `INSERT INTO app.ai_workspace_drafts(owner_id,draft_key,conversation_id,draft)
               VALUES($1,$2,$3,$4::jsonb) ON CONFLICT(owner_id,draft_key) DO NOTHING RETURNING ${draftFields}`,
              [actor.userId, key, conversationId, data],
            )
          : await tx.query<DraftRow>(
              `UPDATE app.ai_workspace_drafts SET draft=$3::jsonb,revision_id=gen_random_uuid(),updated_at=clock_timestamp()
               WHERE owner_id=$1 AND draft_key=$2 AND revision_id=$4 RETURNING ${draftFields}`,
              [actor.userId, key, data, baseRevisionId],
            );
      if (!rows[0]) stale();
      return { draft: draftDto(rows[0]) };
    });
  }

  delete(actor: ActorContext, rawKey: unknown, raw: unknown) {
    const key = workspaceDraftKeySchema.parse(rawKey);
    const { revisionId } = workspaceDraftDeleteSchema.parse(raw);
    return this.db.transaction(async (tx) => {
      await authorizeDraft(tx, actor, key);
      const result = await tx.query(
        `DELETE FROM app.ai_workspace_drafts WHERE owner_id=$1 AND draft_key=$2 AND revision_id=$3`,
        [actor.userId, key, revisionId],
      );
      return { deleted: result.rowCount === 1 };
    });
  }
}
