import sqlParser from 'node-sql-parser';
import { z } from 'zod';
import { DomainError } from '../errors.js';
import { nonEmpty, readPath } from './expressions.js';

const parser = new sqlParser.Parser();
const identifier = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;
const fromSchema = z.strictObject({
  db: z.null(),
  schema: z.null().optional(),
  table: z.string().regex(identifier),
  as: z.null(),
  addition: z.boolean().optional(),
});
const deleteSchema = z.strictObject({
  type: z.literal('delete'),
  table: z.array(fromSchema).length(1),
  from: z.array(fromSchema).length(1),
  where: z.unknown(),
  with: z.null().optional(),
  orderby: z.null().optional(),
  limit: z.null().optional(),
  returning: z.null().optional(),
});
const binarySchema = z.strictObject({
  type: z.literal('binary_expr'),
  operator: z.string(),
  left: z.unknown(),
  right: z.unknown(),
  parentheses: z.boolean().optional(),
});
const columnSchema = z.strictObject({
  type: z.literal('column_ref'),
  table: z.null(),
  column: z.union([
    z.string(),
    z.strictObject({
      expr: z.strictObject({ type: z.literal('default'), value: z.string() }),
    }),
  ]),
  collate: z.null().optional(),
});
const parameterSchema = z.strictObject({
  type: z.literal('param'),
  value: z.string().regex(identifier),
});
export function compileCleanupSql(
  driver: 'postgresql' | 'mysql',
  statement: string,
  parameters: { name: string; valueRef: string }[],
  requiredTargets: string[],
  context: unknown,
) {
  try {
    const raw: unknown = parser.astify(statement, {
      database: driver === 'postgresql' ? 'Postgresql' : 'MySQL',
    });
    const statements = Array.isArray(raw) ? raw : [raw];
    if (statements.length !== 1) throw new Error('Single statement required');
    const ast = deleteSchema.parse(statements[0]);
    const table = ast.from[0]?.table;
    if (
      !table ||
      ast.table[0]?.table !== table ||
      /^pg_|^mysql$|^information_schema$|^sys$/i.test(table)
    )
      throw new Error('Protected table');
    const names = new Map(
      parameters.map((parameter) => [parameter.name, parameter.valueRef]),
    );
    if (names.size !== parameters.length || requiredTargets.length === 0)
      throw new Error('Explicit unique parameters and targets required');
    for (const target of requiredTargets)
      if (
        !nonEmpty(readPath(context, target)) ||
        !parameters.some((parameter) => parameter.valueRef === target)
      )
        throw new Error('Missing bound target');
    const values: (string | number | boolean)[] = [];
    const used = new Set<string>();
    const boundTargets = new Set<string>();
    const quote = (name: string) => {
      if (!identifier.test(name)) throw new Error('Invalid identifier');
      return driver === 'postgresql' ? `"${name}"` : `\`${name}\``;
    };
    const condition = (node: unknown, depth = 0): string => {
      if (depth > 50) throw new Error('Condition too deep');
      const expression = binarySchema.parse(node);
      if (expression.operator.toUpperCase() === 'AND')
        return `(${condition(expression.left, depth + 1)} AND ${condition(expression.right, depth + 1)})`;
      if (expression.operator !== '=')
        throw new Error('Only parameter equalities are allowed');
      const column = columnSchema.parse(expression.left);
      const parameter = parameterSchema.parse(expression.right);
      const field =
        typeof column.column === 'string'
          ? column.column
          : column.column.expr.value;
      const reference = names.get(parameter.value);
      if (!reference) throw new Error('Undeclared parameter');
      const value = readPath(context, reference);
      if (!nonEmpty(value)) throw new Error('Empty/complex cleanup parameter');
      used.add(parameter.value);
      boundTargets.add(reference);
      values.push(value);
      return `${quote(field)} = ${driver === 'postgresql' ? `$${values.length}` : '?'}`;
    };
    const where = condition(ast.where);
    if (
      used.size !== parameters.length ||
      requiredTargets.some((target) => !boundTargets.has(target))
    )
      throw new Error('Unbound or unused target parameter');
    return {
      statement: `DELETE FROM ${quote(table)} WHERE ${where}`,
      values,
      table,
    };
  } catch {
    throw new DomainError(
      'PRECONDITIONS_MISSING',
      'SQL清理不符合单条DELETE及AND等值命名参数/非空目标保护，未发送。',
      422,
    );
  }
}
