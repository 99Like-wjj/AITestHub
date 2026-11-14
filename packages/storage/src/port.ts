import type { Readable } from 'node:stream';

/** Bytes only. Logical resource authorization remains in application services. */
export interface StoragePort {
  put(
    key: string,
    body: Readable,
    bytes: number,
    mediaType: string,
  ): Promise<void>;
  get(key: string): Promise<Readable>;
  delete(key: string): Promise<void>;
  exists?(key: string): Promise<boolean>;
  close(): void;
}

export class StorageUnavailableError extends Error {
  constructor() {
    super('Private object storage is unavailable.');
  }
}
