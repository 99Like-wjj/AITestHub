import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { ModelAuthScheme } from '../../contracts/src/model-protocol.js';
import { resolveModelEndpoint } from './model-endpoint.js';
import type { ModelContent } from '../../contracts/src/model-content.js';
import { serializeModelContent } from './model-content.js';
import {
  createModelBudgetCalibration,
  estimateModelBudget,
  ModelImageBudgetError,
  opaqueOutputReserve,
  type ModelBudgetCalibration,
  type ModelBudgetEstimate,
} from './context-budget.js';
import {
  resolveModelSampling,
  type ModelSamplingParameters,
  type ModelSamplingMetadata,
} from '../../contracts/src/model-sampling.js';

export type JsonValue = z.infer<ReturnType<typeof z.json>>;
/** Existing native wire safety ceiling, independent of a provider's configured model capacity. */
export const maximumNativeModelOutputTokens = 393_216;
export interface ModelMessage {
  role: 'system' | 'user' | 'assistant';
  content: ModelContent;
}
export interface ModelTool {
  name: string;
  description: string;
  parameters: Record<string, JsonValue>;
}
export interface ModelToolCall {
  id: string;
  name: string;
  arguments: Record<string, JsonValue>;
}
export interface ModelToolResult {
  toolCallId: string;
  content: string;
}
export interface TokenUsage {
  inputTokens: string | null;
  outputTokens: string | null;
  totalTokens: string | null;
  cachedInputTokens: string | null;
  reasoningOutputTokens: string | null;
}
export interface ModelContinuation {
  readonly kind: 'protected-model-continuation';
}
export type ModelDelta =
  | { type: 'text'; text: string }
  // Only an explicit provider-designated public summary. Never raw reasoning.
  | { type: 'summary'; summaryIndex: number; text: string }
  | {
      type: 'toolCall';
      index: number;
      id?: string;
      name?: string;
      argumentsDelta?: string;
    };
export interface ModelRequest {
  messages: readonly ModelMessage[];
  maxTokens: number;
  reasoningEffort?: string;
  /** Optional bounded ChatCompletions parameters. Unset values are not inferred. */
  sampling?: ModelSamplingParameters;
  stream?: boolean;
  tools?: readonly ModelTool[];
  toolChoice?: 'auto' | 'none' | 'required' | { name: string };
  responseFormat?:
    | { type: 'json_object' }
    | {
        type: 'json_schema';
        name: string;
        schema: Record<string, JsonValue>;
        strict: boolean;
      };
  continuation?: ModelContinuation;
  toolResults?: readonly ModelToolResult[];
  signal?: AbortSignal;
  onDelta?: (delta: ModelDelta) => void;
  /** Trusted worker binding only; never a tool/model-supplied input. */
  contextFrame?: {
    scopeId: string;
    user: ModelMessage;
    prefix: readonly ModelMessage[];
  };
}
export interface BoundModelContextFrame {
  scopeId: string;
  userHash: string;
  prefixLength: number;
}
export interface ModelResponse {
  content: string;
  toolCalls: ModelToolCall[];
  usage: TokenUsage;
  finishReason: string;
  requestId: string | null;
  providerResponseId: string | null;
  clientRequestId: string;
  model: string;
  continuation: ModelContinuation;
  attemptedRequests: 1;
}
export type ModelAdapterErrorCode =
  | 'INVALID_CONFIGURATION'
  | 'MISSING_CREDENTIAL'
  | 'INVALID_REQUEST'
  | 'DISPATCH_PRECONDITIONS_FAILED'
  | 'UNSAFE_MODEL_INPUT'
  | 'CONTINUATION_UNAVAILABLE'
  | 'CONTEXT_BUDGET_EXCEEDED'
  | 'IMAGE_BUDGET_UNAVAILABLE'
  | 'CONTEXT_FRAME_MISMATCH'
  | 'HTTP_ERROR'
  | 'NETWORK_ERROR'
  | 'TIMEOUT'
  | 'CANCELLED'
  | 'INVALID_RESPONSE'
  | 'OUTPUT_REJECTED'
  | 'STREAM_INTERRUPTED';
export class ModelAdapterError extends Error {
  constructor(
    readonly code: ModelAdapterErrorCode,
    readonly certainty: 'notDispatched' | 'responseReceived' | 'unknown',
    readonly clientRequestId: string,
    readonly requestId: string | null = null,
    readonly httpStatus: number | null = null,
    readonly providerCode: string | null = null,
    readonly providerType: string | null = null,
    readonly attemptedRequests: 0 | 1 = certainty === 'notDispatched' ? 0 : 1,
    readonly retryAfterMs: number | null = null,
    readonly contextBudget: ModelBudgetEstimate | null = null,
  ) {
    super(
      `Model request ${code.toLowerCase()}; inspect its recorded status before another request.`,
    );
    this.name = 'ModelAdapterError';
  }
}
export interface AdapterOptions {
  baseUrl: string;
  model: string;
  authScheme?: ModelAuthScheme;
  credential: () => Promise<string>;
  timeoutMs?: number;
  maxResponseBytes?: number;
  fetch?: typeof globalThis.fetch;
  /** For isolated loopback fixtures only, never arbitrary plaintext HTTP. */
  allowLocalHttp?: boolean;
  contextLimit?: number;
  contextBudgetCalibration?: ModelBudgetCalibration;
  onContextBudget?: (estimate: Readonly<ModelBudgetEstimate>) => void;
  onDispatch?: (attempt: {
    clientRequestId: string;
    model: string;
    stream: boolean;
  }) => void | Promise<void>;
  /** Metadata emitted immediately after fetch is invoked; it never authorizes a request. */
  onFetchStarted?: (timing: {
    startedAt: string;
    monotonicMs: number;
    sampling?: ModelSamplingMetadata;
  }) => void;
}
/** Stable equality for trusted frame boundaries, never provider/body logging. */
export function modelContextFrameHash(value: unknown): string {
  const canonical = (entry: unknown): unknown => {
    if (Array.isArray(entry)) return entry.map(canonical);
    if (entry === null || typeof entry !== 'object') return entry;
    return Object.fromEntries(
      Object.entries(entry)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => [key, canonical(child)]),
    );
  };
  return createHash('sha256')
    .update(JSON.stringify(canonical(value)) ?? 'undefined')
    .digest('hex');
}
export function checkModelContextFrame(
  request: ModelRequest,
  prior: BoundModelContextFrame | undefined,
  clientRequestId: string,
): Omit<BoundModelContextFrame, 'prefixLength'> | undefined {
  const frame = request.contextFrame;
  if (!frame && !prior) return undefined;
  const invalid = () =>
    new ModelAdapterError(
      'CONTEXT_FRAME_MISMATCH',
      'notDispatched',
      clientRequestId,
    );
  if (
    !frame ||
    typeof frame.scopeId !== 'string' ||
    !/^[A-Za-z0-9:_-]{1,256}$/.test(frame.scopeId) ||
    frame.user.role !== 'user' ||
    !Array.isArray(frame.prefix) ||
    frame.prefix.length > 2000
  )
    throw invalid();
  const userHash = modelContextFrameHash(frame.user);
  if (request.continuation) {
    if (
      !prior ||
      prior.scopeId !== frame.scopeId ||
      prior.userHash !== userHash
    )
      throw invalid();
  } else if (
    prior ||
    modelContextFrameHash(request.messages) !==
      modelContextFrameHash([...frame.prefix, frame.user])
  )
    throw invalid();
  return { scopeId: frame.scopeId, userHash };
}
/** Keep only bounded timing advice; provider response bodies stay private. */
export function parseModelRetryAfter(
  headers: Headers,
  now = Date.now(),
): number | null {
  const milliseconds = headers.get('retry-after-ms');
  if (milliseconds !== null && /^\d+(?:\.\d+)?$/.test(milliseconds.trim())) {
    const value = Number(milliseconds);
    return Number.isFinite(value)
      ? Math.min(Math.ceil(value), Number.MAX_SAFE_INTEGER)
      : Number.MAX_SAFE_INTEGER;
  }
  const raw = headers.get('retry-after')?.trim();
  if (!raw) return null;
  if (/^\d+$/.test(raw)) {
    const value = Number(raw) * 1000;
    return Number.isFinite(value)
      ? Math.min(value, Number.MAX_SAFE_INTEGER)
      : Number.MAX_SAFE_INTEGER;
  }
  if (!/(?:GMT|UTC)$/i.test(raw)) return null;
  const date = Date.parse(raw);
  return Number.isFinite(date) ? Math.max(0, date - now) : null;
}
interface ProviderToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}
interface ProviderAssistant {
  role: 'assistant';
  content: string | null;
  tool_calls?: ProviderToolCall[];
  reasoning_content?: string;
}
interface ProtectedHistory {
  messages: unknown[];
  assistant: ProviderAssistant;
  toolIds: string[];
  opaqueTokensReserve: number;
  contextFrame?: BoundModelContextFrame;
}
interface ToolAccumulator {
  id: string;
  name: string;
  arguments: string;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
function count(value: unknown): string | null {
  if (typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value))
    return value;
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? String(value)
    : null;
}
export function emptyUsage(): TokenUsage {
  return {
    inputTokens: null,
    outputTokens: null,
    totalTokens: null,
    cachedInputTokens: null,
    reasoningOutputTokens: null,
  };
}
/** Usage chunks are cumulative snapshots, never deltas to sum; cache/reasoning are included subcounts. */
export function mergeUsage(previous: TokenUsage, source: unknown): TokenUsage {
  const usage = record(source);
  if (!usage) return previous;
  return {
    inputTokens:
      count(usage.prompt_tokens) ??
      count(usage.input_tokens) ??
      previous.inputTokens,
    outputTokens:
      count(usage.completion_tokens) ??
      count(usage.output_tokens) ??
      previous.outputTokens,
    totalTokens: count(usage.total_tokens) ?? previous.totalTokens,
    cachedInputTokens:
      count(record(usage.prompt_tokens_details)?.cached_tokens) ??
      count(usage.prompt_cache_hit_tokens) ??
      previous.cachedInputTokens,
    reasoningOutputTokens:
      count(record(usage.completion_tokens_details)?.reasoning_tokens) ??
      previous.reasoningOutputTokens,
  };
}
function identifier(value: unknown): string | null {
  return typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,200}$/.test(value)
    ? value
    : null;
}

async function safeErrorCategories(
  response: Response,
  credential: string,
): Promise<{ code: string | null; type: string | null }> {
  const category = (value: unknown) =>
    typeof value === 'string' &&
    /^[A-Za-z0-9_.-]{1,80}$/.test(value) &&
    value !== credential
      ? value
      : null;
  const empty = { code: null, type: null };
  if (!response.body) return empty;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 16_384) return empty;
      text += decoder.decode(chunk.value, { stream: true });
    }
    const error = record(record(JSON.parse(text + decoder.decode()))?.error);
    return { code: category(error?.code), type: category(error?.type) };
  } catch {
    return empty;
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export class OpenAiCompatibleAdapter {
  readonly maxAttempts = 1;
  readonly model: string;
  readonly #endpoint: URL;
  readonly #credential: () => Promise<string>;
  readonly #timeoutMs: number;
  readonly #maxResponseBytes: number;
  readonly #fetch: typeof globalThis.fetch;
  readonly #onDispatch: AdapterOptions['onDispatch'];
  readonly #onFetchStarted: AdapterOptions['onFetchStarted'];
  readonly #authScheme: ModelAuthScheme;
  readonly #continuations = new WeakMap<ModelContinuation, ProtectedHistory>();
  readonly #contextLimit: number | undefined;
  readonly #calibration: ModelBudgetCalibration;
  readonly #onContextBudget: AdapterOptions['onContextBudget'];

  constructor(options: AdapterOptions) {
    let endpoint: URL;
    try {
      endpoint = resolveModelEndpoint(options.baseUrl, 'chatCompletions');
    } catch {
      throw new ModelAdapterError(
        'INVALID_CONFIGURATION',
        'notDispatched',
        randomUUID(),
      );
    }
    const local =
      options.allowLocalHttp === true &&
      endpoint.protocol === 'http:' &&
      ['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname);
    if (
      (!local && endpoint.protocol !== 'https:') ||
      endpoint.username ||
      endpoint.password ||
      endpoint.search ||
      endpoint.hash ||
      (options.authScheme !== undefined &&
        !['bearer', 'xApiKey'].includes(options.authScheme)) ||
      (options.contextLimit !== undefined &&
        (!Number.isSafeInteger(options.contextLimit) ||
          options.contextLimit < 1)) ||
      !/^[A-Za-z0-9_.:/-]{1,200}$/.test(options.model)
    ) {
      throw new ModelAdapterError(
        'INVALID_CONFIGURATION',
        'notDispatched',
        randomUUID(),
      );
    }
    this.model = options.model;
    this.#endpoint = endpoint;
    this.#credential = options.credential;
    this.#contextLimit = options.contextLimit;
    this.#calibration =
      options.contextBudgetCalibration ?? createModelBudgetCalibration();
    this.#onContextBudget = options.onContextBudget;
    this.#timeoutMs = options.timeoutMs ?? 60_000;
    this.#maxResponseBytes = options.maxResponseBytes ?? 8 * 1024 * 1024;
    if (
      !Number.isSafeInteger(this.#timeoutMs) ||
      this.#timeoutMs < 1 ||
      this.#timeoutMs > 600_000 ||
      !Number.isSafeInteger(this.#maxResponseBytes) ||
      this.#maxResponseBytes < 1
    ) {
      throw new ModelAdapterError(
        'INVALID_CONFIGURATION',
        'notDispatched',
        randomUUID(),
      );
    }
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#onDispatch = options.onDispatch;
    this.#onFetchStarted = options.onFetchStarted;
    this.#authScheme = options.authScheme ?? 'bearer';
  }

  release(continuation: ModelContinuation): void {
    this.#continuations.delete(continuation);
  }

  #prepare(request: ModelRequest, clientRequestId: string) {
    let messages: unknown[];
    let contextFrame: BoundModelContextFrame | undefined;
    try {
      const prepared = this.#messages(request, clientRequestId);
      messages = prepared.messages;
      contextFrame = prepared.contextFrame;
    } catch (error: unknown) {
      if (error instanceof ModelAdapterError) throw error;
      throw new ModelAdapterError(
        'INVALID_REQUEST',
        'notDispatched',
        clientRequestId,
      );
    }
    if (
      !Number.isSafeInteger(request.maxTokens) ||
      request.maxTokens < 1 ||
      request.maxTokens > maximumNativeModelOutputTokens
    ) {
      throw new ModelAdapterError(
        'INVALID_REQUEST',
        'notDispatched',
        clientRequestId,
      );
    }
    const body: Record<string, unknown> = {
      model: this.model,
      messages,
      max_tokens: request.maxTokens,
      stream: request.stream ?? false,
    };
    let serialized: string;
    let sampling: ModelSamplingMetadata = { profileId: null, parameters: {} };
    try {
      sampling = resolveModelSampling(request.sampling);
      Object.assign(body, sampling.parameters);
      if (request.reasoningEffort !== undefined)
        body.reasoning_effort = z
          .string()
          .regex(/^[a-z][a-z0-9_-]{0,39}$/)
          .parse(request.reasoningEffort);
      if (request.stream) body.stream_options = { include_usage: true };
      if (request.tools) {
        if (
          new Set(request.tools.map((tool) => tool.name)).size !==
            request.tools.length ||
          request.tools.length > 128
        ) {
          throw new ModelAdapterError(
            'INVALID_REQUEST',
            'notDispatched',
            clientRequestId,
          );
        }
        body.tools = request.tools.map((tool) => ({
          type: 'function',
          function: {
            name: z
              .string()
              .regex(/^[A-Za-z0-9_-]{1,128}$/)
              .parse(tool.name),
            description: tool.description,
            parameters: z.record(z.string(), z.json()).parse(tool.parameters),
          },
        }));
      }
      if (request.toolChoice)
        body.tool_choice =
          typeof request.toolChoice === 'string'
            ? request.toolChoice
            : { type: 'function', function: { name: request.toolChoice.name } };
      if (request.responseFormat)
        body.response_format =
          request.responseFormat.type === 'json_object'
            ? request.responseFormat
            : {
                type: 'json_schema',
                json_schema: {
                  name: request.responseFormat.name,
                  schema: request.responseFormat.schema,
                  strict: request.responseFormat.strict,
                },
              };
      serialized = JSON.stringify(z.json().parse(body));
    } catch (error: unknown) {
      if (error instanceof ModelAdapterError) throw error;
      throw new ModelAdapterError(
        'INVALID_REQUEST',
        'notDispatched',
        clientRequestId,
      );
    }
    return { body, messages, serialized, sampling, contextFrame };
  }
  #estimate(body: Record<string, unknown>, request: ModelRequest) {
    try {
      return estimateModelBudget(body, {
        protocol: 'chatCompletions',
        ...(this.#contextLimit === undefined
          ? {}
          : { contextLimit: this.#contextLimit }),
        maxOutput: request.maxTokens,
        calibration: this.#calibration,
        opaqueTokens: request.continuation
          ? (this.#continuations.get(request.continuation)
              ?.opaqueTokensReserve ?? 0)
          : 0,
      });
    } catch (error: unknown) {
      if (error instanceof ModelImageBudgetError)
        throw new ModelAdapterError(
          'IMAGE_BUDGET_UNAVAILABLE',
          'notDispatched',
          randomUUID(),
        );
      throw error;
    }
  }
  inspectBudget(request: ModelRequest): ModelBudgetEstimate {
    const prepared = this.#prepare(request, randomUUID());
    return this.#estimate(prepared.body, request);
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    const clientRequestId = randomUUID();
    if (request.signal?.aborted)
      throw new ModelAdapterError(
        'CANCELLED',
        'notDispatched',
        clientRequestId,
      );
    const { body, messages, serialized, sampling, contextFrame } =
      this.#prepare(request, clientRequestId);
    const estimate = this.#estimate(body, request);
    this.#onContextBudget?.(
      Object.freeze({
        ...estimate,
        components: Object.freeze({ ...estimate.components }),
      }),
    );
    if (!estimate.fits)
      throw new ModelAdapterError(
        'CONTEXT_BUDGET_EXCEEDED',
        'notDispatched',
        clientRequestId,
        null,
        null,
        null,
        null,
        0,
        null,
        estimate,
      );
    let key: string;
    try {
      key = (await this.#credential()).trim();
    } catch {
      throw new ModelAdapterError(
        'MISSING_CREDENTIAL',
        'notDispatched',
        clientRequestId,
      );
    }
    if (key.length < 8 || !/^[\x21-\x7e]+$/.test(key))
      throw new ModelAdapterError(
        'MISSING_CREDENTIAL',
        'notDispatched',
        clientRequestId,
      );
    if (
      serialized.includes(key) ||
      serialized.includes(JSON.stringify(key).slice(1, -1))
    )
      throw new ModelAdapterError(
        'UNSAFE_MODEL_INPUT',
        'notDispatched',
        clientRequestId,
      );
    const timerController = new AbortController();
    const signal = request.signal
      ? AbortSignal.any([request.signal, timerController.signal])
      : timerController.signal;
    const timer = setTimeout(() => timerController.abort(), this.#timeoutMs);
    let requestId: string | null = null;
    let invoked = false;
    try {
      try {
        await this.#onDispatch?.({
          clientRequestId,
          model: this.model,
          stream: request.stream ?? false,
        });
      } catch {
        throw new ModelAdapterError(
          'DISPATCH_PRECONDITIONS_FAILED',
          'notDispatched',
          clientRequestId,
        );
      }
      if (signal.aborted)
        throw new ModelAdapterError(
          request.signal?.aborted ? 'CANCELLED' : 'TIMEOUT',
          'notDispatched',
          clientRequestId,
        );
      invoked = true;
      const startedAt = new Date().toISOString();
      const monotonicMs = performance.now();
      const pendingResponse = this.#fetch(this.#endpoint, {
        method: 'POST',
        redirect: 'error',
        signal,
        headers: {
          ...(this.#authScheme === 'bearer'
            ? { Authorization: `Bearer ${key}` }
            : { 'x-api-key': key }),
          'Content-Type': 'application/json',
          Accept: request.stream ? 'text/event-stream' : 'application/json',
          'X-Client-Request-ID': clientRequestId,
        },
        body: serialized,
      });
      try {
        this.#onFetchStarted?.({ startedAt, monotonicMs, sampling });
      } catch {
        // A metadata observer cannot turn an already-dispatched request into a retry.
      }
      const response = await pendingResponse;
      requestId =
        identifier(response.headers.get('x-request-id')) ??
        identifier(response.headers.get('request-id'));
      if (!response.ok) {
        const category = await safeErrorCategories(response, key);
        throw new ModelAdapterError(
          'HTTP_ERROR',
          'responseReceived',
          clientRequestId,
          requestId,
          response.status,
          category.code,
          category.type,
          1,
          parseModelRetryAfter(response.headers),
        );
      }
      const answer = request.stream
        ? await this.#stream(
            response,
            request,
            messages,
            clientRequestId,
            requestId,
          )
        : await this.#nonStream(response, messages, clientRequestId, requestId);
      const history = this.#continuations.get(answer.continuation);
      if (history) {
        if (contextFrame) history.contextFrame = contextFrame;
        history.opaqueTokensReserve =
          estimate.components.opaqueTokens +
          opaqueOutputReserve(
            history.assistant,
            answer.usage.outputTokens,
            estimate.maxOutput,
          );
      }
      this.#calibration.observe(estimate, answer.usage.inputTokens);
      return answer;
    } catch (error: unknown) {
      if (error instanceof ModelAdapterError) throw error;
      if (request.signal?.aborted)
        throw new ModelAdapterError(
          'CANCELLED',
          invoked ? 'unknown' : 'notDispatched',
          clientRequestId,
          requestId,
        );
      if (timerController.signal.aborted)
        throw new ModelAdapterError(
          'TIMEOUT',
          invoked ? 'unknown' : 'notDispatched',
          clientRequestId,
          requestId,
        );
      throw new ModelAdapterError(
        'NETWORK_ERROR',
        invoked ? 'unknown' : 'notDispatched',
        clientRequestId,
        requestId,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  #messages(request: ModelRequest, clientRequestId: string) {
    const serialize = (message: ModelMessage) => ({
      role: z.enum(['system', 'user', 'assistant']).parse(message.role),
      content: serializeModelContent(
        message.content,
        message.role,
        'chatCompletions',
      ),
    });
    const messages: unknown[] = request.messages.map(serialize);
    if (request.continuation) {
      const history = this.#continuations.get(request.continuation);
      if (!history)
        throw new ModelAdapterError(
          'CONTINUATION_UNAVAILABLE',
          'notDispatched',
          clientRequestId,
        );
      if (
        !request.toolResults ||
        request.toolResults.length !== history.toolIds.length ||
        new Set(request.toolResults.map((item) => item.toolCallId)).size !==
          history.toolIds.length ||
        request.toolResults.some(
          (item) => !history.toolIds.includes(item.toolCallId),
        )
      ) {
        throw new ModelAdapterError(
          'INVALID_REQUEST',
          'notDispatched',
          clientRequestId,
        );
      }
      const identity = checkModelContextFrame(
        request,
        history.contextFrame,
        clientRequestId,
      );
      const prefix = request.contextFrame?.prefix.map(serialize) ?? [];
      let historical = history.messages;
      if (identity && history.contextFrame && request.contextFrame) {
        if (
          modelContextFrameHash(
            historical[history.contextFrame.prefixLength],
          ) !== modelContextFrameHash(serialize(request.contextFrame.user))
        )
          throw new ModelAdapterError(
            'CONTEXT_FRAME_MISMATCH',
            'notDispatched',
            clientRequestId,
          );
        historical = [
          ...prefix,
          ...historical.slice(history.contextFrame.prefixLength),
        ];
      }
      // Only the authenticated pre-user prefix can change. Every native item
      // from the fixed current user onward remains byte-for-byte in order.
      return {
        messages: [
          ...historical,
          history.assistant,
          ...request.toolResults.map((result) => ({
            role: 'tool',
            tool_call_id: result.toolCallId,
            content: z.string().max(1_000_000).parse(result.content),
          })),
          ...messages,
        ],
        contextFrame: identity
          ? { ...identity, prefixLength: prefix.length }
          : undefined,
      };
    }
    if (
      request.toolResults?.length ||
      messages.length === 0 ||
      messages.length > 2000
    ) {
      throw new ModelAdapterError(
        'INVALID_REQUEST',
        'notDispatched',
        clientRequestId,
      );
    }
    const identity = checkModelContextFrame(
      request,
      undefined,
      clientRequestId,
    );
    return {
      messages,
      contextFrame: identity
        ? {
            ...identity,
            prefixLength: request.contextFrame?.prefix.length ?? 0,
          }
        : undefined,
    };
  }

  async #readText(
    response: Response,
    clientRequestId: string,
    requestId: string | null,
  ): Promise<string> {
    if (!response.body)
      throw new ModelAdapterError(
        'INVALID_RESPONSE',
        'responseReceived',
        clientRequestId,
        requestId,
      );
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let size = 0;
    let text = '';
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > this.#maxResponseBytes)
          throw new ModelAdapterError(
            'INVALID_RESPONSE',
            'responseReceived',
            clientRequestId,
            requestId,
          );
        text += decoder.decode(part.value, { stream: true });
      }
      return text + decoder.decode();
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }

  async #nonStream(
    response: Response,
    messages: unknown[],
    clientRequestId: string,
    requestId: string | null,
  ): Promise<ModelResponse> {
    try {
      const raw: unknown = JSON.parse(
        await this.#readText(response, clientRequestId, requestId),
      );
      const root = record(raw);
      const choices = root?.choices;
      const choice = Array.isArray(choices) ? record(choices[0]) : undefined;
      const message = record(choice?.message);
      if (!root || !message || typeof choice?.finish_reason !== 'string')
        throw new Error('Invalid completion shape');
      const content =
        typeof message.content === 'string' ? message.content : '';
      const tools = this.#parseToolCalls(message.tool_calls);
      if (
        message.content !== null &&
        typeof message.content !== 'string' &&
        !(message.content === undefined && tools.length > 0)
      )
        throw new Error('Invalid completion content');
      return this.#response(
        messages,
        content,
        tools,
        typeof message.reasoning_content === 'string'
          ? message.reasoning_content
          : '',
        mergeUsage(emptyUsage(), root.usage),
        choice.finish_reason,
        identifier(root.id),
        clientRequestId,
        requestId,
      );
    } catch (error: unknown) {
      if (error instanceof ModelAdapterError) throw error;
      // Raw provider content, reasoning and error bodies never escape through an exception.
      if (
        error instanceof Error &&
        ['AbortError', 'TimeoutError'].includes(error.name)
      )
        throw error;
      throw new ModelAdapterError(
        'INVALID_RESPONSE',
        'responseReceived',
        clientRequestId,
        requestId,
      );
    }
  }

  #parseToolCalls(source: unknown): ModelToolCall[] {
    if (source === undefined || source === null) return [];
    const parsed = z
      .array(
        z.object({
          id: z.string().min(1).max(256),
          type: z.literal('function'),
          function: z.object({
            name: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
            arguments: z.string().max(1_000_000),
          }),
        }),
      )
      .max(128)
      .parse(source)
      .map((call) => ({
        id: call.id,
        name: call.function.name,
        arguments: z
          .record(z.string(), z.json())
          .parse(JSON.parse(call.function.arguments)),
      }));
    if (new Set(parsed.map((call) => call.id)).size !== parsed.length)
      throw new Error('Duplicate tool call ID');
    return parsed;
  }

  #emitDelta(
    request: ModelRequest,
    delta: ModelDelta,
    clientRequestId: string,
    requestId: string | null,
  ): void {
    try {
      request.onDelta?.(delta);
    } catch {
      throw new ModelAdapterError(
        'OUTPUT_REJECTED',
        'responseReceived',
        clientRequestId,
        requestId,
      );
    }
  }
  async #stream(
    response: Response,
    request: ModelRequest,
    messages: unknown[],
    clientRequestId: string,
    requestId: string | null,
  ): Promise<ModelResponse> {
    if (
      !response.body ||
      !response.headers
        .get('content-type')
        ?.toLowerCase()
        .includes('text/event-stream')
    ) {
      await response.body?.cancel();
      throw new ModelAdapterError(
        'INVALID_RESPONSE',
        'responseReceived',
        clientRequestId,
        requestId,
      );
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let size = 0;
    let done = false;
    let content = '';
    let reasoning = '';
    let finishReason: string | null = null;
    let responseId: string | null = null;
    let usage = emptyUsage();
    const calls = new Map<number, ToolAccumulator>();
    const event = (raw: string) => {
      const data = raw
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).replace(/^ /, ''))
        .join('\n');
      if (!data) return;
      if (data.trim() === '[DONE]') {
        done = true;
        return;
      }
      const root = record(JSON.parse(data));
      if (!root || root.error) throw new Error('Invalid streaming payload');
      responseId = identifier(root.id) ?? responseId;
      usage = mergeUsage(usage, root.usage);
      if (!Array.isArray(root.choices)) throw new Error('Missing choices');
      if (!root.choices.length) return;
      const choice = record(root.choices[0]);
      const delta = record(choice?.delta);
      if (!choice || !delta) throw new Error('Missing delta');
      if (typeof choice.finish_reason === 'string')
        finishReason = choice.finish_reason;
      if (typeof delta.content === 'string' && delta.content) {
        content += delta.content;
        this.#emitDelta(
          request,
          { type: 'text', text: delta.content },
          clientRequestId,
          requestId,
        );
      }
      if (typeof delta.reasoning_content === 'string')
        reasoning += delta.reasoning_content;
      if (delta.tool_calls !== undefined) {
        if (!Array.isArray(delta.tool_calls))
          throw new Error('Invalid tool deltas');
        for (const rawCall of delta.tool_calls) {
          const call = record(rawCall);
          if (
            !call ||
            typeof call.index !== 'number' ||
            !Number.isInteger(call.index) ||
            call.index < 0 ||
            call.index >= 128
          )
            throw new Error('Invalid tool index');
          const accumulated = calls.get(call.index) ?? {
            id: '',
            name: '',
            arguments: '',
          };
          const fn = record(call.function);
          if (typeof call.id === 'string') {
            if (accumulated.id && accumulated.id !== call.id)
              throw new Error('Tool ID changed');
            accumulated.id = call.id;
          }
          if (typeof fn?.name === 'string') accumulated.name += fn.name;
          if (typeof fn?.arguments === 'string')
            accumulated.arguments += fn.arguments;
          calls.set(call.index, accumulated);
          this.#emitDelta(
            request,
            {
              type: 'toolCall',
              index: call.index,
              ...(typeof call.id === 'string' ? { id: call.id } : {}),
              ...(typeof fn?.name === 'string' ? { name: fn.name } : {}),
              ...(typeof fn?.arguments === 'string'
                ? { argumentsDelta: fn.arguments }
                : {}),
            },
            clientRequestId,
            requestId,
          );
        }
      }
    };
    try {
      while (!done) {
        const part = await reader.read().catch((error: unknown) => {
          if (
            error instanceof ModelAdapterError ||
            (error instanceof Error &&
              ['AbortError', 'TimeoutError'].includes(error.name))
          )
            throw error;
          throw new ModelAdapterError(
            'STREAM_INTERRUPTED',
            'unknown',
            clientRequestId,
            requestId,
          );
        });
        if (part.done) break;
        size += part.value.byteLength;
        if (size > this.#maxResponseBytes)
          throw new Error('Stream size exceeded');
        buffer += decoder.decode(part.value, { stream: true });
        // Normalize CRLF only after complete lines; a chunk may split the CR and LF.
        let separator: RegExpExecArray | null;
        while ((separator = /\r?\n\r?\n/.exec(buffer)) !== null) {
          event(buffer.slice(0, separator.index).replace(/\r\n/g, '\n'));
          buffer = buffer.slice(separator.index + separator[0].length);
          if (done) break;
        }
      }
      if (!done || finishReason === null)
        throw new ModelAdapterError(
          'STREAM_INTERRUPTED',
          'unknown',
          clientRequestId,
          requestId,
        );
      const tools = this.#parseToolCalls(
        [...calls.entries()]
          .sort(([a], [b]) => a - b)
          .map(([, call]) => ({
            id: call.id,
            type: 'function',
            function: { name: call.name, arguments: call.arguments },
          })),
      );
      return this.#response(
        messages,
        content,
        tools,
        reasoning,
        usage,
        finishReason,
        responseId,
        clientRequestId,
        requestId,
      );
    } catch (error: unknown) {
      if (error instanceof ModelAdapterError) throw error;
      if (
        error instanceof Error &&
        ['AbortError', 'TimeoutError'].includes(error.name)
      )
        throw error;
      throw new ModelAdapterError(
        'INVALID_RESPONSE',
        'unknown',
        clientRequestId,
        requestId,
      );
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }

  #response(
    messages: unknown[],
    content: string,
    toolCalls: ModelToolCall[],
    reasoning: string,
    usage: TokenUsage,
    finishReason: string,
    providerResponseId: string | null,
    clientRequestId: string,
    requestId: string | null,
  ): ModelResponse {
    const continuation: ModelContinuation = Object.freeze({
      kind: 'protected-model-continuation',
    });
    const assistant: ProviderAssistant = {
      role: 'assistant',
      content: content || null,
      ...(toolCalls.length
        ? {
            tool_calls: toolCalls.map((call) => ({
              id: call.id,
              type: 'function',
              function: {
                name: call.name,
                arguments: JSON.stringify(call.arguments),
              },
            })),
          }
        : {}),
      ...(reasoning ? { reasoning_content: reasoning } : {}),
    };
    this.#continuations.set(continuation, {
      messages,
      assistant,
      toolIds: toolCalls.map((call) => call.id),
      opaqueTokensReserve: 0,
    });
    return {
      content,
      toolCalls,
      usage,
      finishReason,
      requestId,
      providerResponseId,
      clientRequestId,
      model: this.model,
      continuation,
      attemptedRequests: 1,
    };
  }
}
