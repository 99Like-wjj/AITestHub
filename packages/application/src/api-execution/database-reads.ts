import { randomUUID } from 'node:crypto';
import {
  apiDatabaseReadRegisterSchema,
  apiDatabaseReadSchema,
  type ApiDatabaseReadDefinition,
} from '../../../contracts/src/api-database-reads.js';
import type { ActorContext } from '../../../contracts/src/identity.js';
import type {
  Database,
  SqlExecutor,
} from '../../../persistence/src/database.js';
import { requireProject } from '../access/policy.js';
import { DomainError } from '../errors.js';
import { OperationService } from '../operations/service.js';
import { interpolate, nonEmpty } from './expressions.js';

interface QueryRow {
  id: string;
  definition: unknown;
  created_at: Date;
}

const dto = (row: QueryRow) =>
  apiDatabaseReadSchema.parse({
    id: row.id,
    definition: row.definition,
    createdAt: row.created_at.toISOString(),
  });

export async function getApprovedApiDatabaseRead(
  transaction: SqlExecutor,
  projectId: string,
  queryId: string,
) {
  const found = (
    await transaction.query<QueryRow>(
      'SELECT id,definition,created_at FROM app.api_database_reads WHERE project_id=$1 AND id=$2',
      [projectId, queryId],
    )
  ).rows[0];
  if (!found)
    throw new DomainError(
      'NOT_FOUND',
      '未找到本项目已登记的只读数据库查询。',
      404,
    );
  return dto(found);
}

export class ApiDatabaseReadService {
  private readonly operations: OperationService;
  constructor(readonly db: Database) {
    this.operations = new OperationService(db);
  }

  async list(actor: ActorContext, projectId: string) {
    return this.db.transaction(async (tx) => {
      await requireProject(tx, actor, projectId, 'project.read');
      const rows = await tx.query<QueryRow>(
        'SELECT id,definition,created_at FROM app.api_database_reads WHERE project_id=$1 ORDER BY created_at DESC,id LIMIT 200',
        [projectId],
      );
      return { queries: rows.rows.map(dto) };
    });
  }

  async register(actor: ActorContext, projectId: string, raw: unknown) {
    const input = apiDatabaseReadRegisterSchema.parse(raw);
    return this.operations.execute(
      actor,
      'api-catalog.register-database-read',
      input.commandId,
      input,
      async (tx) => {
        await requireProject(tx, actor, projectId, 'test-configuration.write');
      },
      async (tx) => {
        const connection = await tx.query(
          "SELECT id FROM app.test_configurations WHERE project_id=$1 AND id=$2 AND kind='databaseConnection' AND active",
          [projectId, input.definition.connectionId],
        );
        if (!connection.rowCount)
          throw new DomainError(
            'PRECONDITIONS_MISSING',
            '请选择启用的项目测试数据库连接。',
            422,
          );
        const persisted = (
          await tx.query<QueryRow>(
            'INSERT INTO app.api_database_reads(id,project_id,configuration_id,definition,created_by) VALUES($1,$2,$3,$4,$5) RETURNING id,definition,created_at',
            [
              randomUUID(),
              projectId,
              input.definition.connectionId,
              input.definition,
              actor.userId,
            ],
          )
        ).rows[0];
        if (!persisted)
          throw new Error('Database observation definition was not persisted');
        return dto(persisted);
      },
      projectId,
    );
  }
}

export function compileApiDatabaseRead(
  driver: 'postgresql' | 'mysql',
  definition: ApiDatabaseReadDefinition,
  bindings: Readonly<Record<string, string>>,
  context: unknown,
) {
  const quote = (value: string) =>
    driver === 'postgresql' ? '"' + value + '"' : '\x60' + value + '\x60';
  const table = definition.namespace
    ? quote(definition.namespace) + '.' + quote(definition.table)
    : quote(definition.table);
  const values = definition.filters.map(({ parameter }) => {
    const binding = Object.prototype.hasOwnProperty.call(bindings, parameter)
      ? bindings[parameter]
      : undefined;
    const value = binding === undefined ? null : interpolate(binding, context);
    if (!nonEmpty(value))
      throw new DomainError(
        'PRECONDITIONS_MISSING',
        '查询参数缺少明确非空值。',
        422,
      );
    return value;
  });
  if (Object.keys(bindings).length !== values.length)
    throw new DomainError(
      'VALIDATION_ERROR',
      '查询参数与已登记定义不匹配。',
      400,
    );
  const where = definition.filters
    .map(
      (filter, index) =>
        quote(filter.column) +
        ' = ' +
        (driver === 'postgresql' ? '$' + (index + 1) : '?'),
    )
    .join(' AND ');
  return {
    statement: `SELECT ${definition.columns.map(quote).join(', ')} FROM ${table} WHERE ${where} LIMIT ${definition.limit}`,
    values,
  };
}
