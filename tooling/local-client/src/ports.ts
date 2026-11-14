/** Shared client ABI v0.1. Domain packages do not implement HTTP credentials. */
export interface ToolPort {
  /** The official SDK CallToolResult envelope, without a domain-specific wrapper. */
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
}

export interface ResultPort {
  /** Unwrap the official response or throw a classified failure/unknown outcome. */
  read(raw: unknown): unknown;
  /** Structural/known-secret check; not a claim of complete privacy detection. */
  assertSafe(value: unknown): void;
}

/** Only relative keys inside an explicitly approved private working root. */
export interface WorkspacePort {
  readText(key: string): Promise<string | null>;
  writeTextAtomic(key: string, text: string): Promise<void>;
  withExclusive<T>(key: string, work: () => Promise<T>): Promise<T>;
}

export interface FileDigest {
  bytes: string;
  sha256: string;
}

export interface RegisteredFile extends FileDigest {
  fileId: string;
  localFileId: string;
}

export interface VerifiedUpload extends RegisteredFile {
  status: 'verified';
}

/** Platform byte channel only. SUT upload/download tests still use real Ego UI. */
export interface FileChannelPort {
  inspectFile(absolutePath: string): Promise<FileDigest>;
  uploadFile(input: {
    projectId: string;
    runId?: string;
    absolutePath: string;
    localFileId: string;
    originalName: string;
    mediaType: string;
    expected?: FileDigest;
    /** Persist the returned identity before PUT; no key or signed URL is exposed. */
    onRegistered: (file: RegisteredFile) => Promise<void>;
  }): Promise<VerifiedUpload>;
  downloadToFile(input: {
    projectId: string;
    /** A server-provided path at the configured platform origin, never a SUT URL. */
    sourcePath: string;
    destinationPath: string;
    expected?: FileDigest;
  }): Promise<
    FileDigest & {
      absolutePath: string;
      expectedIntegrityMatched: boolean | null;
    }
  >;
}

/** A CUD timeout is unknown. It is never silently converted into an automatic retry. */
export interface ClientFailure extends Error {
  code: string;
  certainty: 'notDispatched' | 'knownFailed' | 'unknown';
  fileId?: string;
  localFileId?: string;
}
