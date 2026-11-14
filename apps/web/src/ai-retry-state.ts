export interface AiRetryState {
  layer: 'events' | 'model';
  phase: 'waiting' | 'connecting' | 'exhausted' | 'paused';
  /** Retries exclude the original attempt. Zero is the initial event connection. */
  attempt: number;
  maxAttempts: number;
  nextAttemptAt: number | null;
  reason: string | null;
}
