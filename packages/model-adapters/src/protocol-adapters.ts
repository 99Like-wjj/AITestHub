import { randomUUID } from 'node:crypto';
import type { ModelProtocol } from '../../contracts/src/model-protocol.js';
import { resolveModelEndpoint } from './model-endpoint.js';
import {
  createModelBudgetCalibration,
  estimateModelBudget,
  ModelImageBudgetError,
  opaqueOutputReserve,
  type ModelBudgetCalibration,
  type ModelBudgetEstimate,
} from './context-budget.js';
import {
  modelContentText,
  serializeModelContent,
  validateModelContent,
} from './model-content.js';
import {
  OpenAiCompatibleAdapter,
  ModelAdapterError,
  maximumNativeModelOutputTokens,
  emptyUsage,
  mergeUsage,
  parseModelRetryAfter,
  checkModelContextFrame,
  modelContextFrameHash,
  type AdapterOptions,
  type ModelContinuation,
  type ModelRequest,
  type ModelResponse,
  type ModelToolCall,
  type TokenUsage,
  type BoundModelContextFrame,
  type ModelMessage,
} from './openai-compatible.js';

export type ModelApiProtocol = ModelProtocol;
export interface NativeModelAdapter {
  readonly maxAttempts: 1;
  readonly model: string;
  complete(request: ModelRequest): Promise<ModelResponse>;
  inspectBudget(request: ModelRequest): ModelBudgetEstimate;
  release(continuation: ModelContinuation): void;
}
type JsonObject = Record<string, unknown>;
type TypedProtocol = Exclude<ModelApiProtocol, 'chatCompletions'>;
interface ProtectedExchange {
  input: unknown[];
  output: unknown[];
  system: string;
  toolIds: string[];
  opaqueTokensReserve: number;
  contextFrame?: BoundModelContextFrame;
}
interface Parsed {
  content: string;
  calls: ModelToolCall[];
  usage: TokenUsage;
  output: unknown[];
  id: string | null;
  model: string;
  finish: string;
}
const object = (value: unknown): JsonObject | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
const identifier = (value: unknown, credential = ''): string | null =>
  typeof value === 'string' &&
  /^[A-Za-z0-9_.:/-]{1,200}$/.test(value) &&
  (!credential || !value.includes(credential))
    ? value
    : null;
const integer = (value: unknown): string | null =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? String(value)
    : typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value)
      ? value
      : null;

/** A direct wire-format adapter. It never switches endpoints, models, keys, or retries. */
class TypedProtocolAdapter implements NativeModelAdapter {
  readonly maxAttempts = 1 as const;
  readonly model: string;
  readonly #endpoint: URL;
  readonly #options: AdapterOptions;
  readonly #history = new WeakMap<ModelContinuation, ProtectedExchange>();
  readonly #calibration: ModelBudgetCalibration;
  constructor(
    readonly protocol: TypedProtocol,
    options: AdapterOptions,
  ) {
    this.model = options.model;
    this.#options = Object.freeze({ ...options });
    this.#calibration =
      options.contextBudgetCalibration ?? createModelBudgetCalibration();
    let endpoint: URL;
    try {
      endpoint = resolveModelEndpoint(options.baseUrl, protocol);
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
      ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname);
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
      !/^[A-Za-z0-9_.:/-]{1,200}$/.test(this.model)
    )
      throw new ModelAdapterError(
        'INVALID_CONFIGURATION',
        'notDispatched',
        randomUUID(),
      );
    this.#endpoint = endpoint;
  }
  release(continuation: ModelContinuation) {
    this.#history.delete(continuation);
  }
  #estimate(body: JsonObject, request: ModelRequest) {
    try {
      return estimateModelBudget(body, {
        protocol: this.protocol,
        ...(this.#options.contextLimit === undefined
          ? {}
          : { contextLimit: this.#options.contextLimit }),
        maxOutput: request.maxTokens,
        calibration: this.#calibration,
        opaqueTokens: request.continuation
          ? (this.#history.get(request.continuation)?.opaqueTokensReserve ?? 0)
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
    const prepared = this.#body(request, randomUUID());
    return this.#estimate(prepared.body, request);
  }

  #body(request: ModelRequest, id: string) {
    for (const message of request.messages)
      validateModelContent(message.content, message.role);
    const invalid = () =>
      new ModelAdapterError('INVALID_REQUEST', 'notDispatched', id);
    if (request.sampling !== undefined) throw invalid();
    if (
      !Number.isSafeInteger(request.maxTokens) ||
      request.maxTokens < 1 ||
      request.maxTokens > maximumNativeModelOutputTokens
    )
      throw invalid();
    if (
      request.reasoningEffort &&
      !/^[a-z][a-z0-9_-]{0,39}$/.test(request.reasoningEffort)
    )
      throw invalid();
    const prior = request.continuation
      ? this.#history.get(request.continuation)
      : undefined;
    if (request.continuation && !prior)
      throw new ModelAdapterError(
        'CONTINUATION_UNAVAILABLE',
        'notDispatched',
        id,
      );
    const identity = checkModelContextFrame(request, prior?.contextFrame, id);
    const serialize = (item: ModelMessage) => ({
      role: item.role,
      content: serializeModelContent(item.content, item.role, this.protocol),
    });
    const prefix =
      request.contextFrame?.prefix
        .filter(
          (item) => this.protocol === 'responses' || item.role !== 'system',
        )
        .map(serialize) ?? [];
    let priorInput = prior?.input ?? [];
    if (identity && prior?.contextFrame && request.contextFrame) {
      if (
        modelContextFrameHash(priorInput[prior.contextFrame.prefixLength]) !==
        modelContextFrameHash(serialize(request.contextFrame.user))
      )
        throw new ModelAdapterError(
          'CONTEXT_FRAME_MISMATCH',
          'notDispatched',
          id,
        );
      priorInput = [
        ...prefix,
        ...priorInput.slice(prior.contextFrame.prefixLength),
      ];
    }
    const contextFrame = identity
      ? { ...identity, prefixLength: prefix.length }
      : undefined;
    const results = request.toolResults ?? [];
    if (results.length && !prior) throw invalid();
    if (
      prior &&
      (new Set(results.map((item) => item.toolCallId)).size !==
        results.length ||
        JSON.stringify(results.map((item) => item.toolCallId).sort()) !==
          JSON.stringify([...prior.toolIds].sort()))
    )
      throw invalid();
    const system = [
      prior?.system ?? '',
      ...request.messages
        .filter((item) => item.role === 'system')
        .map((item) => modelContentText(item.content)),
    ]
      .filter(Boolean)
      .join('\n\n');
    if (contextFrame && this.protocol === 'anthropicMessages') {
      const frameSystem = request.contextFrame?.prefix
        .filter((item) => item.role === 'system')
        .map((item) => modelContentText(item.content))
        .filter(Boolean)
        .join('\n\n');
      // Messages stores system separately. Rebasing must not replace, duplicate
      // or erase the bound authority while changing its ordinary message prefix.
      if (frameSystem !== system)
        throw new ModelAdapterError(
          'CONTEXT_FRAME_MISMATCH',
          'notDispatched',
          id,
        );
    }
    let input: unknown[];
    if (this.protocol === 'responses') {
      input = [
        ...(prior ? [...priorInput, ...prior.output] : []),
        ...results.map((item) => ({
          type: 'function_call_output',
          call_id: item.toolCallId,
          output: item.content,
        })),
        ...request.messages.map((item) => ({
          role: item.role,
          content: serializeModelContent(item.content, item.role, 'responses'),
        })),
      ];
      const body: JsonObject = {
        model: this.model,
        input,
        stream: request.stream === true,
        store: false,
        max_output_tokens: request.maxTokens,
        include: ['reasoning.encrypted_content'],
      };
      if (request.reasoningEffort)
        body.reasoning = { effort: request.reasoningEffort };
      if (request.tools?.length)
        body.tools = request.tools.map((tool) => ({
          type: 'function',
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        }));
      if (request.toolChoice)
        body.tool_choice =
          typeof request.toolChoice === 'string'
            ? request.toolChoice
            : { type: 'function', name: request.toolChoice.name };
      if (request.responseFormat)
        body.text = {
          format:
            request.responseFormat.type === 'json_object'
              ? { type: 'json_object' }
              : {
                  type: 'json_schema',
                  name: request.responseFormat.name,
                  schema: request.responseFormat.schema,
                  strict: request.responseFormat.strict,
                },
        };
      return { body, input, system: '', contextFrame };
    }
    input = [
      ...(prior
        ? [...priorInput, { role: 'assistant', content: prior.output }]
        : []),
      ...(results.length
        ? [
            {
              role: 'user',
              content: results.map((item) => ({
                type: 'tool_result',
                tool_use_id: item.toolCallId,
                content: item.content,
              })),
            },
          ]
        : []),
      ...request.messages
        .filter((item) => item.role !== 'system')
        .map((item) => ({
          role: item.role,
          content: serializeModelContent(
            item.content,
            item.role,
            'anthropicMessages',
          ),
        })),
    ];
    const body: JsonObject = {
      model: this.model,
      messages: input,
      max_tokens: request.maxTokens,
      stream: request.stream === true,
    };
    if (system) body.system = system;
    if (request.tools?.length)
      body.tools = request.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.parameters,
      }));
    if (request.toolChoice)
      body.tool_choice =
        typeof request.toolChoice === 'string'
          ? {
              type:
                request.toolChoice === 'required' ? 'any' : request.toolChoice,
            }
          : { type: 'tool', name: request.toolChoice.name };
    if (request.reasoningEffort === 'none')
      body.thinking = { type: 'disabled' };
    const output: JsonObject = {};
    if (request.reasoningEffort && request.reasoningEffort !== 'none')
      output.effort = request.reasoningEffort;
    if (request.responseFormat?.type === 'json_schema')
      output.format = {
        type: 'json_schema',
        schema: request.responseFormat.schema,
      };
    if (request.responseFormat?.type === 'json_object') throw invalid();
    // Messages requires an explicit JSON schema; never silently drop a requested output mode.
    if (Object.keys(output).length) body.output_config = output;
    return { body, input, system, contextFrame };
  }

  #parse(raw: unknown, id: string, requestId: string | null): Parsed {
    const data = object(raw);
    const bad = () =>
      new ModelAdapterError(
        'INVALID_RESPONSE',
        'responseReceived',
        id,
        requestId,
      );
    if (!data) throw bad();
    const output = this.protocol === 'responses' ? data.output : data.content;
    if (!Array.isArray(output)) throw bad();
    const texts: string[] = [],
      calls: ModelToolCall[] = [];
    for (const rawItem of output) {
      const item = object(rawItem);
      if (!item) throw bad();
      if (this.protocol === 'responses' && item.type === 'message') {
        if (!Array.isArray(item.content)) throw bad();
        for (const block of item.content) {
          const part = object(block);
          if (part?.type === 'refusal')
            throw new ModelAdapterError(
              'OUTPUT_REJECTED',
              'responseReceived',
              id,
              requestId,
            );
          if (part?.type === 'output_text' && typeof part.text === 'string')
            texts.push(part.text);
        }
      } else if (
        this.protocol === 'anthropicMessages' &&
        item.type === 'text' &&
        typeof item.text === 'string'
      )
        texts.push(item.text);
      const isCall =
        this.protocol === 'responses'
          ? item.type === 'function_call'
          : item.type === 'tool_use';
      if (isCall) {
        const toolId = identifier(
            this.protocol === 'responses' ? item.call_id : item.id,
          ),
          name = identifier(item.name);
        let args: unknown = item.input;
        if (this.protocol === 'responses') {
          if (
            typeof item.arguments !== 'string' ||
            Buffer.byteLength(item.arguments) > 1_048_576
          )
            throw bad();
          try {
            args = JSON.parse(item.arguments);
          } catch {
            throw bad();
          }
        }
        if (!toolId || !name || !object(args)) throw bad();
        calls.push({
          id: toolId,
          name,
          arguments: args as ModelToolCall['arguments'],
        });
      }
    }
    if (
      new Set(calls.map((call) => call.id)).size !== calls.length ||
      calls.length > 64
    )
      throw bad();
    const finish =
      this.protocol === 'responses' ? data.status : data.stop_reason;
    if (finish === 'failed' || finish === 'refusal')
      throw new ModelAdapterError(
        'OUTPUT_REJECTED',
        'responseReceived',
        id,
        requestId,
      );
    // A parseable function call is not executable until the provider commits the segment.
    if (
      this.protocol === 'responses'
        ? !['completed', 'incomplete'].includes(String(finish)) ||
          (finish === 'incomplete' && calls.length > 0)
        : !['end_turn', 'stop_sequence', 'max_tokens', 'tool_use'].includes(
            String(finish),
          ) ||
          (calls.length > 0 && finish !== 'tool_use') ||
          (finish === 'tool_use' && calls.length === 0)
    )
      throw bad();
    if (!texts.length && !calls.length) throw bad();
    let usage = mergeUsage(emptyUsage(), data.usage);
    if (this.protocol === 'responses') {
      const source = object(data.usage);
      usage = {
        ...usage,
        cachedInputTokens: integer(
          object(source?.input_tokens_details)?.cached_tokens,
        ),
        reasoningOutputTokens: integer(
          object(source?.output_tokens_details)?.reasoning_tokens,
        ),
      };
    } else {
      // Anthropic does not report total_tokens. Preserve an unknown total; do not invent billing data.
      const source = object(data.usage);
      const input = integer(source?.input_tokens),
        read = integer(source?.cache_read_input_tokens),
        created = integer(source?.cache_creation_input_tokens);
      const hasCache =
        source &&
        (Object.hasOwn(source, 'cache_read_input_tokens') ||
          Object.hasOwn(source, 'cache_creation_input_tokens'));
      usage = {
        ...usage,
        // Messages reports uncached input separately. Cache subcounts must not be lost or double-counted.
        inputTokens: hasCache
          ? input !== null && read !== null && created !== null
            ? String(BigInt(input) + BigInt(read) + BigInt(created))
            : null
          : input,
        totalTokens: null,
        cachedInputTokens: read,
      };
    }
    return {
      content: texts.join(''),
      calls,
      usage,
      output: structuredClone(output),
      id: identifier(data.id),
      model: identifier(data.model) ?? this.model,
      finish:
        finish === 'incomplete' || finish === 'max_tokens'
          ? 'length'
          : calls.length
            ? 'tool_calls'
            : 'stop',
    };
  }

  async #json(
    response: Response,
    limit: number,
    id: string,
    requestId: string | null,
  ) {
    if (!response.body)
      throw new ModelAdapterError(
        'INVALID_RESPONSE',
        'responseReceived',
        id,
        requestId,
      );
    const reader = response.body.getReader(),
      decoder = new TextDecoder();
    let length = 0,
      text = '';
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        length += part.value.byteLength;
        if (length > limit)
          throw new ModelAdapterError(
            'INVALID_RESPONSE',
            'responseReceived',
            id,
            requestId,
          );
        text += decoder.decode(part.value, { stream: true });
      }
      try {
        return JSON.parse(text + decoder.decode()) as unknown;
      } catch {
        throw new ModelAdapterError(
          'INVALID_RESPONSE',
          'responseReceived',
          id,
          requestId,
        );
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }

  async #stream(
    response: Response,
    request: ModelRequest,
    id: string,
    requestId: string | null,
  ) {
    if (
      !response.body ||
      !response.headers
        .get('content-type')
        ?.toLowerCase()
        .startsWith('text/event-stream')
    )
      throw new ModelAdapterError(
        'INVALID_RESPONSE',
        'responseReceived',
        id,
        requestId,
      );
    const reader = response.body.getReader(),
      decoder = new TextDecoder();
    let carry = '',
      length = 0,
      terminal: unknown,
      message: JsonObject | undefined;
    const blocks = new Map<number, JsonObject>(),
      argumentsByIndex = new Map<number, string>();
    const closedBlocks = new Set<number>();
    let messageStopped = false;
    const invalid = () =>
      new ModelAdapterError(
        'INVALID_RESPONSE',
        'responseReceived',
        id,
        requestId,
      );
    const emitted = { text: '' };
    const emit = (text: string) => {
      emitted.text += text;
      try {
        request.onDelta?.({ type: 'text', text });
      } catch {
        throw new ModelAdapterError(
          'OUTPUT_REJECTED',
          'responseReceived',
          id,
          requestId,
        );
      }
    };
    const handle = (raw: unknown) => {
      const event = object(raw);
      if (!event || typeof event.type !== 'string')
        throw new ModelAdapterError(
          'INVALID_RESPONSE',
          'responseReceived',
          id,
          requestId,
        );
      if (event.type === 'error' || event.type === 'response.failed')
        throw new ModelAdapterError(
          'STREAM_INTERRUPTED',
          'responseReceived',
          id,
          requestId,
        );
      if (this.protocol === 'responses') {
        if (event.type === 'response.reasoning_summary_text.delta') {
          if (
            typeof event.delta !== 'string' ||
            !Number.isSafeInteger(event.summary_index) ||
            Number(event.summary_index) < 0 ||
            Number(event.summary_index) > 1000
          )
            throw invalid();
          try {
            request.onDelta?.({
              type: 'summary',
              summaryIndex: Number(event.summary_index),
              text: event.delta,
            });
          } catch {
            throw new ModelAdapterError(
              'OUTPUT_REJECTED',
              'responseReceived',
              id,
              requestId,
            );
          }
        }
        if (
          event.type === 'response.output_text.delta' &&
          typeof event.delta === 'string'
        )
          emit(event.delta);
        if (
          event.type === 'response.completed' ||
          event.type === 'response.incomplete'
        )
          terminal = event.response;
        return;
      }
      if (event.type === 'message_start') {
        if (message || !object(event.message)) throw invalid();
        message = structuredClone(object(event.message));
      }
      if (
        event.type === 'content_block_start' &&
        Number.isSafeInteger(event.index)
      ) {
        const block = object(event.content_block);
        if (
          !message ||
          messageStopped ||
          !block ||
          Number(event.index) < 0 ||
          Number(event.index) > 1024 ||
          blocks.has(Number(event.index))
        )
          throw new ModelAdapterError(
            'INVALID_RESPONSE',
            'responseReceived',
            id,
            requestId,
          );
        blocks.set(Number(event.index), structuredClone(block));
      }
      if (event.type === 'content_block_delta') {
        const index = Number(event.index),
          block = blocks.get(index),
          delta = object(event.delta);
        if (
          !Number.isSafeInteger(event.index) ||
          !block ||
          !delta ||
          messageStopped ||
          closedBlocks.has(index)
        )
          throw new ModelAdapterError(
            'INVALID_RESPONSE',
            'responseReceived',
            id,
            requestId,
          );
        if (delta.type === 'text_delta' && typeof delta.text === 'string') {
          if (block.type !== 'text') throw invalid();
          block.text = String(block.text ?? '') + delta.text;
          emit(delta.text);
        } else if (
          delta.type === 'input_json_delta' &&
          typeof delta.partial_json === 'string'
        ) {
          if (block.type !== 'tool_use') throw invalid();
          const args = (argumentsByIndex.get(index) ?? '') + delta.partial_json;
          if (Buffer.byteLength(args) > 1_048_576)
            throw new ModelAdapterError(
              'INVALID_RESPONSE',
              'responseReceived',
              id,
              requestId,
            );
          argumentsByIndex.set(index, args);
        } else if (
          delta.type === 'thinking_delta' &&
          typeof delta.thinking === 'string'
        ) {
          if (block.type !== 'thinking') throw invalid();
          block.thinking = String(block.thinking ?? '') + delta.thinking;
        } else if (
          delta.type === 'signature_delta' &&
          typeof delta.signature === 'string'
        ) {
          if (block.type !== 'thinking') throw invalid();
          block.signature = String(block.signature ?? '') + delta.signature;
        } else throw invalid();
      }
      if (event.type === 'content_block_stop') {
        const index = Number(event.index);
        if (
          !Number.isSafeInteger(event.index) ||
          !blocks.has(index) ||
          closedBlocks.has(index) ||
          messageStopped
        )
          throw invalid();
        closedBlocks.add(index);
      }
      if (event.type === 'message_delta') {
        if (
          !message ||
          messageStopped ||
          blocks.size !== closedBlocks.size ||
          !object(event.delta)
        )
          throw invalid();
        Object.assign(message, object(event.delta));
        message.usage = { ...object(message.usage), ...object(event.usage) };
        if (
          object(event.delta)?.stop_reason !== undefined &&
          object(event.delta)?.stop_reason !== null
        )
          messageStopped = true;
      }
      if (event.type === 'message_stop') {
        if (!message || !messageStopped || blocks.size !== closedBlocks.size)
          throw new ModelAdapterError(
            'INVALID_RESPONSE',
            'responseReceived',
            id,
            requestId,
          );
        for (const [index, args] of argumentsByIndex) {
          try {
            blocks.get(index)!.input = JSON.parse(args);
          } catch {
            throw new ModelAdapterError(
              'INVALID_RESPONSE',
              'responseReceived',
              id,
              requestId,
            );
          }
        }
        terminal = {
          ...message,
          content: [...blocks.entries()]
            .sort(([a], [b]) => a - b)
            .map(([, block]) => block),
        };
      }
    };
    const frame = (text: string) => {
      const data = text
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n');
      if (!data || data === '[DONE]') return;
      try {
        handle(JSON.parse(data));
      } catch (error) {
        if (error instanceof ModelAdapterError) throw error;
        throw new ModelAdapterError(
          'INVALID_RESPONSE',
          'responseReceived',
          id,
          requestId,
        );
      }
    };
    try {
      while (!terminal) {
        const part = await reader.read();
        if (part.done) break;
        length += part.value.byteLength;
        if (length > (this.#options.maxResponseBytes ?? 16_777_216))
          throw new ModelAdapterError(
            'INVALID_RESPONSE',
            'responseReceived',
            id,
            requestId,
          );
        carry = (carry + decoder.decode(part.value, { stream: true })).replace(
          /\r\n/g,
          '\n',
        );
        let boundary: number;
        while (!terminal && (boundary = carry.indexOf('\n\n')) >= 0) {
          frame(carry.slice(0, boundary));
          carry = carry.slice(boundary + 2);
        }
      }
      carry += decoder.decode();
      if (!terminal && carry.trim()) frame(carry);
      if (!terminal)
        throw new ModelAdapterError(
          'STREAM_INTERRUPTED',
          'responseReceived',
          id,
          requestId,
        );
      const parsed = this.#parse(terminal, id, requestId);
      if (emitted.text && emitted.text !== parsed.content)
        throw new ModelAdapterError(
          'INVALID_RESPONSE',
          'responseReceived',
          id,
          requestId,
        );
      // Some compatible endpoints send the completed output without intermediate deltas.
      // A successfully accepted terminal must not become an empty streamed message.
      if (!emitted.text && parsed.content) emit(parsed.content);
      // Publish tool chunks only after the semantic terminal and all arguments
      // validate. The LangChain streaming bridge consumes deltas, not just the return value.
      try {
        for (const [index, call] of parsed.calls.entries())
          request.onDelta?.({
            type: 'toolCall',
            index,
            id: call.id,
            name: call.name,
            argumentsDelta: JSON.stringify(call.arguments),
          });
      } catch {
        throw new ModelAdapterError(
          'OUTPUT_REJECTED',
          'responseReceived',
          id,
          requestId,
        );
      }
      return parsed;
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    const clientRequestId = randomUUID(),
      prepared = this.#body(request, clientRequestId);
    const estimate = this.#estimate(prepared.body, request);
    this.#options.onContextBudget?.(
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
    let serialized: string;
    try {
      serialized = JSON.stringify(prepared.body);
    } catch {
      throw new ModelAdapterError(
        'INVALID_REQUEST',
        'notDispatched',
        clientRequestId,
      );
    }
    const timeout = new AbortController();
    let timedOut = false,
      dispatched = false,
      requestId: string | null = null;
    const timer = setTimeout(() => {
      timedOut = true;
      timeout.abort();
    }, this.#options.timeoutMs ?? 60000);
    const signal = request.signal
      ? AbortSignal.any([request.signal, timeout.signal])
      : timeout.signal;
    try {
      if (signal.aborted)
        throw new ModelAdapterError(
          'CANCELLED',
          'notDispatched',
          clientRequestId,
        );
      let credential: string;
      try {
        credential = await this.#options.credential();
        // Only HTTP header-safe values; do not turn secret-store failures into network retries.
        if (!credential || /[^\x20-\x7e]/.test(credential)) throw Error();
      } catch {
        throw new ModelAdapterError(
          'MISSING_CREDENTIAL',
          'notDispatched',
          clientRequestId,
        );
      }
      if (
        serialized.includes(credential) ||
        serialized.includes(JSON.stringify(credential).slice(1, -1))
      )
        throw new ModelAdapterError(
          'UNSAFE_MODEL_INPUT',
          'notDispatched',
          clientRequestId,
        );
      const headers = new Headers({
        'content-type': 'application/json',
        'x-client-request-id': clientRequestId,
      });
      if (
        (this.#options.authScheme ??
          (this.protocol === 'responses' ? 'bearer' : 'xApiKey')) === 'bearer'
      )
        headers.set('authorization', `Bearer ${credential}`);
      else headers.set('x-api-key', credential);
      if (this.protocol === 'anthropicMessages')
        headers.set('anthropic-version', '2023-06-01');
      if (signal.aborted)
        throw new ModelAdapterError(
          'CANCELLED',
          'notDispatched',
          clientRequestId,
        );
      try {
        await this.#options.onDispatch?.({
          clientRequestId,
          model: this.model,
          stream: request.stream === true,
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
          'CANCELLED',
          'notDispatched',
          clientRequestId,
        );
      dispatched = true;
      const startedAt = new Date().toISOString();
      const monotonicMs = performance.now();
      const pendingResponse = (this.#options.fetch ?? globalThis.fetch)(
        this.#endpoint,
        {
          method: 'POST',
          headers,
          body: serialized,
          redirect: 'error',
          signal,
        },
      );
      try {
        this.#options.onFetchStarted?.({ startedAt, monotonicMs });
      } catch {
        // A metadata observer cannot turn an already-dispatched request into a retry.
      }
      const response = await pendingResponse;
      requestId = identifier(
        response.headers.get('request-id') ??
          response.headers.get('x-request-id'),
        credential,
      );
      if (!response.ok) {
        let error: JsonObject | undefined;
        try {
          error = object(
            object(
              await this.#json(response, 16384, clientRequestId, requestId),
            )?.error,
          );
        } catch {
          /* no raw provider error is exposed */
        }
        throw new ModelAdapterError(
          'HTTP_ERROR',
          'responseReceived',
          clientRequestId,
          requestId,
          response.status,
          identifier(error?.code, credential),
          identifier(error?.type, credential),
          1,
          parseModelRetryAfter(response.headers),
        );
      }
      const parsed = request.stream
        ? await this.#stream(response, request, clientRequestId, requestId)
        : this.#parse(
            await this.#json(
              response,
              this.#options.maxResponseBytes ?? 16_777_216,
              clientRequestId,
              requestId,
            ),
            clientRequestId,
            requestId,
          );
      const continuation = Object.freeze({
        kind: 'protected-model-continuation' as const,
      });
      this.#history.set(continuation, {
        input: structuredClone(prepared.input),
        output: parsed.output,
        system: prepared.system,
        toolIds: parsed.calls.map((call) => call.id),
        opaqueTokensReserve:
          estimate.components.opaqueTokens +
          opaqueOutputReserve(
            parsed.output,
            parsed.usage.outputTokens,
            estimate.maxOutput,
          ),
        ...(prepared.contextFrame
          ? { contextFrame: prepared.contextFrame }
          : {}),
      });
      this.#calibration.observe(estimate, parsed.usage.inputTokens);
      return {
        content: parsed.content,
        toolCalls: parsed.calls,
        usage: parsed.usage,
        finishReason: parsed.finish,
        requestId,
        providerResponseId: parsed.id,
        clientRequestId,
        model: parsed.model,
        continuation,
        attemptedRequests: 1,
      };
    } catch (error) {
      if (error instanceof ModelAdapterError) throw error;
      throw new ModelAdapterError(
        signal.aborted ? (timedOut ? 'TIMEOUT' : 'CANCELLED') : 'NETWORK_ERROR',
        dispatched ? 'unknown' : 'notDispatched',
        clientRequestId,
        requestId,
      );
    } finally {
      clearTimeout(timer);
    }
  }
}

export function createNativeModelAdapter(
  protocol: ModelApiProtocol,
  options: AdapterOptions,
): NativeModelAdapter {
  if (protocol === 'chatCompletions')
    return new OpenAiCompatibleAdapter(options);
  if (protocol === 'responses' || protocol === 'anthropicMessages')
    return new TypedProtocolAdapter(protocol, options);
  throw new ModelAdapterError(
    'INVALID_CONFIGURATION',
    'notDispatched',
    randomUUID(),
  );
}
