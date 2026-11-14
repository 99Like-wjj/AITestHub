import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { finished } from 'node:stream/promises';
import { DomainError } from '../errors.js';
export interface DumpTask {
  stream: Readable;
  completed: Promise<{ ok: boolean }>;
  cancel(): void;
}
export interface PostgresDumpPort {
  start(snapshot: string): DumpTask;
  version(): Promise<string>;
  validate(input: Readable): Promise<boolean>;
}
/** Host-side diagnostic/ops adapter. Command text contains only validated identifiers and a secret-file path. */
export class DockerPostgresDump implements PostgresDumpPort {
  constructor(
    readonly docker: string,
    readonly container: string,
    readonly database: string,
    readonly user = 'aitesthub_app',
    readonly passwordFile = '/run/secrets/postgres_app_password',
  ) {
    if (
      !/^[a-zA-Z0-9_.-]+$/.test(container) ||
      !/^[a-zA-Z0-9_]+$/.test(database) ||
      !/^[a-zA-Z0-9_]+$/.test(user) ||
      !/^\/[a-zA-Z0-9_./-]+$/.test(passwordFile)
    )
      throw new Error('Invalid fixed PostgreSQL dump adapter configuration');
  }
  start(snapshot: string): DumpTask {
    if (!/^[0-9a-f-]{1,128}$/i.test(snapshot))
      throw new Error('Invalid exported snapshot identity');
    const script = `PGPASSWORD="$(cat ${this.passwordFile})"; export PGPASSWORD; exec pg_dump -h 127.0.0.1 -U ${this.user} -d ${this.database} --format=custom --no-owner --no-privileges --snapshot=${snapshot}`;
    const child = spawn(
      this.docker,
      ['exec', this.container, 'sh', '-c', script],
      { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    child.stderr.resume();
    let failed = false;
    const failure = () =>
      new DomainError(
        'DEPENDENCY_UNAVAILABLE',
        'PostgreSQL导出未完成，本次没有可恢复归档。',
        503,
      );
    const completed = new Promise<{ ok: boolean }>((done) => {
      child.once('error', () => {
        failed = true;
        child.stdout.destroy(failure());
        done({ ok: false });
      });
      child.once('close', (code) => {
        if (code !== 0) {
          failed = true;
          child.stdout.destroy(failure());
        }
        done({ ok: !failed && code === 0 });
      });
    });
    return {
      stream: child.stdout,
      completed,
      cancel() {
        child.kill();
      },
    };
  }
  async version() {
    return new Promise<string>((done, reject) => {
      const child = spawn(
        this.docker,
        ['exec', this.container, 'pg_dump', '--version'],
        {
          windowsHide: true,
          shell: false,
          stdio: ['ignore', 'pipe', 'ignore'],
        },
      );
      let output = '';
      child.stdout.on('data', (chunk) => {
        if (output.length < 512) output += chunk.toString();
      });
      child.once('error', () =>
        reject(new Error('PostgreSQL dump tool is unavailable')),
      );
      child.once('close', (code) =>
        code === 0 && /^pg_dump \(PostgreSQL\) 18\./.test(output.trim())
          ? done(output.trim())
          : reject(new Error('Unverified PostgreSQL dump tool version')),
      );
    });
  }
  async validate(input: Readable) {
    try {
      const child = spawn(
        this.docker,
        ['exec', '-i', this.container, 'pg_restore', '--list'],
        {
          windowsHide: true,
          shell: false,
          stdio: ['pipe', 'ignore', 'ignore'],
        },
      );
      // --list normally exits after the TOC while custom-format table bytes remain. On Windows
      // Docker stdin may then report EOF rather than EPIPE. Drain/authenticate the whole input
      // independently and require the tool's successful exit; never kill a successful TOC read.
      const inputFinished = finished(input).then(
        () => true,
        () => {
          child.stdin.destroy();
          child.kill();
          return false;
        },
      );
      const drain = () => {
        input.unpipe(child.stdin);
        input.resume();
      };
      child.stdin.once('error', drain);
      const processFinished = new Promise<boolean>((done) => {
        child.once('error', () => {
          input.destroy();
          done(false);
        });
        child.once('close', (code) => {
          drain();
          done(code === 0);
        });
      });
      const timer = setTimeout(() => {
        child.kill();
        input.destroy();
      }, 30000);
      timer.unref();
      input.pipe(child.stdin);
      try {
        const [complete, valid] = await Promise.all([
          inputFinished,
          processFinished,
        ]);
        return complete && valid;
      } finally {
        clearTimeout(timer);
      }
    } catch {
      input.destroy();
      return false;
    }
  }
}
