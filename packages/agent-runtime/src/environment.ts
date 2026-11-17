import { readFile } from 'node:fs/promises';
import { SandboxBrokerClient } from './client.js';

/** Loaded only by the explicit API/worker composition root; never at module import. */
export async function createSandboxClientFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<SandboxBrokerClient | undefined> {
  const origin = environment.AITESTHUB_SANDBOX_ORIGIN;
  const tokenFile = environment.AITESTHUB_SANDBOX_TOKEN_FILE;
  if (!origin && !tokenFile) return undefined;
  if (!origin || !tokenFile)
    throw new Error('AITESTHUB_SANDBOX_ORIGIN_AND_TOKEN_FILE_REQUIRED');
  let token: string;
  try {
    token = (await readFile(tokenFile, 'utf8')).trim();
  } catch {
    throw new Error('AITESTHUB_SANDBOX_TOKEN_FILE_UNAVAILABLE');
  }
  return new SandboxBrokerClient(origin, token);
}
