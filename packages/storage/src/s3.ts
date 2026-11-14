import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { finished } from 'node:stream/promises';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { StorageUnavailableError, type StoragePort } from './port.js';

export function s3TransportOptions(
  environment: NodeJS.ProcessEnv = process.env,
) {
  const readMilliseconds = (
    name: string,
    fallback: number,
    maximum: number,
  ): number => {
    const parsed = Number(environment[name] ?? fallback);
    if (!Number.isSafeInteger(parsed) || parsed < 50 || parsed > maximum)
      throw new Error(`${name} is invalid.`);
    return parsed;
  };
  return {
    connectionTimeout: readMilliseconds(
      'AITESTHUB_S3_CONNECT_TIMEOUT_MS',
      5000,
      30000,
    ),
    socketTimeout: readMilliseconds(
      'AITESTHUB_S3_IDLE_TIMEOUT_MS',
      30000,
      120000,
    ),
    requestTimeout: readMilliseconds(
      'AITESTHUB_S3_REQUEST_TIMEOUT_MS',
      600000,
      900000,
    ),
    throwOnRequestTimeout: true,
  };
}

export class S3Storage implements StoragePort {
  constructor(
    private readonly client: S3Client,
    private readonly bucket: string,
  ) {}

  async put(
    key: string,
    body: Readable,
    bytes: number,
    mediaType: string,
  ): Promise<void> {
    const abort = new AbortController();
    const stop = () => abort.abort();
    body.once('error', stop);
    try {
      // Fixed Content-Length can produce an HTTP receipt before a source's final
      // checksum validation. Both stream completion and the S3 receipt are required.
      await Promise.all([
        this.client.send(
          new PutObjectCommand({
            Bucket: this.bucket,
            Key: key,
            Body: body,
            ContentLength: bytes,
            ContentType: mediaType,
          }),
          { abortSignal: abort.signal },
        ),
        finished(body, { cleanup: true }),
      ]);
    } catch {
      abort.abort();
      body.destroy();
      throw new StorageUnavailableError();
    } finally {
      body.off('error', stop);
    }
  }

  async get(key: string): Promise<Readable> {
    try {
      const result = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      if (!(result.Body instanceof Readable))
        throw new StorageUnavailableError();
      return result.Body;
    } catch {
      throw new StorageUnavailableError();
    }
  }
  async exists(key: string): Promise<boolean> {
    try {
      await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      return true;
    } catch (error: unknown) {
      if (
        error &&
        typeof error === 'object' &&
        '$metadata' in error &&
        error.$metadata &&
        typeof error.$metadata === 'object' &&
        'httpStatusCode' in error.$metadata &&
        error.$metadata.httpStatusCode === 404
      )
        return false;
      throw new StorageUnavailableError();
    }
  }

  async delete(key: string): Promise<void> {
    try {
      await this.client.send(
        new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
      );
    } catch {
      throw new StorageUnavailableError();
    }
  }

  close(): void {
    this.client.destroy();
  }
}

export async function createStorageFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<S3Storage> {
  const root =
    environment.AITESTHUB_LOCAL_ROOT ??
    (environment.LOCALAPPDATA === undefined
      ? undefined
      : join(environment.LOCALAPPDATA, 'AITestHub'));
  const accessFile =
    environment.AITESTHUB_S3_ACCESS_KEY_FILE ??
    (root === undefined ? undefined : join(root, 'secrets', 's3-app-access'));
  const secretFile =
    environment.AITESTHUB_S3_SECRET_KEY_FILE ??
    (root === undefined ? undefined : join(root, 'secrets', 's3-app-secret'));
  if (accessFile === undefined || secretFile === undefined)
    throw new Error('S3 secret file configuration is required.');
  let accessKeyId: string;
  let secretAccessKey: string;
  try {
    [accessKeyId, secretAccessKey] = await Promise.all([
      readFile(accessFile, 'utf8'),
      readFile(secretFile, 'utf8'),
    ]);
    accessKeyId = accessKeyId.trim();
    secretAccessKey = secretAccessKey.trim();
  } catch {
    throw new Error('S3 secret files could not be read.');
  }
  if (!accessKeyId || !secretAccessKey)
    throw new Error('S3 secret files are empty.');
  const endpoint = new URL(
    environment.AITESTHUB_S3_ENDPOINT ?? 'http://127.0.0.1:58333',
  );
  if (
    !['http:', 'https:'].includes(endpoint.protocol) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash
  ) {
    throw new Error('AITESTHUB_S3_ENDPOINT is invalid.');
  }
  const bucket = environment.AITESTHUB_S3_BUCKET ?? 'aitesthub-dev';
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket))
    throw new Error('AITESTHUB_S3_BUCKET is invalid.');
  const client = new S3Client({
    requestHandler: s3TransportOptions(environment),
    endpoint: endpoint.href,
    region: environment.AITESTHUB_S3_REGION ?? 'us-east-1',
    credentials: { accessKeyId, secretAccessKey },
    forcePathStyle: true,
    maxAttempts: 1,
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
  return new S3Storage(client, bucket);
}
