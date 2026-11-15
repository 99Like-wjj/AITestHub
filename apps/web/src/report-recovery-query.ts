export type ReportRecoveryKind = 'run' | 'result' | 'submission';

export type ReportRecoveryQuery = Readonly<{
  ownerId: string;
  identityEpoch: number;
  projectId: string;
  kind: ReportRecoveryKind;
  value: string;
}>;

export type ReportRecoveryRequest = Readonly<{
  query: ReportRecoveryQuery;
  generation: number;
  signal: AbortSignal;
}>;

export class ReportRecoveryQueryGuard {
  #generation = 0;
  #controller: AbortController | null = null;
  #request: ReportRecoveryRequest | null = null;

  invalidate() {
    this.#generation += 1;
    this.#controller?.abort();
    this.#controller = null;
    this.#request = null;
  }

  begin(query: ReportRecoveryQuery): ReportRecoveryRequest {
    this.invalidate();
    this.#controller = new AbortController();
    this.#request = Object.freeze({
      query: Object.freeze({ ...query }),
      generation: this.#generation,
      signal: this.#controller.signal,
    });
    return this.#request;
  }

  accepts(request: ReportRecoveryRequest, query: ReportRecoveryQuery | null) {
    return (
      this.#request === request &&
      request.generation === this.#generation &&
      !request.signal.aborted &&
      query !== null &&
      request.query.ownerId === query.ownerId &&
      request.query.identityEpoch === query.identityEpoch &&
      request.query.projectId === query.projectId &&
      request.query.kind === query.kind &&
      request.query.value === query.value
    );
  }
}
