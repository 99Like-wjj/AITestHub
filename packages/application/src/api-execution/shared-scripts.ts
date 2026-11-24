import { randomUUID } from 'node:crypto';
import {
  apiSharedScriptCreateInputSchema,
  apiSharedScriptGetInputSchema,
  apiSharedScriptGetResultSchema,
  apiSharedScriptListInputSchema,
  apiSharedScriptListResultSchema,
  apiSharedScriptReviseInputSchema,
  type ApiSharedScriptReference,
} from '../../../contracts/src/api-shared-scripts.js';
import type { ActorContext } from '../../../contracts/src/identity.js';
import type {
  Database,
  SqlExecutor,
} from '../../../persistence/src/database.js';
import { requireProject, requireProjectDraftWrite } from '../access/policy.js';
import { DomainError } from '../errors.js';
import { OperationService } from '../operations/service.js';
import { assertSafeModelInput } from '../security/model-input.js';

interface ScriptRow {
  id: string;
  title: string;
  current_revision_id: string;
  revision_number: number;
  row_version: number;
  created_at: Date;
  updated_at: Date;
}
interface RevisionSummaryRow {
  id: string;
  title: string;
  revision_number: number;
  created_at: Date;
}
interface RevisionRow extends RevisionSummaryRow {
  body: string;
}

const pageSize = 100;
const missing = () =>
  new DomainError('NOT_FOUND', '未找到本项目的共享脚本或所选修订。', 404);
const selectCurrent = `
  SELECT s.id,r.title,s.current_revision_id,s.revision_number,s.row_version,s.created_at,s.updated_at
  FROM app.api_shared_scripts s
  JOIN app.api_shared_script_revisions r
    ON (r.project_id,r.script_id,r.id) = (s.project_id,s.id,s.current_revision_id)
`;

const scriptDto = (row: ScriptRow) => ({
  scriptId: row.id,
  title: row.title,
  currentRevisionId: row.current_revision_id,
  revisionNo: row.revision_number,
  rowVersion: row.row_version,
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
});
const revisionDto = (row: RevisionSummaryRow) => ({
  revisionId: row.id,
  title: row.title,
  revisionNo: row.revision_number,
  createdAt: row.created_at.toISOString(),
});

export async function requireApiSharedScriptRevision(
  tx: SqlExecutor,
  projectId: string,
  source: ApiSharedScriptReference,
) {
  const row = (
    await tx.query<RevisionRow>(
      'SELECT id,title,revision_number,created_at,body FROM app.api_shared_script_revisions WHERE project_id=$1 AND script_id=$2 AND id=$3',
      [projectId, source.scriptId, source.scriptRevisionId],
    )
  ).rows[0];
  if (!row) throw missing();
  return {
    ...revisionDto(row),
    body: row.body,
  };
}

async function readScript(
  tx: SqlExecutor,
  projectId: string,
  input: {
    scriptId: string;
    revisionId?: string | undefined;
    beforeRevisionNo?: number | undefined;
  },
) {
  const current = (
    await tx.query<ScriptRow>(
      selectCurrent + ' WHERE s.project_id=$1 AND s.id=$2 FOR SHARE OF s',
      [projectId, input.scriptId],
    )
  ).rows[0];
  if (!current) throw missing();
  const revision = await requireApiSharedScriptRevision(tx, projectId, {
    scriptId: input.scriptId,
    scriptRevisionId: input.revisionId ?? current.current_revision_id,
  });
  const page = (
    await tx.query<RevisionSummaryRow>(
      'SELECT id,title,revision_number,created_at FROM app.api_shared_script_revisions WHERE project_id=$1 AND script_id=$2 AND ($3::integer IS NULL OR revision_number < $3) ORDER BY revision_number DESC LIMIT $4',
      [projectId, input.scriptId, input.beforeRevisionNo ?? null, pageSize + 1],
    )
  ).rows;
  const revisions = page.slice(0, pageSize).map(revisionDto);
  return apiSharedScriptGetResultSchema.parse({
    script: scriptDto(current),
    revision,
    revisions,
    nextBeforeRevisionNo:
      page.length > pageSize ? (revisions.at(-1)?.revisionNo ?? null) : null,
  });
}

export class ApiSharedScriptService {
  readonly #operations: OperationService;

  constructor(private readonly db: Pick<Database, 'transaction' | 'query'>) {
    this.#operations = new OperationService(db);
  }

  async list(actor: ActorContext, projectId: string, raw: unknown = {}) {
    const input = apiSharedScriptListInputSchema.parse(raw);
    return this.db.transaction(async (tx) => {
      await requireProject(tx, actor, projectId, 'project.read');
      const rows = (
        await tx.query<ScriptRow>(
          selectCurrent +
            ' WHERE s.project_id=$1 AND ($2::text IS NULL OR position(lower($2) in lower(r.title)) > 0) AND ($3::uuid IS NULL OR s.id > $3) ORDER BY s.id LIMIT $4',
          [
            projectId,
            input.keyword ?? null,
            input.afterScriptId ?? null,
            pageSize + 1,
          ],
        )
      ).rows;
      const scripts = rows.slice(0, pageSize).map(scriptDto);
      return apiSharedScriptListResultSchema.parse({
        scripts,
        nextAfterScriptId:
          rows.length > pageSize ? (scripts.at(-1)?.scriptId ?? null) : null,
      });
    });
  }

  async get(actor: ActorContext, projectId: string, raw: unknown) {
    const input = apiSharedScriptGetInputSchema.parse(raw);
    return this.db.transaction(async (tx) => {
      await requireProject(tx, actor, projectId, 'project.read');
      return readScript(tx, projectId, input);
    });
  }

  async create(actor: ActorContext, projectId: string, raw: unknown) {
    const input = apiSharedScriptCreateInputSchema.parse(raw);
    assertSafeModelInput(input);
    return this.#operations.execute(
      actor,
      'api-catalog.script-create',
      input.commandId,
      input,
      async (tx) => {
        await requireProjectDraftWrite(tx, actor, projectId, 'assets.write');
      },
      async (tx) => {
        const scriptId = randomUUID();
        const revisionId = randomUUID();
        await tx.query(
          'INSERT INTO app.api_shared_scripts(id,project_id,current_revision_id,revision_number) VALUES($1,$2,$3,1)',
          [scriptId, projectId, revisionId],
        );
        await tx.query(
          'INSERT INTO app.api_shared_script_revisions(id,project_id,script_id,revision_number,title,body,created_by) VALUES($1,$2,$3,1,$4,$5,$6)',
          [
            revisionId,
            projectId,
            scriptId,
            input.title,
            input.body,
            actor.userId,
          ],
        );
        return readScript(tx, projectId, { scriptId, revisionId });
      },
      projectId,
    );
  }

  async revise(actor: ActorContext, projectId: string, raw: unknown) {
    const input = apiSharedScriptReviseInputSchema.parse(raw);
    assertSafeModelInput(input);
    return this.#operations.execute(
      actor,
      'api-catalog.script-revise',
      input.commandId,
      input,
      async (tx) => {
        await requireProjectDraftWrite(tx, actor, projectId, 'assets.write');
      },
      async (tx) => {
        const revisionId = randomUUID();
        const updated = (
          await tx.query<{ revision_number: number }>(
            `UPDATE app.api_shared_scripts
             SET current_revision_id=$3,revision_number=revision_number+1,row_version=row_version+1,updated_at=clock_timestamp()
             WHERE project_id=$1 AND id=$2 AND current_revision_id=$4 AND row_version=$5
             RETURNING revision_number`,
            [
              projectId,
              input.scriptId,
              revisionId,
              input.baseRevisionId,
              input.rowVersion,
            ],
          )
        ).rows[0];
        if (!updated) {
          const script = await tx.query(
            'SELECT id FROM app.api_shared_scripts WHERE project_id=$1 AND id=$2',
            [projectId, input.scriptId],
          );
          if (!script.rowCount) throw missing();
          throw new DomainError(
            'STALE_BASE_REVISION',
            '共享脚本已有新版本，请比较当前修订后重新提交。',
            409,
          );
        }
        await tx.query(
          'INSERT INTO app.api_shared_script_revisions(id,project_id,script_id,revision_number,title,body,created_by) VALUES($1,$2,$3,$4,$5,$6,$7)',
          [
            revisionId,
            projectId,
            input.scriptId,
            updated.revision_number,
            input.title,
            input.body,
            actor.userId,
          ],
        );
        return readScript(tx, projectId, {
          scriptId: input.scriptId,
          revisionId,
        });
      },
      projectId,
    );
  }
}
