export class WorkerProtocolError extends Error {
  constructor(
    readonly code: string,
    readonly status = 0,
  ) {
    super(`Worker control request failed: ${code}`);
  }
}
/** Metadata/file-private protocol only. No target retry is hidden here. */
export class WorkerClient {
  constructor(
    private readonly baseUrl: string,
    private readonly bootstrap: string,
  ) {}
  private async request(
    path: string,
    body: unknown,
    credential: string,
    signal?: AbortSignal,
  ): Promise<Response> {
    const timeout = AbortSignal.timeout(15000);
    try {
      return await fetch(
        `${this.baseUrl.replace(/\/$/, '')}/api/internal/api-worker/${path}`,
        {
          method: 'POST',
          redirect: 'error',
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
          headers: {
            authorization: `Bearer ${credential}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify(body),
        },
      );
    } catch {
      throw new WorkerProtocolError('CONTROL_UNAVAILABLE');
    }
  }
  private async call(
    path: string,
    body: unknown,
    credential: string,
  ): Promise<unknown> {
    const response = await this.request(path, body, credential);
    let value: unknown;
    try {
      value = await response.json();
    } catch {
      throw new WorkerProtocolError(
        'CONTROL_RESPONSE_INVALID',
        response.status,
      );
    }
    if (!response.ok) {
      const code =
        typeof value === 'object' &&
        value !== null &&
        'error' in value &&
        typeof value.error === 'object' &&
        value.error !== null &&
        'code' in value.error &&
        typeof value.error.code === 'string'
          ? value.error.code
          : 'CONTROL_REJECTED';
      throw new WorkerProtocolError(
        /^[A-Z][A-Z0-9_]{0,99}$/.test(code) ? code : 'CONTROL_REJECTED',
        response.status,
      );
    }
    return value;
  }
  claim(
    workerInstanceId: string,
    desiredRunId?: string,
    desiredRequestId?: string,
  ) {
    return this.call(
      'claim',
      {
        workerInstanceId,
        ...(desiredRunId ? { desiredRunId } : {}),
        ...(desiredRequestId ? { desiredRequestId } : {}),
      },
      this.bootstrap,
    );
  }
  load(grant: string) {
    return this.call('load', {}, grant);
  }
  heartbeat(grant: string) {
    return this.call('heartbeat', {}, grant);
  }
  begin(grant: string, runItemId: string) {
    return this.call('begin', { runItemId }, grant);
  }
  authorize(grant: string, body: unknown) {
    return this.call('authorize', body, grant);
  }
  async multipartFile(
    grant: string,
    intentId: string,
    fileResourceId: string,
    expectedBytes: number,
    signal?: AbortSignal,
  ) {
    const response = await this.request(
      'multipart-file',
      { intentId, fileResourceId },
      grant,
      signal,
    );
    const unavailable = () =>
      new WorkerProtocolError('REQUEST_FILE_UNAVAILABLE', response.status);
    if (!response.ok || !response.body) {
      await response.body?.cancel().catch(() => {});
      throw unavailable();
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const result = await reader.read();
        if (result.done) break;
        size += result.value.byteLength;
        if (size > expectedBytes) throw unavailable();
        chunks.push(result.value);
      }
      if (size !== expectedBytes) throw unavailable();
      return Buffer.concat(chunks, size);
    } catch {
      await reader.cancel().catch(() => {});
      throw unavailable();
    } finally {
      reader.releaseLock();
    }
  }
  completeAttempt(grant: string, body: unknown) {
    return this.call('response', body, grant);
  }
  localFailure(grant: string, body: unknown) {
    return this.call('local-failure', body, grant);
  }
  completeCase(grant: string, body: unknown) {
    return this.call('case-complete', body, grant);
  }
  finish(grant: string) {
    return this.call('finish', {}, grant);
  }
  abandon(grant: string) {
    return this.call('abandon', {}, grant);
  }
}
