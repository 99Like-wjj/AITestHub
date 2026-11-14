import type { z } from 'zod';
import type { aiModelTimingPayloadSchema } from '../../../contracts/src/ai-presentation.js';
import type { ModelSamplingMetadata } from '../../../contracts/src/model-sampling.js';

/** Process-local monotonic samples; only bounded metadata is persisted at segment end. */
export class ModelTimingSamples {
  requested: {
    at: string;
    monotonic: number;
    sampling?: ModelSamplingMetadata;
  } | null = null;
  firstTextAt: string | null = null;
  firstTextMonotonic: number | null = null;
  firstPersistedAt: string | null = null;
  readonly received: number[] = [];
  readonly persisted: number[] = [];
  textChunks = 0;
  lastReceived: number | null = null;
  lastPersisted: number | null = null;
  receivedText(at: string, monotonic: number) {
    this.firstTextAt ??= at;
    this.firstTextMonotonic ??= monotonic;
    if (this.lastReceived !== null)
      this.received.push(Math.max(0, monotonic - this.lastReceived));
    this.lastReceived = monotonic;
    this.textChunks++;
  }
  committedText(at: string, monotonic: number) {
    this.firstPersistedAt ??= at;
    if (this.lastPersisted !== null)
      this.persisted.push(Math.max(0, monotonic - this.lastPersisted));
    this.lastPersisted = monotonic;
  }
  result(segmentId: string): z.infer<typeof aiModelTimingPayloadSchema> {
    const stats = (values: number[]) => {
      const sorted = [...values].sort((a, b) => a - b);
      const percentile = (fraction: number) =>
        sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] ?? 0;
      return {
        count: values.length,
        p50Ms: percentile(0.5),
        p95Ms: percentile(0.95),
        maxMs: sorted.at(-1) ?? 0,
      };
    };
    return {
      type: 'modelTiming',
      segmentId,
      requestStartedAt: this.requested?.at ?? null,
      firstTextAt: this.firstTextAt,
      firstPersistedAt: this.firstPersistedAt,
      firstTextLatencyMs:
        this.requested && this.firstTextMonotonic !== null
          ? Math.max(0, this.firstTextMonotonic - this.requested.monotonic)
          : null,
      textChunks: this.textChunks,
      receiveIntervals: stats(this.received),
      persistIntervals: stats(this.persisted),
      ...(this.requested?.sampling
        ? { sampling: this.requested.sampling }
        : {}),
    };
  }
}
