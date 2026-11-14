import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { QueryResultRow } from 'pg';
import type { Database } from './database.js';

interface AppliedMigration extends QueryResultRow {
  version: string;
  checksum: string;
}

export interface MigrationResult {
  applied: string[];
  alreadyApplied: string[];
}

export async function migrateDatabase(
  database: Database,
  directory = process.env.AITESTHUB_TEST_MIGRATIONS_DIR ??
    resolve('packages/persistence/migrations'),
): Promise<MigrationResult> {
  const filenames = (await readdir(directory))
    .filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/.test(name))
    .sort();
  if (filenames.length === 0)
    throw new Error('No versioned database migrations were found.');
  const migrations = await Promise.all(
    filenames.map(async (version) => {
      const sql = await readFile(join(directory, version), 'utf8');
      return {
        version,
        sql,
        checksum: createHash('sha256').update(sql).digest('hex'),
      };
    }),
  );
  const prefixes = migrations.map((migration) => migration.version.slice(0, 4));
  if (new Set(prefixes).size !== prefixes.length)
    throw new Error('Duplicate migration version.');
  return database.transaction(async (transaction) => {
    await transaction.query('SELECT pg_advisory_xact_lock(415_948_007)');
    await transaction.query(`CREATE TABLE IF NOT EXISTS app.schema_migrations (
      version text PRIMARY KEY,
      checksum text NOT NULL CHECK (checksum ~ '^[a-f0-9]{64}$'),
      applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
    )`);
    const applied = (
      await transaction.query<AppliedMigration>(
        'SELECT version, checksum FROM app.schema_migrations ORDER BY version',
      )
    ).rows;
    const available = new Map(
      migrations.map((migration) => [migration.version, migration]),
    );
    for (const previous of applied) {
      if (available.get(previous.version)?.checksum !== previous.checksum) {
        throw new Error(
          `Applied migration is missing or changed: ${previous.version}`,
        );
      }
    }
    const result: MigrationResult = { applied: [], alreadyApplied: [] };
    const previousVersions = new Set(
      applied.map((migration) => migration.version),
    );
    const highestApplied = applied.at(-1)?.version;
    for (const migration of migrations) {
      if (previousVersions.has(migration.version)) {
        result.alreadyApplied.push(migration.version);
        continue;
      }
      if (highestApplied !== undefined && migration.version < highestApplied) {
        throw new Error(
          `Migration cannot be inserted before applied history: ${migration.version}`,
        );
      }
      await transaction.query(migration.sql);
      await transaction.query(
        'INSERT INTO app.schema_migrations (version, checksum) VALUES ($1, $2)',
        [migration.version, migration.checksum],
      );
      result.applied.push(migration.version);
    }
    return result;
  });
}
