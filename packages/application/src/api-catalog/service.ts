import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  apiCatalogCreateInputSchema,
  apiCatalogCloneDraftInputSchema,
  apiCatalogDiagnosticDraftInputSchema,
  apiCatalogExportInputSchema,
  apiCatalogGetInputSchema,
  apiCatalogGetResultSchema,
  apiCatalogImportApplyInputSchema,
  apiCatalogImportCandidateSchema,
  apiCatalogImportPreviewInputSchema,
  apiCatalogImportPreviewResultSchema,
  apiCatalogListInputSchema,
  apiCatalogListResultSchema,
  apiCatalogMockInputSchema,
  apiCatalogNodeSchema,
  apiCatalogOrganizeInputSchema,
  apiCatalogReviseInputSchema,
  apiCatalogRevisionSchema,
  apiCatalogRevisionSummarySchema,
  apiInterfaceDefinitionSchema,
  type ApiCatalogImportCandidate,
  type ApiCatalogImportPreviewInput,
  type ApiCatalogNode,
  type ApiInterfaceDefinition,
  type ApiInterfaceRevision,
} from '../../../contracts/src/api-catalog.js';
import {
  apiNoStages,
  apiStageSettingsSchema,
  type ApiCatalogStageProvider,
} from '../../../contracts/src/api-stage-actions.js';
import { idSchema } from '../../../contracts/src/base.js';
import type { ActorContext } from '../../../contracts/src/identity.js';
import type {
  Database,
  SqlExecutor,
} from '../../../persistence/src/database.js';
import {
  listProjectAccess,
  requireProject,
  requireProjectDraftWrite,
} from '../access/policy.js';
import {
  applyStageSuppressions,
  localStageSettings,
  requireValidStageSettings,
} from '../api-execution/stage-actions.js';
import { DomainError, stale } from '../errors.js';
import { audit } from '../events.js';
import { canonicalJson, OperationService } from '../operations/service.js';
import {
  assertNativeDefinition,
  parseApiCatalogDocument,
} from './documents.js';
import { exportApiInterface, simulateApiInterface } from './representations.js';
import {
  catalogDraftFromDiagnostic,
  catalogDraftFromRevision,
  readCatalogDiagnosticSource,
} from './source-drafts.js';

type Db = Pick<Database, 'transaction' | 'query'>;
type CatalogKind = ApiCatalogNode['kind'];
type NodeRow = {
  id: string;
  project_id: string;
  kind: CatalogKind;
  parent_id: string | null;
  title: string;
  position: number;
  row_version: number;
  archived_at: Date | null;
  updated_at: Date;
  current_revision_id: string | null;
  revision_number: number;
  service_key: string | null;
  method: ApiInterfaceDefinition['method'] | null;
  route_key: string | null;
  definition: unknown;
  stage_settings: unknown;
};
type RevisionRow = {
  id: string;
  node_id: string;
  title: string;
  revision_number: number;
  definition: unknown;
  stage_providers: unknown;
  created_at: Date;
  created_by: string;
};
type ImportField = z.infer<
  typeof apiCatalogImportCandidateSchema.shape.changedFields.element
>;

const selectedNode =
  'SELECT n.*,r.definition FROM app.api_catalog_nodes n LEFT JOIN app.api_interface_revisions r ON r.project_id=n.project_id AND r.node_id=n.id AND r.id=n.current_revision_id';
const selectedIndexNode =
  "SELECT n.id,n.project_id,n.kind,n.parent_id,n.title,n.position,n.row_version,n.archived_at,n.updated_at,n.current_revision_id,n.revision_number,n.service_key,n.method,n.route_key,CASE WHEN r.id IS NOT NULL THEN jsonb_build_object('path',r.definition->'path','status',r.definition->'status','tags',r.definition->'tags') END AS definition FROM app.api_catalog_nodes n LEFT JOIN app.api_interface_revisions r ON r.project_id=n.project_id AND r.node_id=n.id AND r.id=n.current_revision_id";
const digest = (value: string) =>
  createHash('sha256').update(value).digest('hex');
const missing = (message = '未找到当前项目中的接口目录对象。'): never => {
  throw new DomainError('NOT_FOUND', message, 404);
};
const blocked = (message: string): never => {
  throw new DomainError('PRECONDITIONS_MISSING', message, 422);
};
const invalid = (message: string): never => {
  throw new DomainError('VALIDATION_ERROR', message, 400);
};
const conflict = (message: string): never => {
  throw new DomainError('BUSINESS_CONFLICT', message, 409);
};
const routeKey = (path: string) =>
  path
    .replace(/\{[a-zA-Z_][a-zA-Z0-9_.-]*\}/gu, '{}')
    .replace(/%[\da-f]{2}/giu, (part) => {
      const character = String.fromCharCode(Number.parseInt(part.slice(1), 16));
      return /^[a-zA-Z0-9._~-]$/u.test(character)
        ? character
        : part.toUpperCase();
    });
const routeIdentity = (
  serviceKey: string | null,
  method: string | null,
  key: string | null,
) => canonicalJson([serviceKey, method, key]);

function nodeDto(row: Omit<NodeRow, 'stage_settings'>): ApiCatalogNode {
  // Descending the catalog only needs index metadata, not parsing every full schema.
  const def = z
    .object({
      path: z.string(),
      status: z.enum(['draft', 'active', 'deprecated']),
      tags: z.array(z.string()),
    })
    .nullable()
    .parse(row.definition);
  return apiCatalogNodeSchema.parse({
    id: row.id,
    projectId: row.project_id,
    kind: row.kind,
    parentId: row.parent_id,
    title: row.title,
    position: row.position,
    rowVersion: row.row_version,
    archivedAt: row.archived_at?.toISOString() ?? null,
    updatedAt: row.updated_at.toISOString(),
    currentRevisionId: row.current_revision_id,
    revisionNumber: row.revision_number,
    serviceKey: row.service_key,
    method: row.method,
    path: def?.path ?? null,
    status: def?.status ?? null,
    tags: def?.tags ?? [],
  });
}

function revisionSummary(
  row: Omit<RevisionRow, 'definition' | 'stage_providers'>,
) {
  return apiCatalogRevisionSummarySchema.parse({
    id: row.id,
    nodeId: row.node_id,
    title: row.title,
    revisionNumber: row.revision_number,
    createdAt: row.created_at.toISOString(),
    createdBy: row.created_by,
  });
}

export async function requireApiInterfaceRevision(
  tx: SqlExecutor,
  projectId: string,
  nodeId: string,
  revisionId: string,
): Promise<ApiInterfaceRevision> {
  const row = (
    await tx.query<RevisionRow>(
      'SELECT id,node_id,title,definition,stage_providers,revision_number,created_at,created_by FROM app.api_interface_revisions WHERE project_id=$1 AND node_id=$2 AND id=$3',
      [projectId, nodeId, revisionId],
    )
  ).rows[0];
  if (!row) return missing('未找到指定项目、接口及修订对应的定义。');
  return apiCatalogRevisionSchema.parse({
    ...revisionSummary(row),
    definition: row.definition,
    stageProviders: row.stage_providers,
  });
}

async function requireNode(
  tx: SqlExecutor,
  projectId: string,
  id: string,
): Promise<NodeRow> {
  const row = (
    await tx.query<NodeRow>(
      selectedNode + ' WHERE n.project_id=$1 AND n.id=$2',
      [projectId, id],
    )
  ).rows[0];
  if (!row) return missing();
  return row;
}

async function directoryProviders(
  tx: SqlExecutor,
  projectId: string,
  directory: NodeRow | null,
): Promise<ApiCatalogStageProvider[]> {
  if (!directory) return [];
  const chain = directory.parent_id
    ? [await requireNode(tx, projectId, directory.parent_id), directory]
    : [directory];
  return chain.map((row) => {
    if (row.kind === 'interface')
      return invalid('上级必须为产品模块或功能目录。');
    return {
      kind: row.kind,
      projectId,
      id: row.id,
      title: row.title,
      rowVersion: row.row_version,
      settings: apiStageSettingsSchema.parse(row.stage_settings),
    };
  });
}

function effectiveProviders(
  providers: ApiCatalogStageProvider[],
): ApiCatalogStageProvider[] {
  let effective: ApiCatalogStageProvider[] = [];
  for (const provider of providers) {
    effective = applyStageSuppressions(effective, provider.settings.suppress);
    effective.push({
      ...provider,
      settings: localStageSettings(provider.settings),
    });
  }
  return effective;
}

async function interfaceStageProviders(
  tx: SqlExecutor,
  projectId: string,
  folder: NodeRow | null,
  interfaceId: string,
  revisionId: string,
  title: string,
  definition: ApiInterfaceDefinition,
): Promise<ApiCatalogStageProvider[]> {
  const inherited = await directoryProviders(tx, projectId, folder);
  if (!definition.stageSettings) return effectiveProviders(inherited);
  await requireValidStageSettings(tx, projectId, definition.stageSettings);
  return effectiveProviders([
    ...inherited,
    {
      kind: 'interface',
      projectId,
      id: interfaceId,
      title,
      revisionId,
      settings: definition.stageSettings,
    },
  ]);
}

async function checkParent(
  tx: SqlExecutor,
  projectId: string,
  kind: CatalogKind,
  parentId: string | null,
) {
  if (kind === 'module') {
    if (parentId !== null) invalid('产品模块必须位于项目根目录。');
    return null;
  }
  if (!parentId) return invalid('请选择有效的上级目录。');
  const parent = await requireNode(tx, projectId, parentId);
  if (
    parent.kind !== (kind === 'folder' ? 'module' : 'folder') ||
    parent.archived_at
  )
    blocked('上级目录类型不匹配或已归档。');
  return parent;
}

async function checkRoute(
  tx: SqlExecutor,
  projectId: string,
  definition: ApiInterfaceDefinition,
  exceptId: string | null,
) {
  const present = (
    await tx.query(
      "SELECT id FROM app.api_catalog_nodes WHERE project_id=$1 AND service_key=$2 AND method=$3 AND route_key=$4 AND kind='interface' AND archived_at IS NULL AND ($5::uuid IS NULL OR id<>$5)",
      [
        projectId,
        definition.serviceKey,
        definition.method,
        routeKey(definition.path),
        exceptId,
      ],
    )
  ).rows[0];
  if (present) conflict('此服务中的方法和路径已由其他接口使用。');
}

async function inspectDefinitions(
  tx: SqlExecutor,
  projectId: string,
  definition: ApiInterfaceDefinition,
  previousBasis: ApiInterfaceDefinition['basisRefs'] = [],
) {
  assertNativeDefinition(definition);
  if (definition.ownerId) {
    const owner = (
      await tx.query(
        'SELECT 1 FROM app.project_members m JOIN app.users u ON u.id=m.user_id WHERE m.project_id=$1 AND m.user_id=$2 AND m.active AND u.active FOR SHARE OF m,u',
        [projectId, definition.ownerId],
      )
    ).rows[0];
    if (!owner) blocked('接口负责人必须是当前有效项目成员。');
  }
  if (definition.auth.mode === 'purpose') {
    const purpose = (
      await tx.query(
        "SELECT 1 FROM app.test_configurations WHERE project_id=$1 AND id=$2 AND active AND kind='purpose' FOR SHARE",
        [projectId, definition.auth.purposeId],
      )
    ).rows[0];
    if (!purpose) blocked('找不到当前项目中有效的账号用途。');
  }
  if (definition.requirementVersionId) {
    const version = (
      await tx.query(
        'SELECT 1 FROM app.requirement_versions WHERE project_id=$1 AND id=$2',
        [projectId, definition.requirementVersionId],
      )
    ).rows[0];
    if (!version) blocked('所关联的需求版本不属于当前项目或不存在。');
  }
  const known = new Set(previousBasis.map(canonicalJson));
  await checkBasis(
    tx,
    projectId,
    definition.basisRefs.filter(
      (item) => item.kind !== 'diagnostic' || !known.has(canonicalJson(item)),
    ),
  );
}

async function checkBasis(
  tx: SqlExecutor,
  projectId: string,
  items: ApiInterfaceDefinition['basisRefs'],
  inputHash?: string,
) {
  for (const item of items) {
    if (item.kind === 'diagnostic') {
      await readCatalogDiagnosticSource(tx, projectId, item);
      continue;
    }
    if (item.kind === 'interfaceRevision') {
      await requireApiInterfaceRevision(
        tx,
        projectId,
        item.interfaceId,
        item.revisionId,
      );
      continue;
    }
    if (item.kind !== 'material') continue;
    const match = (
      await tx.query<{ sha256: string | null }>(
        "SELECT f.declared_sha256 AS sha256 FROM app.requirement_versions rv CROSS JOIN LATERAL jsonb_array_elements(rv.materials) m LEFT JOIN app.file_resources f ON f.project_id=rv.project_id AND f.id::text=m->>'fileResourceId' AND f.status='verified' AND f.deleted_at IS NULL WHERE rv.project_id=$1 AND rv.id=$2 AND m->>'id'=$3",
        [projectId, item.requirementVersionId, item.materialId],
      )
    ).rows[0];
    if (!match) return blocked('无法读取当前项目的需求材料。');
    if (item.contentSha256 && item.contentSha256 !== match.sha256)
      blocked('需求材料摘要与已校验文件不一致。');
    if (inputHash !== undefined && inputHash !== match.sha256)
      blocked('本次导入文本与已校验需求材料的字节摘要不一致。');
  }
}

async function issueRevision(
  tx: SqlExecutor,
  projectId: string,
  id: string,
  revisionId: string,
  revisionNumber: number,
  actor: ActorContext,
  definition: ApiInterfaceDefinition,
  title: string,
  parent: NodeRow | null,
) {
  const stages = await interfaceStageProviders(
    tx,
    projectId,
    parent,
    id,
    revisionId,
    title,
    definition,
  );
  await tx.query(
    'INSERT INTO app.api_interface_revisions (id,project_id,node_id,revision_number,definition,created_by,title,stage_providers) VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8::jsonb)',
    [
      revisionId,
      projectId,
      id,
      revisionNumber,
      canonicalJson(definition),
      actor.userId,
      title,
      canonicalJson(stages),
    ],
  );
}

async function createNode(
  tx: SqlExecutor,
  actor: ActorContext,
  projectId: string,
  input: z.infer<typeof apiCatalogCreateInputSchema>,
): Promise<ApiCatalogNode> {
  const id = randomUUID();
  const parentId = input.kind === 'module' ? null : input.parentId;
  const parent = await checkParent(tx, projectId, input.kind, parentId);
  const definition = input.kind === 'interface' ? input.definition : null;
  const directoryStages =
    input.kind === 'interface'
      ? apiNoStages
      : (input.directoryStages ?? apiNoStages);
  const revisionId = definition ? randomUUID() : null;
  if (definition) {
    await inspectDefinitions(tx, projectId, definition);
    await checkRoute(tx, projectId, definition, null);
  }
  if (input.kind !== 'interface' && input.directoryStages) {
    await requireValidStageSettings(tx, projectId, directoryStages);
    applyStageSuppressions(
      effectiveProviders(await directoryProviders(tx, projectId, parent)),
      directoryStages.suppress,
    );
  }
  await tx.query(
    'INSERT INTO app.api_catalog_nodes (id,project_id,kind,parent_id,parent_kind,title,position,current_revision_id,revision_number,service_key,method,route_key,created_by,stage_settings) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb)',
    [
      id,
      projectId,
      input.kind,
      parentId,
      parent?.kind ?? null,
      input.title,
      input.position ?? 0,
      revisionId,
      definition ? 1 : 0,
      definition?.serviceKey ?? null,
      definition?.method ?? null,
      definition ? routeKey(definition.path) : null,
      actor.userId,
      canonicalJson(directoryStages),
    ],
  );
  if (revisionId && definition)
    await issueRevision(
      tx,
      projectId,
      id,
      revisionId,
      1,
      actor,
      definition,
      input.title,
      parent,
    );
  await audit(tx, actor, 'api-catalog.created', id, projectId, {
    kind: input.kind,
    parentId,
    revisionId,
  });
  return nodeDto(await requireNode(tx, projectId, id));
}

async function reviseNode(
  tx: SqlExecutor,
  actor: ActorContext,
  projectId: string,
  current: NodeRow,
  definition: ApiInterfaceDefinition,
  title?: string,
  restoredFrom?: ApiInterfaceRevision,
): Promise<ApiCatalogNode> {
  if (current.kind !== 'interface')
    return invalid('只有接口可以保存定义修订。');
  if (current.archived_at) blocked('归档接口应在恢复后再修订。');
  await inspectDefinitions(tx, projectId, definition, [
    ...apiInterfaceDefinitionSchema.parse(current.definition).basisRefs,
    ...(restoredFrom?.definition.basisRefs ?? []),
  ]);
  await checkRoute(tx, projectId, definition, current.id);
  const number = current.revision_number + 1;
  const revisionId = randomUUID();
  const parent = await checkParent(
    tx,
    projectId,
    current.kind,
    current.parent_id,
  );
  await issueRevision(
    tx,
    projectId,
    current.id,
    revisionId,
    number,
    actor,
    definition,
    title ?? current.title,
    parent,
  );
  await tx.query(
    'UPDATE app.api_catalog_nodes SET current_revision_id=$3,revision_number=$4,service_key=$5,method=$6,route_key=$7,title=COALESCE($8,title),row_version=row_version+1,updated_at=clock_timestamp() WHERE project_id=$1 AND id=$2',
    [
      projectId,
      current.id,
      revisionId,
      number,
      definition.serviceKey,
      definition.method,
      routeKey(definition.path),
      title ?? null,
    ],
  );
  await audit(tx, actor, 'api-catalog.revised', current.id, projectId, {
    revisionId,
    revisionNumber: number,
    ...(restoredFrom ? { restoredFromRevisionId: restoredFrom.id } : {}),
  });
  return nodeDto(await requireNode(tx, projectId, current.id));
}

const allImportFields: ImportField[] = [
  'title',
  'path',
  'description',
  'tags',
  'parameters',
  'requestBodies',
  'responses',
  'models',
  'basisRefs',
];

function proposedDefinition(
  current: NodeRow | undefined,
  input: ApiInterfaceDefinition,
  format: ApiCatalogImportPreviewInput['format'],
) {
  if (!current) return input;
  const base = apiInterfaceDefinitionSchema.parse(current.definition);
  const next = {
    ...base,
    path: input.path,
    description: input.description,
    tags: input.tags,
    parameters: input.parameters,
    requestBodies: input.requestBodies,
    responses: input.responses,
    models: input.models,
    basisRefs: [
      ...new Map(
        [...base.basisRefs, ...input.basisRefs].map((ref) => [
          canonicalJson(ref),
          ref,
        ]),
      ).values(),
    ],
  };
  if (format !== 'openapi' && format !== 'swagger') {
    next.description = base.description;
    next.tags = base.tags;
    next.models = base.models;
    if (!input.responses.length) next.responses = base.responses;
    if (!input.requestBodies.length) next.requestBodies = base.requestBodies;
  }
  return next;
}

async function previewImport(
  tx: SqlExecutor,
  projectId: string,
  input: ApiCatalogImportPreviewInput,
) {
  const folder = await checkParent(tx, projectId, 'interface', input.folderId);
  const { definitions, warnings } = parseApiCatalogDocument(input);
  if (input.basis)
    await checkBasis(tx, projectId, [input.basis], digest(input.document));
  const counts = new Map<string, number>();
  const keyOf = (value: { definition: ApiInterfaceDefinition }) =>
    routeIdentity(
      value.definition.serviceKey,
      value.definition.method,
      routeKey(value.definition.path),
    );
  for (const candidate of definitions) {
    const key = keyOf(candidate);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const matching = (
    await tx.query<NodeRow>(
      selectedNode +
        " WHERE n.project_id=$1 AND n.kind='interface' AND n.service_key=$2 AND n.archived_at IS NULL AND n.route_key=ANY($3::text[])",
      [
        projectId,
        input.serviceKey,
        definitions.map(({ definition }) => routeKey(definition.path)),
      ],
    )
  ).rows;
  const lookup = new Map(
    matching.map((row) => [
      routeIdentity(row.service_key, row.method, row.route_key),
      row,
    ]),
  );
  const candidates: ApiCatalogImportCandidate[] = definitions.map(
    ({ title, definition }) => {
      const key = keyOf({ definition });
      const previous = lookup.get(key);
      const next = proposedDefinition(previous, definition, input.format);
      const parsed = apiInterfaceDefinitionSchema.safeParse(next);
      const prior = previous
        ? apiInterfaceDefinitionSchema.parse(previous.definition)
        : undefined;
      const changedFields = prior
        ? allImportFields.filter((field) => {
            if (field === 'title') return title !== previous?.title;
            return canonicalJson(next[field]) !== canonicalJson(prior[field]);
          })
        : allImportFields;
      let operation: ApiCatalogImportCandidate['operation'] = 'create';
      if (counts.get(key) !== 1 || !parsed.success) operation = 'conflict';
      else if (previous) operation = changedFields.length ? 'revise' : 'skip';
      return {
        title,
        definition: parsed.success ? parsed.data : definition,
        operation,
        existing: previous ? nodeDto(previous) : null,
        changedFields,
      };
    },
  );
  const result = {
    candidates,
    warnings,
    digest: digest(
      canonicalJson({
        projectId,
        folder: { id: input.folderId, rowVersion: folder?.row_version ?? 0 },
        serviceKey: input.serviceKey,
        document: digest(input.document),
        candidates,
        warnings,
      }),
    ),
  };
  return apiCatalogImportPreviewResultSchema.parse(result);
}

export class ApiCatalogService {
  readonly #operations: OperationService;
  constructor(private readonly db: Db) {
    this.#operations = new OperationService(db);
  }

  private write<T>(
    actor: ActorContext,
    projectId: string,
    operation: string,
    input: { commandId: string },
    work: (tx: SqlExecutor) => Promise<T>,
    requiresBusinessRole = false,
  ): Promise<T> {
    return this.#operations.execute(
      actor,
      'api-catalog.' + operation,
      input.commandId,
      input,
      async (tx) => {
        const authorize = requiresBusinessRole
          ? requireProject
          : requireProjectDraftWrite;
        await authorize(tx, actor, projectId, 'assets.write');
        // A project-scoped catalog lock keeps compound path and archive/move checks consistent.
        await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
          'api-catalog:' + projectId,
        ]);
      },
      work,
      projectId,
    );
  }

  async list(actor: ActorContext, projectId: string, raw: unknown = {}) {
    const input = apiCatalogListInputSchema.parse(raw);
    return this.db.transaction(async (tx) => {
      await requireProject(tx, actor, projectId, 'project.read');
      const rows = (
        await tx.query<NodeRow>(
          selectedIndexNode +
            ' WHERE n.project_id=$1 AND ($2::bool OR n.archived_at IS NULL) ORDER BY n.position,n.title,n.id LIMIT 10001',
          [projectId, input.includeArchived === true],
        )
      ).rows;
      if (rows.length > 10000) blocked('项目接口目录超过单次读取上限。');
      const nodes = rows.map(nodeDto);
      const term = input.query?.toLocaleLowerCase();
      if (!term && !input.method && !input.status && !input.tag)
        return apiCatalogListResultSchema.parse({ nodes });
      const filtered = Boolean(input.method || input.status || input.tag);
      const byId = new Map(nodes.map((node) => [node.id, node]));
      const include = new Set<string>();
      for (const node of nodes) {
        if (
          filtered &&
          (node.kind !== 'interface' ||
            (input.method && node.method !== input.method) ||
            (input.status && node.status !== input.status) ||
            (input.tag && !node.tags.includes(input.tag)))
        )
          continue;
        const path: ApiCatalogNode[] = [];
        for (
          let parent: ApiCatalogNode | undefined = node;
          parent;
          parent = parent.parentId ? byId.get(parent.parentId) : undefined
        )
          path.push(parent);
        const searchable = [
          ...path.map((item) => item.title),
          node.id,
          node.method,
          node.path,
          node.serviceKey,
          ...node.tags,
        ]
          .filter(Boolean)
          .join(' ')
          .toLocaleLowerCase();
        if (term && !searchable.includes(term)) continue;
        path.forEach((item) => include.add(item.id));
      }
      return apiCatalogListResultSchema.parse({
        nodes: nodes.filter((node) => include.has(node.id)),
      });
    });
  }

  async get(
    actor: ActorContext,
    projectId: string,
    id: string,
    raw: unknown = {},
  ) {
    const input = apiCatalogGetInputSchema.parse(raw);
    idSchema.parse(id);
    return this.db.transaction(async (tx) => {
      await requireProject(tx, actor, projectId, 'project.read');
      const row = await requireNode(tx, projectId, id);
      const selected = input.revisionId ?? row.current_revision_id;
      const revision = selected
        ? await requireApiInterfaceRevision(tx, projectId, id, selected)
        : null;
      const revisions = revision
        ? (
            await tx.query<Omit<RevisionRow, 'definition' | 'stage_providers'>>(
              'SELECT id,node_id,title,revision_number,created_at,created_by FROM app.api_interface_revisions WHERE project_id=$1 AND node_id=$2 ORDER BY revision_number DESC LIMIT 200',
              [projectId, id],
            )
          ).rows.map(revisionSummary)
        : [];
      const usage = revision
        ? (
            await tx.query<{
              project_id: string;
              case_id: string;
              title: string;
              case_revision_id: string;
              interface_revision_id: string;
              standalone: boolean;
            }>(
              "SELECT DISTINCT a.project_id,a.id AS case_id,ar.content->>'title' AS title,ar.id AS case_revision_id,ref.source->>'revisionId' AS interface_revision_id,a.parent_id IS NULL AS standalone FROM app.test_assets a JOIN app.asset_revisions ar ON ar.id=a.current_revision_id CROSS JOIN LATERAL jsonb_path_query(ar.content,'lax $.**.source') AS ref(source) WHERE a.project_id=ANY($4::uuid[]) AND a.kind='API' AND a.target_type='case' AND a.set_id IS NULL AND a.removed_at IS NULL AND ref.source->>'projectId'=$1::uuid::text AND ref.source->>'interfaceId'=$2::text AND ($3::text IS NULL OR ref.source->>'revisionId'=$3) ORDER BY a.project_id,title,a.id,interface_revision_id LIMIT 200",
              [
                projectId,
                id,
                input.revisionId ?? null,
                (await listProjectAccess(tx, actor)).map(
                  (project) => project.id,
                ),
              ],
            )
          ).rows.map((item) => ({
            projectId: item.project_id,
            caseId: item.case_id,
            caseType: item.standalone ? 'single' : 'scenario',
            title: item.title,
            caseRevisionId: item.case_revision_id,
            interfaceRevisionId: item.interface_revision_id,
          }))
        : [];
      return apiCatalogGetResultSchema.parse({
        node: nodeDto(row),
        directoryStages:
          row.kind === 'interface'
            ? null
            : apiStageSettingsSchema.parse(row.stage_settings),
        directoryProviders: await directoryProviders(
          tx,
          projectId,
          row.kind !== 'interface'
            ? row
            : row.parent_id
              ? await requireNode(tx, projectId, row.parent_id)
              : null,
        ),
        revision,
        revisions,
        usage,
      });
    });
  }

  create(actor: ActorContext, projectId: string, raw: unknown) {
    const input = apiCatalogCreateInputSchema.parse(raw);
    return this.write(actor, projectId, 'create', input, (tx) =>
      createNode(tx, actor, projectId, input),
    );
  }

  organize(actor: ActorContext, projectId: string, raw: unknown) {
    const input = apiCatalogOrganizeInputSchema.parse(raw);
    return this.write(
      actor,
      projectId,
      'organize',
      input,
      async (tx) => {
        const current = await requireNode(tx, projectId, input.id);
        if (current.archived_at)
          await requireProject(tx, actor, projectId, 'assets.write');
        if (current.row_version !== input.rowVersion) stale();
        const parentId = input.parentId ?? current.parent_id;
        const parent = await checkParent(tx, projectId, current.kind, parentId);
        if (current.kind === 'interface' && input.directoryStages)
          invalid('接口动作须通过新增定义修订保存。');
        if (
          current.kind !== 'interface' &&
          (input.directoryStages || parentId !== current.parent_id)
        ) {
          const settings =
            input.directoryStages ??
            apiStageSettingsSchema.parse(current.stage_settings);
          await requireValidStageSettings(tx, projectId, settings);
          applyStageSuppressions(
            effectiveProviders(await directoryProviders(tx, projectId, parent)),
            settings.suppress,
          );
        }
        const archive = input.archived ?? Boolean(current.archived_at);
        if (archive && !current.archived_at) {
          const child = (
            await tx.query(
              'SELECT id FROM app.api_catalog_nodes WHERE project_id=$1 AND parent_id=$2 AND archived_at IS NULL LIMIT 1',
              [projectId, input.id],
            )
          ).rows[0];
          if (child) blocked('请先移动或归档目录中的现有对象。');
        }
        if (!archive && current.archived_at && current.kind === 'interface') {
          await checkRoute(
            tx,
            projectId,
            apiInterfaceDefinitionSchema.parse(current.definition),
            current.id,
          );
        }
        await tx.query(
          'UPDATE app.api_catalog_nodes SET parent_id=$3,parent_kind=$4,title=COALESCE($5,title),position=COALESCE($6,position),archived_at=CASE WHEN $7 THEN COALESCE(archived_at,clock_timestamp()) ELSE NULL END,stage_settings=COALESCE($8::jsonb,stage_settings),row_version=row_version+1,updated_at=clock_timestamp() WHERE project_id=$1 AND id=$2',
          [
            projectId,
            input.id,
            parentId,
            parent?.kind ?? null,
            input.title ?? null,
            input.position ?? null,
            archive,
            input.directoryStages ? canonicalJson(input.directoryStages) : null,
          ],
        );
        await audit(tx, actor, 'api-catalog.organized', current.id, projectId, {
          parentId,
          previousParentId: current.parent_id,
          archived: archive,
          directoryStagesChanged: input.directoryStages !== undefined,
        });
        return nodeDto(await requireNode(tx, projectId, current.id));
      },
      input.archived !== undefined,
    );
  }

  revise(actor: ActorContext, projectId: string, raw: unknown) {
    const input = apiCatalogReviseInputSchema.parse(raw);
    return this.write(actor, projectId, 'revise', input, async (tx) => {
      const row = await requireNode(tx, projectId, input.id);
      if (
        row.row_version !== input.rowVersion ||
        row.current_revision_id !== input.baseRevisionId
      )
        stale();
      let restoredFrom: ApiInterfaceRevision | undefined;
      if (input.restoredFromRevisionId) {
        if (input.restoredFromRevisionId === input.baseRevisionId)
          invalid('还原来源须为该接口的历史修订。');
        restoredFrom = await requireApiInterfaceRevision(
          tx,
          projectId,
          row.id,
          input.restoredFromRevisionId,
        );
      }
      return reviseNode(
        tx,
        actor,
        projectId,
        row,
        input.definition,
        undefined,
        restoredFrom,
      );
    });
  }

  previewDiagnostic(actor: ActorContext, projectId: string, raw: unknown) {
    const { serviceKey, ...origin } =
      apiCatalogDiagnosticDraftInputSchema.parse(raw);
    return this.db.transaction(async (tx) => {
      await requireProject(tx, actor, projectId, 'project.read');
      const source = await readCatalogDiagnosticSource(tx, projectId, origin);
      return catalogDraftFromDiagnostic(source, origin, serviceKey);
    });
  }

  previewClone(actor: ActorContext, projectId: string, raw: unknown) {
    const source = apiCatalogCloneDraftInputSchema.parse(raw);
    return this.db.transaction(async (tx) => {
      await requireProject(tx, actor, projectId, 'project.read');
      const revision = await requireApiInterfaceRevision(
        tx,
        projectId,
        source.interfaceId,
        source.revisionId,
      );
      return catalogDraftFromRevision(revision);
    });
  }

  async previewImport(actor: ActorContext, projectId: string, raw: unknown) {
    const input = apiCatalogImportPreviewInputSchema.parse(raw);
    return this.db.transaction(async (tx) => {
      await requireProjectDraftWrite(tx, actor, projectId, 'assets.write');
      return previewImport(tx, projectId, input);
    });
  }

  applyImport(actor: ActorContext, projectId: string, raw: unknown) {
    const input = apiCatalogImportApplyInputSchema.parse(raw);
    const { document, ...fingerprint } = input;
    const identity = { ...fingerprint, documentSha256: digest(document) };
    return this.write(
      actor,
      projectId,
      'apply-import',
      identity,
      async (tx) => {
        const checked = await previewImport(tx, projectId, input);
        if (checked.digest !== input.digest) stale();
        if (
          new Set(input.selections.map((item) => item.index)).size !==
          input.selections.length
        )
          invalid('请选择互异的接口候选项。');
        const nodes: ApiCatalogNode[] = [];
        for (const selected of input.selections) {
          const candidate = checked.candidates[selected.index];
          if (
            !candidate ||
            candidate.operation === 'conflict' ||
            candidate.operation === 'skip'
          )
            return blocked('所选接口已变化、无差异或存在冲突，请重新预览。');
          const fields = selected.fields ?? candidate.changedFields;
          if (
            new Set(fields).size !== fields.length ||
            fields.some((field) => !candidate.changedFields.includes(field))
          )
            invalid('请选择本次预览中的变更字段。');
          if (candidate.operation === 'create') {
            if (selected.fields) invalid('新建接口应采纳完整定义。');
            nodes.push(
              await createNode(tx, actor, projectId, {
                commandId: input.commandId,
                kind: 'interface',
                title: candidate.title,
                parentId: input.folderId,
                definition: candidate.definition,
              }),
            );
          } else {
            if (!candidate.existing)
              return conflict('待更新的接口不存在，请重新预览。');
            const row = await requireNode(tx, projectId, candidate.existing.id);
            if (row.row_version !== candidate.existing.rowVersion) stale();
            const base = apiInterfaceDefinitionSchema.parse(row.definition);
            const change = Object.fromEntries(
              fields
                .filter((field) => field !== 'title')
                .map((field) => [
                  field,
                  candidate.definition[field as Exclude<ImportField, 'title'>],
                ]),
            );
            const definition = apiInterfaceDefinitionSchema.parse({
              ...base,
              ...change,
            });
            nodes.push(
              await reviseNode(
                tx,
                actor,
                projectId,
                row,
                definition,
                fields.includes('title') ? candidate.title : undefined,
              ),
            );
          }
        }
        return apiCatalogListResultSchema.parse({ nodes });
      },
    );
  }

  async exportDefinition(
    actor: ActorContext,
    projectId: string,
    id: string,
    raw: unknown,
  ) {
    const input = apiCatalogExportInputSchema.parse(raw);
    return this.db.transaction(async (tx) => {
      await requireProject(tx, actor, projectId, 'project.read');
      const row = await requireNode(tx, projectId, id);
      const revisionId = input.revisionId ?? row.current_revision_id;
      if (!revisionId) return blocked('目录不包含可导出的接口定义。');
      const revision = await requireApiInterfaceRevision(
        tx,
        projectId,
        id,
        revisionId,
      );
      return exportApiInterface(
        input.revisionId ? revision.title : row.title,
        revision,
        input.format,
      );
    });
  }

  async previewMock(
    actor: ActorContext,
    projectId: string,
    id: string,
    raw: unknown,
  ) {
    const input = apiCatalogMockInputSchema.parse(raw);
    if (Buffer.byteLength(JSON.stringify(input)) > 1024 * 1024)
      invalid('Mock 输入超过 1 MiB。');
    if (
      Object.keys(input.headers).some((name) =>
        /^(?:authorization|proxy-authorization|cookie|x-api-key|api-key)$/iu.test(
          name,
        ),
      )
    )
      invalid('Mock 请求请使用合成输入。此处不接收认证头。');
    return this.db.transaction(async (tx) => {
      await requireProject(tx, actor, projectId, 'project.read');
      const row = await requireNode(tx, projectId, id);
      const revisionId = input.revisionId ?? row.current_revision_id;
      if (!revisionId) return blocked('目录不含可模拟的接口定义。');
      const revision = await requireApiInterfaceRevision(
        tx,
        projectId,
        id,
        revisionId,
      );
      return simulateApiInterface(revision, input);
    });
  }
}
