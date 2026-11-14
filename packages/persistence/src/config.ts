import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Pool } from 'pg';
import { Database } from './database.js';

function port(value: string | undefined): number {
  const parsed = Number(value ?? '55432');
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error('DB_PORT must be an integer between 1 and 65535.');
  }
  return parsed;
}

/** Secrets remain in the local private runtime root or a mounted secret file. */
export async function createDatabaseFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<Database> {
  const localRoot =
    environment.AITESTHUB_LOCAL_ROOT ??
    (environment.LOCALAPPDATA === undefined
      ? undefined
      : join(environment.LOCALAPPDATA, 'AITestHub'));
  const passwordFile =
    environment.AITESTHUB_DB_PASSWORD_FILE ??
    (localRoot === undefined
      ? undefined
      : join(localRoot, 'secrets', 'postgres-app-password'));
  if (passwordFile === undefined) {
    throw new Error(
      'AITESTHUB_DB_PASSWORD_FILE or AITESTHUB_LOCAL_ROOT is required.',
    );
  }
  let password: string;
  try {
    password = (await readFile(passwordFile, 'utf8')).trimEnd();
  } catch {
    throw new Error('AITESTHUB_DB_PASSWORD_FILE could not be read.');
  }
  if (password.length === 0)
    throw new Error('AITESTHUB_DB_PASSWORD_FILE is empty.');
  const pool = new Pool({
    host: environment.DB_HOST ?? '127.0.0.1',
    port: port(environment.DB_PORT),
    database: environment.DB_NAME ?? 'aitesthub',
    user: environment.DB_USER ?? 'aitesthub_app',
    password,
    max: 10,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    application_name: 'aitesthub',
    options: '-c search_path=app,public',
  });
  // An idle connection error must not print a DSN or terminate the process.
  pool.on('error', () => {
    process.stderr.write('AITestHub database connection became unavailable.\n');
  });
  return new Database(pool);
}
