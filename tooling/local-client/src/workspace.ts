import { constants } from 'node:fs';
import {
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  unlink,
} from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import type { WorkspacePort } from './ports.js';
import { localFailure } from './errors.js';
import { assertSafe } from './safety.js';

const comparable = (value: string) =>
  process.platform === 'win32' ? value.toLowerCase() : value;
export function contained(base: string, target: string): boolean {
  const rel = relative(base, target);
  return !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`);
}
export async function noLinks(path: string): Promise<void> {
  let cursor = resolve(path);
  for (;;) {
    const s = await lstat(cursor);
    if (s.isSymbolicLink())
      throw localFailure('UNSAFE_PATH', '受控路径不能经过符号链接或junction。');
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  if (comparable(resolve(await realpath(path))) !== comparable(resolve(path)))
    throw localFailure('UNSAFE_PATH', '受控路径的真实位置不一致。');
}
export function platformOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw localFailure(
      'INVALID_HOST_CONFIG',
      '可信host必须提供有效平台origin。',
    );
  }
  if (
    url.origin !== value ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    (url.protocol !== 'https:' &&
      !(
        url.protocol === 'http:' &&
        ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
      ))
  )
    throw localFailure(
      'INVALID_HOST_CONFIG',
      '只接受HTTPS平台origin或明确的loopback开发origin。',
    );
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0')
    throw localFailure(
      'UNSAFE_TLS',
      'TLS校验已被进程环境关闭，客户端拒绝发送。',
    );
  return value;
}
export interface HostBinding {
  actorId: string;
  platformOrigin: string;
  privateRoot: string;
  allowedReadFiles?: readonly string[];
}
export class ActorWorkspace implements WorkspacePort {
  private constructor(
    readonly root: string,
    readonly actorId: string,
    readonly origin: string,
    readonly allowedReadFiles: readonly string[],
  ) {}
  static async create(binding: HostBinding): Promise<ActorWorkspace> {
    const actor = z.uuid().parse(binding.actorId),
      origin = platformOrigin(binding.platformOrigin);
    if (!isAbsolute(binding.privateRoot))
      throw localFailure(
        'INVALID_HOST_CONFIG',
        '私有工作根必须为可信host明确的绝对路径。',
      );
    const base = resolve(binding.privateRoot);
    await mkdir(base, { recursive: true, mode: 0o700 });
    await noLinks(base);
    let ancestor = base;
    for (;;) {
      try {
        await lstat(join(ancestor, '.git'));
        throw localFailure(
          'UNSAFE_WORKSPACE',
          '私有运行目录不能位于版本仓库内。',
        );
      } catch (error) {
        if (!(
          error instanceof Error &&
          'code' in error &&
          error.code === 'ENOENT'
        ))
          throw error;
      }
      const parent = dirname(ancestor);
      if (parent === ancestor) break;
      ancestor = parent;
    }
    const namespace = createHash('sha256')
        .update(JSON.stringify({ actorId: actor, origin }))
        .digest('hex'),
      root = join(base, `actor-${namespace}`);
    await mkdir(root, { recursive: true, mode: 0o700 });
    await noLinks(root);
    const marker = join(root, '.binding.json'),
      expected = JSON.stringify({
        format: 'ath.local-client.binding.v1',
        actorId: actor,
        origin,
      });
    try {
      const fd = await open(marker, 'wx', 0o600);
      try {
        await fd.writeFile(expected);
        await fd.sync();
      } finally {
        await fd.close();
      }
    } catch (error) {
      if (!(
        error instanceof Error &&
        'code' in error &&
        error.code === 'EEXIST'
      ))
        throw error;
      await noLinks(marker);
      if ((await readFile(marker, 'utf8')) !== expected)
        throw localFailure(
          'WORKSPACE_BINDING_MISMATCH',
          '已有工作目录属于另一可信host身份/平台。',
        );
    }
    const reads = (binding.allowedReadFiles ?? []).map((file) => {
      if (!isAbsolute(file))
        throw localFailure(
          'INVALID_HOST_CONFIG',
          '附加可读文件须由host给出绝对路径。',
        );
      return resolve(file);
    });
    return new ActorWorkspace(root, actor, origin, Object.freeze(reads));
  }
  private keyPath(key: string): string {
    if (
      !key ||
      key.length > 1500 ||
      isAbsolute(key) ||
      /[\\\x00-\x1f\x7f<>:"|?*]/.test(key)
    )
      throw localFailure('UNSAFE_WORKSPACE_KEY', '工作key必须是受控相对路径。');
    const segments = key.split('/');
    if (
      segments.some(
        (s) =>
          !s ||
          s === '.' ||
          s === '..' ||
          s.endsWith('.') ||
          s.endsWith(' ') ||
          /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(s),
      ) ||
      ['.binding.json', '.locks', '.transfers'].includes(segments[0]!)
    )
      throw localFailure(
        'UNSAFE_WORKSPACE_KEY',
        '工作key包含保留路径或遍历片段。',
      );
    const path = resolve(this.root, ...segments);
    if (!contained(this.root, path))
      throw localFailure('UNSAFE_WORKSPACE_KEY', '工作key越过本身份根。');
    return path;
  }
  private async assertRoot(): Promise<void> {
    await noLinks(this.root);
    const expected = JSON.stringify({
      format: 'ath.local-client.binding.v1',
      actorId: this.actorId,
      origin: this.origin,
    });
    await noLinks(join(this.root, '.binding.json'));
    if ((await readFile(join(this.root, '.binding.json'), 'utf8')) !== expected)
      throw localFailure('WORKSPACE_BINDING_MISMATCH', '工作目录绑定已改变。');
  }
  async readText(key: string): Promise<string | null> {
    const path = this.keyPath(key);
    await this.assertRoot();
    try {
      await noLinks(path);
      const stat = await lstat(path);
      if (!stat.isFile() || stat.size > 16 * 1024 * 1024)
        throw localFailure(
          'WORKSPACE_LIMIT',
          '工作文件不是限额内普通文本文件。',
        );
      const bytes = await readFile(path);
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
        return null;
      throw error;
    }
  }
  async writeTextAtomic(key: string, text: string): Promise<void> {
    if (typeof text !== 'string')
      throw localFailure('INVALID_JSON', '工作内容必须为文本。');
    assertSafe(text);
    const path = this.keyPath(key);
    await this.assertRoot();
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await noLinks(dirname(path));
    try {
      await noLinks(path);
      if (!(await lstat(path)).isFile())
        throw localFailure('UNSAFE_PATH', '不能替换非普通工作文件。');
    } catch (error) {
      if (!(
        error instanceof Error &&
        'code' in error &&
        error.code === 'ENOENT'
      ))
        throw error;
    }
    const temporary = join(dirname(path), `.write-${randomUUID()}.tmp`),
      fd = await open(
        temporary,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
        0o600,
      );
    try {
      await fd.writeFile(text, 'utf8');
      await fd.sync();
    } finally {
      await fd.close();
    }
    try {
      await noLinks(dirname(path));
      await rename(temporary, path);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }
  async withExclusive<T>(key: string, work: () => Promise<T>): Promise<T> {
    this.keyPath(key);
    await this.assertRoot();
    const locks = join(this.root, '.locks');
    await mkdir(locks, { recursive: true, mode: 0o700 });
    await noLinks(locks);
    const path = join(
      locks,
      createHash('sha256').update(key).digest('hex') + '.lock',
    );
    let fd;
    try {
      fd = await open(path, 'wx', 0o600);
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'EEXIST')
        throw localFailure(
          'STORE_BUSY',
          '工作账本被使用或存在未核实的遗留锁；不自动抢锁。',
        );
      throw error;
    }
    try {
      await fd.writeFile(
        JSON.stringify({
          pid: process.pid,
          createdAt: new Date().toISOString(),
        }),
      );
      await fd.sync();
      return await work();
    } finally {
      await fd.close();
      await unlink(path);
    }
  }
  async authorizeReadFile(absolutePath: string): Promise<string> {
    await this.assertRoot();
    if (!isAbsolute(absolutePath))
      throw localFailure('UNSAFE_PATH', '来源文件须为已授权绝对路径。');
    const path = resolve(absolutePath),
      approved =
        contained(this.root, path) ||
        this.allowedReadFiles.some((f) => comparable(f) === comparable(path));
    if (!approved)
      throw localFailure(
        'UNAUTHORIZED_LOCAL_FILE',
        '来源文件不在本身份工作根或host明确文件清单。',
      );
    await noLinks(path);
    const stat = await lstat(path);
    if (!stat.isFile())
      throw localFailure('UNSAFE_PATH', '来源必须为普通文件。');
    return path;
  }
  async authorizeDestination(absolutePath: string): Promise<string> {
    await this.assertRoot();
    if (!isAbsolute(absolutePath))
      throw localFailure('UNSAFE_PATH', '下载目标须为工作根内绝对路径。');
    const path = resolve(absolutePath);
    if (!contained(this.root, path) || path === this.root)
      throw localFailure('UNSAFE_PATH', '下载目标越过本身份工作根。');
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await noLinks(dirname(path));
    try {
      await lstat(path);
      throw localFailure(
        'DESTINATION_EXISTS',
        '下载目标已存在；不会覆盖原文件。',
      );
    } catch (error) {
      if (!(
        error instanceof Error &&
        'code' in error &&
        error.code === 'ENOENT'
      ))
        throw error;
    }
    return path;
  }
  async transferDirectory(): Promise<string> {
    await this.assertRoot();
    const directory = join(this.root, '.transfers');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await noLinks(directory);
    return directory;
  }
}
