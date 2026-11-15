import assert from 'node:assert/strict';
import { appendFile, writeFile, lstat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  command,
  downloadRelease,
  readSmallFile,
  temporaryDirectory,
} from './github-release.mjs';
import { validateQualificationEnvelope } from './release-contract.mjs';
import { readReviewedJsonConfiguration } from '../../scripts/private-config.mjs';

export function parseArguments(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    assert.ok(
      [
        '--action',
        '--run-id',
        '--operation-id',
        '--connection',
        '--connection-sha256',
        '--qualification',
        '--output',
        '--download-dir',
      ].includes(key),
    );
    assert.ok(args[index + 1] && !args[index + 1].startsWith('--'));
    assert.ok(!(key.slice(2) in options));
    options[key.slice(2)] = args[index + 1];
  }
  assert.ok(
    ['plan', 'deploy', 'status', 'qualify', 'download'].includes(
      options.action,
    ),
  );
  if (options.action === 'status')
    assert.match(
      options['operation-id'],
      /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,
    );
  else assert.match(options['run-id'], /^[1-9][0-9]{0,19}$/);
  if (options.action === 'qualify') assert.ok(options.qualification);
  if (options.action === 'download') assert.ok(options['download-dir']);
  return options;
}

async function connection(options, env, credentials = true) {
  let value;
  if (options.connection) {
    const root = fileURLToPath(new URL('../..', import.meta.url));
    const reviewed = await readReviewedJsonConfiguration(
      {
        file: resolve(options.connection),
        digest: options['connection-sha256'],
      },
      'file',
      'digest',
      root,
      (entry) => entry,
    );
    value = reviewed.data;
    assert.equal(value.schemaVersion, 'ath.actions-connection.v1');
    if (credentials)
      value = {
        ...value,
        privateKey: (await readSmallFile(value.sshKeyFile, 32768)).toString(
          'utf8',
        ),
        knownHosts: (await readSmallFile(value.knownHostsFile, 32768)).toString(
          'utf8',
        ),
      };
  } else {
    value = {
      repository: env.GITHUB_REPOSITORY,
      host: env.ATH_DEPLOY_HOST,
      user: env.ATH_DEPLOY_USER,
      privateKey: env.ATH_DEPLOY_SSH_KEY,
      knownHosts: env.ATH_DEPLOY_KNOWN_HOSTS,
      sshExecutable: 'ssh',
    };
  }
  assert.match(value.repository, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
  if (!credentials) return value;
  assert.match(value.host, /^(?=.{1,253}$)[A-Za-z0-9][A-Za-z0-9.-]*$/);
  assert.match(value.user, /^[a-z_][a-z0-9_-]{0,31}$/);
  assert.ok(
    value.privateKey?.includes('BEGIN OPENSSH PRIVATE KEY') &&
      value.privateKey.length < 32768,
  );
  assert.ok(
    value.knownHosts &&
      value.knownHosts.length < 32768 &&
      !value.knownHosts.includes('PRIVATE KEY'),
  );
  return value;
}

export async function sendRequest(
  config,
  request,
  workDirectory,
  env = process.env,
) {
  const key = join(workDirectory, 'identity');
  const hosts = join(workDirectory, 'known_hosts');
  await writeFile(key, config.privateKey, { mode: 0o600, flag: 'wx' });
  await writeFile(hosts, config.knownHosts, { mode: 0o600, flag: 'wx' });
  const options = [
    '-T',
    '-o',
    'BatchMode=yes',
    '-o',
    'IdentitiesOnly=yes',
    '-o',
    'IdentityAgent=none',
    '-o',
    'StrictHostKeyChecking=yes',
    '-o',
    'UpdateHostKeys=no',
    '-o',
    'ConnectionAttempts=1',
    '-o',
    'ConnectTimeout=15',
    '-o',
    'ServerAliveInterval=15',
    '-o',
    'ServerAliveCountMax=3',
    '-o',
    'UserKnownHostsFile=' + hosts,
    '-i',
    key,
    config.user + '@' + config.host,
    'aitesthub-actions-v1',
  ];
  const registryToken = request.action === 'deploy' ? env.GH_TOKEN : undefined;
  assert.ok(
    request.action !== 'deploy' || registryToken,
    'REGISTRY_JOB_TOKEN_REQUIRED',
  );
  const input =
    JSON.stringify({
      ...request,
      ...(registryToken ? { registryToken } : {}),
    }) + '\n';
  assert.ok(Buffer.byteLength(input) <= 4 * 1024 * 1024);
  const result = JSON.parse(
    await command(config.sshExecutable, options, {
      input,
      timeout: request.action === 'deploy' ? 1800000 : 180000,
      allowFailureJson: true,
    }),
  );
  assert.ok(
    result && typeof result === 'object' && typeof result.ok === 'boolean',
  );
  return result;
}

export async function main(args = process.argv.slice(2), env = process.env) {
  if (args.length === 1 && args[0] === '--help') {
    process.stdout.write(
      'Usage: node deploy/actions/client.mjs --action plan|deploy|qualify|status|download --run-id <successful-main-build-run> [--operation-id <uuid>] [--connection <external-json> --connection-sha256 <digest>] [--qualification <signed-json>] [--output <result-json>] [--download-dir <empty-directory>]\n',
    );
    return;
  }
  const options = parseArguments(args);
  const operationId = options['operation-id'] ?? randomUUID();
  const scratch = await temporaryDirectory();
  let result = {
    ok: false,
    operationId,
    action: options.action,
    error: 'REQUEST_NOT_SENT',
  };
  let phase = 'configuration';
  try {
    const config = await connection(
      options,
      env,
      options.action !== 'download',
    );
    if (env.GITHUB_ACTIONS === 'true') {
      assert.equal(
        env.GITHUB_REF,
        'refs/heads/main',
        'DEPLOYMENT_WORKFLOW_MUST_RUN_FROM_MAIN',
      );
      assert.equal(
        env.GITHUB_EVENT_NAME,
        'workflow_dispatch',
        'MANUAL_RELEASE_REQUIRED',
      );
    }
    const request = { action: options.action, operationId };
    if (options.action !== 'status') {
      phase = 'release-download';
      const artifact = await downloadRelease(
        config.repository,
        options['run-id'],
        join(scratch.path, 'release'),
      );
      if (options.action === 'download') {
        const directory = resolve(options['download-dir']);
        const item = await lstat(directory);
        assert.ok(item.isDirectory() && !item.isSymbolicLink());
        await writeFile(join(directory, 'release.json'), artifact.bytes, {
          flag: 'wx',
          mode: 0o600,
        });
        result = {
          ok: true,
          operationId,
          action: 'download',
          runId: artifact.release.runId,
          sourceCommit: artifact.release.sourceCommit,
          releaseSha256: artifact.sha256,
        };
        return;
      }
      request.release = artifact.release;
      request.releaseBytes = artifact.bytes.toString('base64');
      if (options.qualification) {
        request.qualification = JSON.parse(
          (await readSmallFile(resolve(options.qualification), 16384)).toString(
            'utf8',
          ),
        );
        validateQualificationEnvelope(request.qualification);
      }
    }
    if (env.GITHUB_OUTPUT)
      await appendFile(env.GITHUB_OUTPUT, `operation_id=${operationId}\n`);
    process.stdout.write(
      JSON.stringify({
        phase: 'request-prepared',
        operationId,
        action: options.action,
      }) + '\n',
    );
    phase = 'request-send';
    result = await sendRequest(config, request, scratch.path, env);
    if (!result.ok) process.exitCode = 1;
  } catch {
    result = {
      ok: false,
      operationId,
      action: options.action,
      phase,
      error: 'ACTIONS_REQUEST_FAILED',
      recovery:
        'Inspect this operationId using status. Do not automatically repeat a deploy request.',
    };
    process.exitCode = 1;
  } finally {
    await scratch.dispose();
    if (options.output)
      await writeFile(
        resolve(options.output),
        JSON.stringify(result, null, 2) + '\n',
        { mode: 0o600 },
      );
    if (env.GITHUB_STEP_SUMMARY)
      await appendFile(
        env.GITHUB_STEP_SUMMARY,
        `### Cloud ${options.action}\n\n\`\`\`json\n${JSON.stringify(result, null, 2)}\n\`\`\`\n`,
      );
    process.stdout.write(JSON.stringify(result) + '\n');
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  await main();
