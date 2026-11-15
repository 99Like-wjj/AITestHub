import {
  createNativeModelAdapter,
  ModelAdapterError,
  emptyUsage,
} from '../../../model-adapters/src/index.js';
import type { ModelConnectionProbePort } from './model-connections.js';

/** Explicit one-shot inference. No project context, tools, automatic retry,
 * provider text, or credential value is part of its public result. */
export function createModelConnectionProbePort(
  options: { fetch?: typeof globalThis.fetch } = {},
): ModelConnectionProbePort {
  return {
    executionOrigin: 'liveProvider',
    async run(input) {
      const protectedValues = new Set<string>();
      const safeRequestId = (value: string | null) =>
        value && [...protectedValues].some((secret) => value.includes(secret))
          ? null
          : value;
      const native = createNativeModelAdapter(input.protocol, {
        baseUrl: input.baseUrl,
        model: input.modelId,
        authScheme: input.authScheme,
        credential: async () => {
          const credential = await input.credential();
          for (const wireValue of [credential, credential.trim()]) {
            if (!wireValue) continue;
            for (const value of [
              wireValue,
              encodeURIComponent(wireValue),
              Buffer.from(wireValue).toString('base64'),
              Buffer.from(wireValue).toString('base64url'),
              Buffer.from(wireValue).toString('hex'),
              Buffer.from(wireValue).toString('hex').toUpperCase(),
            ])
              protectedValues.add(value);
          }
          return credential;
        },
        allowLocalHttp: true,
        timeoutMs: 60_000,
        ...(options.fetch ? { fetch: options.fetch } : {}),
        onDispatch: ({ clientRequestId }) => input.dispatched(clientRequestId),
      });
      try {
        const result = await native.complete({
          messages: [
            {
              role: 'user',
              content: 'Connection test. Reply with the word OK.',
            },
          ],
          maxTokens: input.maxTokens,
          stream: true,
          ...(input.effort ? { reasoningEffort: input.effort } : {}),
        });
        native.release(result.continuation);
        return {
          state:
            result.content.trim() &&
            result.finishReason === 'stop' &&
            !result.toolCalls.length
              ? 'connected'
              : 'failed',
          code:
            result.content.trim() &&
            result.finishReason === 'stop' &&
            !result.toolCalls.length
              ? null
              : 'INCOMPLETE_TEXT_RESPONSE',
          upstreamHttpStatus: null,
          attemptedRequests: result.attemptedRequests,
          dispatchCertainty: 'responseReceived',
          clientRequestId: result.clientRequestId,
          providerRequestId: safeRequestId(result.requestId),
          usage: result.usage,
        };
      } catch (error) {
        if (!(error instanceof ModelAdapterError)) throw error;
        return {
          state: error.certainty === 'unknown' ? 'unknown' : 'failed',
          code: error.code,
          upstreamHttpStatus: error.httpStatus,
          attemptedRequests: error.attemptedRequests,
          dispatchCertainty: error.certainty,
          clientRequestId: error.clientRequestId,
          providerRequestId: safeRequestId(error.requestId),
          usage: emptyUsage(),
        };
      }
    },
  };
}
