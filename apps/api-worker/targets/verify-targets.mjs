import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import pg from 'pg';
import mysql from 'mysql2/promise';
const root =
  process.env.AITESTHUB_LOCAL_ROOT ??
  join(process.env.LOCALAPPDATA, 'AITestHub');
const secret = async (name) =>
  (await readFile(join(root, 'secrets', name), 'utf8')).trim();
const result = {
  scope: 'isolated target components only',
  postgres: false,
  mysql: false,
  cleanupPrivilegesMinimal: false,
  secretValuesPrinted: false,
};
const postgres = new pg.Client({
  host: '127.0.0.1',
  port: 55434,
  database: 'aitesthub_target',
  user: 'target_admin',
  password: await secret('target-postgres-admin-password'),
  connectionTimeoutMillis: 5000,
});
try {
  await postgres.connect();
  const database = (await postgres.query('SELECT current_database() database'))
    .rows[0]?.database;
  if (database !== 'aitesthub_target') throw new Error('Wrong target database');
  if (process.argv.includes('--grant-condition-columns'))
    await postgres.query(
      'GRANT SELECT(id,tenant_id) ON public.test_objects TO ath_target_cleanup',
    );
  result.postgres =
    (
      await postgres.query(
        "SELECT 1 FROM pg_roles WHERE rolname='ath_target_cleanup' AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole",
      )
    ).rowCount === 1;
} finally {
  await postgres.end();
}
const mysqlAdmin = await mysql.createConnection({
  host: '127.0.0.1',
  port: 53306,
  database: 'aitesthub_target',
  user: 'ath_target_app',
  password: await secret('target-mysql-app-password'),
  connectTimeout: 5000,
});
try {
  const [database] = await mysqlAdmin.query('SELECT DATABASE() name');
  if (database[0]?.name !== 'aitesthub_target')
    throw new Error('Wrong target database');
  const [tables] = await mysqlAdmin.query(
    "SELECT 1 FROM information_schema.tables WHERE table_schema='aitesthub_target' AND table_name='test_objects'",
  );
  const [counter] = await mysqlAdmin.query(
    'SELECT calls FROM cleanup_call_count',
  );
  result.mysql = tables.length === 1 && counter.length === 1;
} finally {
  await mysqlAdmin.end();
}
const cleanup = await mysql.createConnection({
  host: '127.0.0.1',
  port: 53306,
  database: 'aitesthub_target',
  user: 'ath_target_cleanup',
  password: await secret('target-mysql-cleanup-password'),
  connectTimeout: 5000,
});
try {
  const [grants] = await cleanup.query('SHOW GRANTS');
  result.cleanupPrivilegesMinimal =
    !JSON.stringify(grants).includes('ALL PRIVILEGES') && result.postgres;
  try {
    await cleanup.query('SELECT payload FROM test_objects LIMIT 1');
    result.cleanupPrivilegesMinimal = false;
  } catch {}
} finally {
  await cleanup.end();
}
process.stdout.write(`${JSON.stringify(result)}\n`);
process.exitCode =
  result.postgres && result.mysql && result.cleanupPrivilegesMinimal ? 0 : 1;
