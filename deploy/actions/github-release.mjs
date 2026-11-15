import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
} from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { parseReleaseBytes } from './release-contract.mjs';

export function command(
  executable,
  args,
  { input, timeout = 60000, env, allowFailureJson = false } = {},
) {
  return new Promise((done, reject) => {
    const child = execFile(
      executable,
      args,
      {
        encoding: 'utf8',
        timeout,
        maxBuffer: 8 * 1024 * 1024,
        windowsHide: true,
        ...(env ? { env } : {}),
      },
      (error, stdout) => {
        if (!error) return done(stdout);
        if (allowFailureJson && error.code === 1) {
          try {
            const result = JSON.parse(stdout);
            if (result?.ok === false) return done(stdout);
          } catch {}
        }
        reject(new Error('ACTIONS_FIXED_COMMAND_FAILED'));
      },
    );
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

export async function temporaryDirectory() {
  const parent = await realpath(tmpdir());
  const directory = join(parent, 'aitesthub-actions-' + randomUUID());
  await mkdir(directory, { mode: 0o700 });
  return {
    path: directory,
    async dispose() {
      assert.equal(dirname(await realpath(directory)), parent);
      assert.ok(!(await lstat(directory)).isSymbolicLink());
      await rm(directory, { recursive: true });
    },
  };
}

export async function readSmallFile(path, limit = 1024 * 1024) {
  const item = await lstat(path);
  assert.ok(
    item.isFile() &&
      !item.isSymbolicLink() &&
      item.size > 0 &&
      item.size <= limit,
  );
  return readFile(path);
}

export function validateBuildRun(run, workflow, repo) {
  assert.equal(repo.private, true, 'REPOSITORY_MUST_REMAIN_PRIVATE');
  assert.equal(run.repository?.id, repo.id);
  assert.equal(run.head_repository?.id, repo.id);
  assert.equal(run.workflow_id, workflow.id);
  assert.equal(run.path, '.github/workflows/build-image.yml');
  assert.equal(run.head_branch, 'main');
  assert.equal(run.status, 'completed');
  assert.equal(run.conclusion, 'success');
  assert.ok(['push', 'workflow_dispatch'].includes(run.event));
  assert.match(run.head_sha, /^[0-9a-f]{40}$/);
  assert.ok(Number.isSafeInteger(run.run_attempt) && run.run_attempt > 0);
  return run;
}

export async function downloadRelease(repository, runId, outputDirectory) {
  assert.match(repository, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
  assert.match(runId, /^[1-9][0-9]{0,19}$/);
  const api = async (path) => JSON.parse(await command('gh', ['api', path]));
  const [run, workflow, repo] = await Promise.all([
    api(`repos/${repository}/actions/runs/${runId}`),
    api(`repos/${repository}/actions/workflows/build-image.yml`),
    api(`repos/${repository}`),
  ]);
  validateBuildRun(run, workflow, repo);
  const name = `aitesthub-release-${runId}-${run.run_attempt}`;
  const listed = await api(
    `repos/${repository}/actions/runs/${runId}/artifacts?name=${name}&per_page=100`,
  );
  const matches = listed.artifacts.filter(
    (item) => item.name === name && !item.expired,
  );
  assert.equal(matches.length, 1, 'UNIQUE_RELEASE_ARTIFACT_REQUIRED');
  assert.equal(matches[0].workflow_run?.head_sha, run.head_sha);
  await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
  assert.ok(!(await lstat(outputDirectory)).isSymbolicLink());
  assert.equal((await readdir(outputDirectory)).length, 0);
  await command(
    'gh',
    [
      'run',
      'download',
      runId,
      '--repo',
      repository,
      '--name',
      name,
      '--dir',
      resolve(outputDirectory),
    ],
    { timeout: 120000 },
  );
  assert.deepEqual(await readdir(outputDirectory), ['release.json']);
  const parsed = parseReleaseBytes(
    await readSmallFile(join(outputDirectory, 'release.json')),
    { repository },
  );
  assert.equal(parsed.release.sourceCommit, run.head_sha);
  assert.equal(parsed.release.runId, runId);
  assert.equal(parsed.release.runAttempt, String(run.run_attempt));
  return { ...parsed, runUrl: run.html_url, artifactId: String(matches[0].id) };
}
