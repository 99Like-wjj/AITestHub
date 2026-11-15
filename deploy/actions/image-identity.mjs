import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';

const imageReference =
  /^ghcr\.io\/[a-z0-9][a-z0-9-]{0,38}\/[a-z0-9][a-z0-9_.-]{0,99}@sha256:[a-f0-9]{64}$/;
const digest = /^sha256:[a-f0-9]{64}$/;
const rejected = () =>
  Object.assign(new Error('ACTIONS_IMAGE_IDENTITY_REJECTED'), {
    code: 'ACTIONS_IMAGE_IDENTITY_REJECTED',
  });

function checksum(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function tarString(bytes) {
  const end = bytes.indexOf(0);
  return bytes.subarray(0, end < 0 ? bytes.length : end).toString('utf8');
}

function tarNumber(bytes) {
  const text = tarString(bytes).trim();
  if (!/^[0-7]+$/.test(text)) throw rejected();
  const number = Number.parseInt(text, 8);
  if (!Number.isSafeInteger(number) || number < 0) throw rejected();
  return number;
}

// Only small metadata entries are retained. Image layers are streamed past.
export async function readCanonicalImageArchive(source) {
  let header = Buffer.alloc(512);
  let headerBytes = 0;
  let remaining = 0;
  let padding = 0;
  let entry;
  let total = 0;
  let retained = 0;
  let entries = 0;
  let ended = false;
  const metadata = new Map();
  for await (const incoming of source) {
    const chunk = Buffer.from(incoming);
    total += chunk.length;
    if (total > 8 * 1024 * 1024 * 1024) throw rejected();
    let offset = 0;
    while (offset < chunk.length) {
      if (ended) {
        if (chunk.subarray(offset).some((byte) => byte !== 0)) throw rejected();
        offset = chunk.length;
      } else if (remaining > 0) {
        const length = Math.min(remaining, chunk.length - offset);
        if (entry.capture)
          entry.parts.push(
            Buffer.from(chunk.subarray(offset, offset + length)),
          );
        offset += length;
        remaining -= length;
        if (remaining === 0 && entry.capture) {
          const bytes = Buffer.concat(entry.parts);
          if (metadata.has(entry.name)) throw rejected();
          metadata.set(entry.name, bytes);
        }
      } else if (padding > 0) {
        const length = Math.min(padding, chunk.length - offset);
        offset += length;
        padding -= length;
      } else {
        const length = Math.min(512 - headerBytes, chunk.length - offset);
        chunk.copy(header, headerBytes, offset, offset + length);
        offset += length;
        headerBytes += length;
        if (headerBytes !== 512) continue;
        if (header.every((byte) => byte === 0)) {
          ended = true;
          headerBytes = 0;
          continue;
        }
        entries += 1;
        if (entries > 10000) throw rejected();
        let sum = 0;
        for (let index = 0; index < 512; index += 1)
          sum += index >= 148 && index < 156 ? 32 : header[index];
        if (tarNumber(header.subarray(148, 156)) !== sum) throw rejected();
        const name = tarString(header.subarray(0, 100));
        const prefix = tarString(header.subarray(345, 500));
        const path = prefix ? prefix + '/' + name : name;
        const size = tarNumber(header.subarray(124, 136));
        const regular = header[156] === 0 || header[156] === 48;
        const capture =
          regular &&
          size <= 2 * 1024 * 1024 &&
          (path === 'manifest.json' ||
            /^[a-f0-9]{64}\.json$/.test(path) ||
            /^blobs\/sha256\/[a-f0-9]{64}$/.test(path));
        if (capture) {
          retained += size;
          if (retained > 32 * 1024 * 1024) throw rejected();
        }
        entry = { name: path, capture, parts: [] };
        remaining = size;
        padding = (512 - (size % 512)) % 512;
        if (capture && size === 0) {
          if (metadata.has(path)) throw rejected();
          metadata.set(path, Buffer.alloc(0));
        }
        header = Buffer.alloc(512);
        headerBytes = 0;
      }
    }
  }
  if (!ended || headerBytes !== 0 || remaining !== 0 || padding !== 0)
    throw rejected();
  const manifestBytes = metadata.get('manifest.json');
  if (!manifestBytes) throw rejected();
  let manifest;
  try {
    manifest = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(manifestBytes),
    );
  } catch {
    throw rejected();
  }
  if (
    !Array.isArray(manifest) ||
    manifest.length !== 1 ||
    typeof manifest[0]?.Config !== 'string' ||
    !/^(?:[a-f0-9]{64}\.json|blobs\/sha256\/[a-f0-9]{64})$/.test(
      manifest[0].Config,
    )
  )
    throw rejected();
  const configBytes = metadata.get(manifest[0].Config);
  if (!configBytes) throw rejected();
  const configDigest = checksum(configBytes);
  const expected = manifest[0].Config.replace(/^blobs\/sha256\//, '').replace(
    /\.json$/,
    '',
  );
  if (expected !== configDigest) throw rejected();
  let config;
  try {
    config = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(configBytes),
    );
  } catch {
    throw rejected();
  }
  if (
    config === null ||
    typeof config !== 'object' ||
    config.os !== 'linux' ||
    config.architecture !== 'amd64'
  )
    throw rejected();
  return { imageId: 'sha256:' + configDigest, config };
}

function dockerProcess(options, args) {
  const executable = options.dockerExecutable ?? 'docker';
  const context = options.dockerContext;
  if (
    typeof executable !== 'string' ||
    !executable ||
    executable.includes('\0') ||
    (context !== undefined &&
      (typeof context !== 'string' ||
        !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(context)))
  )
    throw rejected();
  return spawn(
    executable,
    [...(context ? ['--context', context] : []), ...args],
    {
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
}

async function inspectImage(imageRef, options) {
  return new Promise((done, fail) => {
    const child = dockerProcess(options, [
      'image',
      'inspect',
      '--format',
      '{{json .Id}}\n{{json .RepoDigests}}\n{{json .Os}}\n{{json .Architecture}}\n{{json .Config.Labels}}',
      imageRef,
    ]);
    let output = '';
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) fail(error);
      else done(value);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(rejected());
    }, 30000);
    child.stderr.resume();
    child.stdout.on('data', (chunk) => {
      output += chunk.toString();
      if (output.length > 256 * 1024) {
        child.kill();
        finish(rejected());
      }
    });
    child.once('error', () => finish(rejected()));
    child.once('close', (code) => {
      if (code !== 0) return finish(rejected());
      try {
        const lines = output
          .trim()
          .split(/\r?\n/)
          .map((line) => JSON.parse(line));
        if (lines.length !== 5) throw rejected();
        finish(undefined, lines);
      } catch {
        finish(rejected());
      }
    });
  });
}

async function savedImageConfig(selector, options) {
  const child = dockerProcess(options, ['image', 'save', selector]);
  child.stderr.resume();
  const exited = new Promise((done, fail) => {
    child.once('error', () => fail(rejected()));
    child.once('close', (code) => (code === 0 ? done() : fail(rejected())));
  });
  const timer = setTimeout(() => child.kill(), 120000);
  try {
    const [result] = await Promise.all([
      readCanonicalImageArchive(child.stdout),
      exited,
    ]);
    return result;
  } catch {
    child.kill();
    throw rejected();
  } finally {
    clearTimeout(timer);
  }
}

export async function resolveImageIdentity(imageRef, options = {}) {
  if (typeof imageRef !== 'string' || !imageReference.test(imageRef))
    throw rejected();
  const [daemonImageId, repoDigests, os, architecture, labels] =
    await inspectImage(imageRef, options);
  if (
    !digest.test(daemonImageId ?? '') ||
    !Array.isArray(repoDigests) ||
    repoDigests.some((entry) => typeof entry !== 'string') ||
    !repoDigests.includes(imageRef) ||
    os !== 'linux' ||
    architecture !== 'amd64' ||
    (labels !== null &&
      (typeof labels !== 'object' ||
        Array.isArray(labels) ||
        Object.values(labels).some((value) => typeof value !== 'string')))
  )
    throw rejected();
  const { imageId, config } = await savedImageConfig(daemonImageId, options);
  const configLabels = config.config?.Labels ?? {};
  if (
    Object.keys(configLabels).sort().join('|') !==
      Object.keys(labels ?? {})
        .sort()
        .join('|') ||
    Object.entries(configLabels).some(([key, value]) => labels?.[key] !== value)
  )
    throw rejected();
  return {
    imageId,
    daemonImageId,
    repoDigests,
    os,
    architecture,
    labels: configLabels,
  };
}
