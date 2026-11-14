import {
  associateRetestRunInputSchema,
  associateRetestRunReceiptSchema,
} from '../../../contracts/src/preparation.js';
import { executionScopeSchema } from '../../../contracts/src/domain.js';
import type { ActorContext } from '../../../contracts/src/identity.js';
import type { Database } from '../../../persistence/src/database.js';
import type { RetestService } from './service.js';
import { requireProject } from '../access/policy.js';
import { OperationService, canonicalJson } from '../operations/service.js';
import { semanticDigest } from '../ui-executions/service.js';
import { DomainError } from '../errors.js';
import { audit } from '../events.js';
import { recordRetestVerifications } from './verifications.js';

/** Associate only an already claimed/started exact group scope. Never convert an arbitrary historical run. */
export async function associateRetestRun(
  db: Database,
  groups: Pick<RetestService, 'groupInTransaction'>,
  actor: ActorContext,
  projectId: string,
  groupId: string,
  raw: unknown,
) {
  const input = associateRetestRunInputSchema.parse(raw);
  return new OperationService(db).execute(
    actor,
    'retests.associate-run',
    input.commandId,
    { projectId, groupId, ...input },
    async (tx) => {
      await requireProject(tx, actor, projectId, 'runs.organize');
    },
    async (tx) => {
      const { scope: group } = await groups.groupInTransaction(
        tx,
        actor,
        projectId,
        groupId,
      );
      const run = (
        await tx.query<{
          source: string;
          source_revision_id: string;
          kind: string;
          scope_snapshot: unknown;
          scope_digest: string;
          environment_id: string;
          environment_revision_id: string;
          product_build: string | null;
        }>(
          'SELECT source,source_revision_id,kind,scope_snapshot,scope_digest,environment_id,environment_revision_id,product_build FROM app.runs WHERE project_id=$1 AND id=$2 FOR UPDATE',
          [projectId, input.runId],
        )
      ).rows[0];
      if (!run) throw new DomainError('NOT_FOUND', '此项目内没有该执行。', 404);
      const scope = executionScopeSchema.parse(run.scope_snapshot),
        { snapshotDigest, ...withoutDigest } = scope;
      if (
        run.source_revision_id !== groupId ||
        scope.sourceRevisionId !== groupId ||
        scope.sourceType !== 'retestPreparation' ||
        scope.projectId !== projectId ||
        scope.runId !== input.runId ||
        run.kind !== group.kind ||
        !['localUi', 'retest'].includes(run.source) ||
        input.snapshotDigest !== run.scope_digest ||
        snapshotDigest !== run.scope_digest ||
        semanticDigest(withoutDigest) !== snapshotDigest
      )
        throw new DomainError(
          'BUSINESS_CONFLICT',
          '执行没有从本固定复测组领取或开始的完整scope证据，不能改挂历史运行。',
          409,
        );
      const actual = scope.items.map(({ runItemId, ...item }) => item);
      if (
        canonicalJson(actual) !== canonicalJson(group.items) ||
        scope.environmentId !== group.environment.id ||
        scope.environmentRevisionId !== group.environment.revisionId ||
        scope.productBuild !== group.productBuild ||
        canonicalJson(scope.missingRequirements) !==
          canonicalJson(group.missingRequirements) ||
        canonicalJson(scope.retestContext) !== canonicalJson(group.context)
      )
        throw new DomainError(
          'BUSINESS_CONFLICT',
          '执行内容与固定复测组不一致，不能扩大或改挂。',
          409,
        );
      const prior = (
        await tx.query<{ group_id: string }>(
          'SELECT group_id FROM app.retest_group_runs WHERE run_id=$1',
          [input.runId],
        )
      ).rows[0];
      if (prior && prior.group_id !== groupId)
        throw new DomainError(
          'BUSINESS_CONFLICT',
          '该执行已关联另一固定复测组。',
          409,
        );
      if (!prior) {
        await tx.query(
          'INSERT INTO app.retest_group_runs(project_id,group_id,run_id) VALUES($1,$2,$3)',
          [projectId, groupId, input.runId],
        );
        await recordRetestVerifications(tx, projectId, input.runId);
        await audit(
          tx,
          actor,
          'retests.run-associated',
          input.runId,
          projectId,
          { groupId, snapshotDigest },
        );
      }
      return associateRetestRunReceiptSchema.parse({
        groupId,
        runId: input.runId,
        snapshotDigest,
        alreadyAssociated: Boolean(prior),
        businessStateUnchanged: true,
      });
    },
    projectId,
  );
}
