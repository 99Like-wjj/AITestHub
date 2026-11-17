import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';

const origin = (protocols: readonly string[]) =>
  z.url().refine((value) => {
    const u = new URL(value);
    return (
      protocols.includes(u.protocol) &&
      u.pathname === '/' &&
      !u.username &&
      !u.password &&
      !u.search &&
      !u.hash
    );
  });
const policySchema = z.strictObject({
  forbiddenOrigins: z
    .array(origin(['http:', 'https:']))
    .min(1)
    .max(100),
  allowedPrivateOrigins: z.array(origin(['http:', 'https:'])).max(100),
  allowedWebSocketOrigins: z.array(origin(['wss:'])).max(100),
});
export async function readBrowserNetworkPolicy(
  environment: NodeJS.ProcessEnv = process.env,
) {
  const path = environment.AITESTHUB_BROWSER_NETWORK_POLICY_FILE,
    expected = environment.AITESTHUB_BROWSER_NETWORK_POLICY_SHA256;
  if (!path || !expected || !/^[a-f0-9]{64}$/.test(expected))
    throw new Error('BROWSER_NETWORK_POLICY_BINDING_INVALID');
  const bytes = await readFile(path);
  if (createHash('sha256').update(bytes).digest('hex') !== expected)
    throw new Error('BROWSER_NETWORK_POLICY_DIGEST_CHANGED');
  return policySchema.parse(JSON.parse(bytes.toString('utf8')));
}
