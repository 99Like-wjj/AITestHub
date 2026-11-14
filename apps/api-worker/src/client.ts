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
  private async call(
    path: string,
    body: unknown,
    credential: string,
  ): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(
        `${this.baseUrl.replace(/\/$/, '')}/api/internal/api-worker/${path}`,
        {
          method: 'POST',
          redirect: 'error',
          signal: AbortSignal.timeout(15000),
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
