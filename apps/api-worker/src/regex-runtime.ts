import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

export async function evaluateRegex(
  pattern: string,
  value: string,
  timeoutMs = 1000,
): Promise<boolean> {
  const js = fileURLToPath(new URL('./regex-child.js', import.meta.url));
  const path = existsSync(js)
    ? js
    : fileURLToPath(new URL('./regex-child.ts', import.meta.url));
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--max-old-space-size=64', path], {
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true,
      env: {},
    });
    let done = false;
    const chunks: Buffer[] = [];
    let bytes = 0;
    const finish = (error?: Error, passed?: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.kill();
      if (error) reject(error);
      else resolve(passed ?? false);
    };
    const timer = setTimeout(
      () => finish(new Error('REGEX_ASSERTION_TIMEOUT')),
      timeoutMs,
    );
    child.on('error', () => finish(new Error('REGEX_ASSERTION_RUNTIME')));
    child.stdin.on('error', () => finish(new Error('REGEX_ASSERTION_RUNTIME')));
    child.stderr.resume();
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 512) finish(new Error('REGEX_ASSERTION_RUNTIME'));
      else chunks.push(chunk);
    });
    child.on('close', (code) => {
      if (done) return;
      try {
        if (code !== 0) throw new Error();
        const output = z
          .strictObject({ valid: z.boolean(), passed: z.boolean() })
          .parse(JSON.parse(Buffer.concat(chunks).toString()) as unknown);
        if (!output.valid) throw new Error();
        finish(undefined, output.passed);
      } catch {
        finish(new Error('REGEX_ASSERTION_INVALID'));
      }
    });
    child.stdin.end(JSON.stringify({ pattern, value }));
  });
}
