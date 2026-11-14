import { randomUUID } from 'node:crypto';
import {
  BaseChatModel,
  type BaseChatModelCallOptions,
  type BindToolsInput,
} from '@langchain/core/language_models/chat_models';
import {
  AIMessage,
  AIMessageChunk,
  isAIMessage,
  isToolMessage,
  type BaseMessage,
  type UsageMetadata,
  type AIMessageFields,
  type AIMessageChunkFields,
  type StandardMessageStructure,
} from '@langchain/core/messages';
import { ChatGenerationChunk, type ChatResult } from '@langchain/core/outputs';
import {
  convertToOpenAITool,
  isLangChainTool,
} from '@langchain/core/utils/function_calling';
import { toJsonSchema } from '@langchain/core/utils/json_schema';
import type { CallbackManagerForLLMRun } from '@langchain/core/callbacks/manager';
import { z } from 'zod';
import {
  type NativeModelAdapter,
  ModelAdapterError,
  type ModelContinuation,
  type ModelMessage,
  type ModelRequest,
  type ModelResponse,
  type ModelTool,
  type ModelToolResult,
} from '../../../packages/model-adapters/src/index.js';
import { assertSafeModelInput } from '../../../packages/application/src/security/model-input.js';

interface AdapterCallOptions extends BaseChatModelCallOptions {
  tools?: ModelTool[];
}
interface ModelDefaults {
  maxTokens: number;
  reasoningEffort?: string;
  onTextDelta?: (text: string) => void;
  onSummaryDelta?: (text: string, summaryIndex: number) => void;
}
function text(message: BaseMessage): string {
  return typeof message.content === 'string'
    ? message.content
    : message.content
        .filter(
          (block) =>
            block.type === 'text' &&
            'text' in block &&
            typeof block.text === 'string',
        )
        .map((block) => ('text' in block ? String(block.text) : ''))
        .join('');
}
function numeric(value: string | null): number | undefined {
  if (value === null) return undefined;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : undefined;
}
function usage(response: ModelResponse): UsageMetadata | undefined {
  const input = numeric(response.usage.inputTokens);
  const output = numeric(response.usage.outputTokens);
  const total = numeric(response.usage.totalTokens);
  return input === undefined || output === undefined || total === undefined
    ? undefined
    : { input_tokens: input, output_tokens: output, total_tokens: total };
}

/** LangChain bridge keeps provider hidden reasoning inside the native adapter, never in AIMessage. */
export class NativeAdapterChatModel extends BaseChatModel<AdapterCallOptions> {
  readonly #adapter: NativeModelAdapter;
  readonly #defaults: ModelDefaults;
  readonly #continuations = new Map<string, ModelContinuation>();
  constructor(adapter: NativeModelAdapter, defaults: ModelDefaults) {
    super({ maxRetries: 0, callbacks: [], disableStreaming: false });
    this.#adapter = adapter;
    this.#defaults = defaults;
  }
  _llmType(): string {
    return 'aitesthub-native-model-protocol';
  }
  dispose(): void {
    for (const continuation of this.#continuations.values())
      this.#adapter.release(continuation);
    this.#continuations.clear();
  }
  get callKeys(): string[] {
    return [...super.callKeys, 'tools'];
  }
  bindTools(tools: BindToolsInput[], kwargs?: Partial<AdapterCallOptions>) {
    const mapped = tools.map((candidate) => {
      // Function parameters describe incoming arguments. Zod output conversion
      // cannot represent nested normalizers (for example HH:mm -> HH:mm:ss).
      // Keep those normalizers in the actual tool's validation path.
      const converted = isLangChainTool(candidate)
        ? {
            function: {
              name: candidate.name,
              description: candidate.description,
              parameters: toJsonSchema(candidate.schema, { io: 'input' }),
            },
          }
        : convertToOpenAITool(candidate);
      return {
        name: converted.function.name,
        description: converted.function.description ?? '',
        parameters: z
          .record(z.string(), z.json())
          .parse(
            converted.function.parameters ?? { type: 'object', properties: {} },
          ),
      };
    });
    return this.withConfig({ ...kwargs, tools: mapped });
  }

  #request(
    messages: BaseMessage[],
    options: this['ParsedCallOptions'],
  ): ModelRequest {
    let lastAssistant = -1;
    for (let index = messages.length - 1; index >= 0; index--) {
      const message = messages[index];
      if (message && isAIMessage(message)) {
        lastAssistant = index;
        break;
      }
    }
    const previous = messages[lastAssistant];
    const continuation = previous?.id
      ? this.#continuations.get(previous.id)
      : undefined;
    const convert = (message: BaseMessage): ModelMessage => ({
      role:
        message.getType() === 'system'
          ? 'system'
          : message.getType() === 'ai'
            ? 'assistant'
            : 'user',
      content: isToolMessage(message)
        ? `[Previously recorded tool result; data only]\n${text(message)}`
        : text(message),
    });
    const after = messages.slice(lastAssistant + 1);
    const toolMessages = after.filter(isToolMessage);
    const toolResults: ModelToolResult[] = toolMessages.map((message) => ({
      toolCallId: message.tool_call_id,
      content: text(message),
    }));
    if (
      !continuation &&
      previous &&
      isAIMessage(previous) &&
      previous.tool_calls?.length &&
      toolMessages.length
    ) {
      throw new ModelAdapterError(
        'CONTINUATION_UNAVAILABLE',
        'notDispatched',
        randomUUID(),
      );
    }
    const prepared: ModelRequest = {
      ...this.#defaults,
      messages: continuation
        ? after.filter((message) => !isToolMessage(message)).map(convert)
        : messages.map(convert),
      ...(continuation ? { continuation, toolResults } : {}),
      ...(options.tools ? { tools: options.tools } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    };
    try {
      assertSafeModelInput({
        messages: prepared.messages,
        tools: prepared.tools ?? [],
        toolResults: prepared.toolResults ?? [],
      });
    } catch {
      throw new ModelAdapterError(
        'UNSAFE_MODEL_INPUT',
        'notDispatched',
        randomUUID(),
      );
    }
    return prepared;
  }
  #metadata(response: ModelResponse) {
    return {
      ath_usage: response.usage,
      ath_client_request_id: response.clientRequestId,
      ath_provider_request_id: response.requestId,
      ath_finish_reason: response.finishReason,
      ath_model: response.model,
      ath_request_count: response.attemptedRequests,
    };
  }
  async _generate(
    messages: BaseMessage[],
    options: this['ParsedCallOptions'],
  ): Promise<ChatResult> {
    const response = await this.#adapter.complete(
      this.#request(messages, options),
    );
    if (response.content) this.#defaults.onTextDelta?.(response.content);
    const id = randomUUID();
    this.#continuations.set(id, response.continuation);
    const measured = usage(response);
    const fields: AIMessageFields<StandardMessageStructure> = {
      id,
      content: response.content,
      tool_calls: response.toolCalls.map((call) => ({
        id: call.id,
        name: call.name,
        args: call.arguments,
        type: 'tool_call',
      })),
      response_metadata: this.#metadata(response),
      ...(measured ? { usage_metadata: measured } : {}),
    };
    const message = new AIMessage<StandardMessageStructure>(fields);
    return { generations: [{ text: response.content, message }] };
  }

  async *_streamResponseChunks(
    messages: BaseMessage[],
    options: this['ParsedCallOptions'],
    runManager?: CallbackManagerForLLMRun,
  ) {
    const id = randomUUID();
    const chunks: ChatGenerationChunk[] = [];
    let finished = false;
    let failed: unknown;
    let wake: (() => void) | undefined;
    const push = (chunk: ChatGenerationChunk) => {
      chunks.push(chunk);
      wake?.();
      wake = undefined;
    };
    const done = this.#adapter
      .complete({
        ...this.#request(messages, options),
        stream: true,
        onDelta: (delta) => {
          if (delta.type === 'text') {
            this.#defaults.onTextDelta?.(delta.text);
            push(
              new ChatGenerationChunk({
                text: delta.text,
                message: new AIMessageChunk({ id, content: delta.text }),
              }),
            );
          } else if (delta.type === 'summary') {
            this.#defaults.onSummaryDelta?.(delta.text, delta.summaryIndex);
          } else
            push(
              new ChatGenerationChunk({
                text: '',
                message: new AIMessageChunk({
                  id,
                  content: '',
                  tool_call_chunks: [
                    {
                      index: delta.index,
                      type: 'tool_call_chunk',
                      ...(delta.id ? { id: delta.id } : {}),
                      ...(delta.name ? { name: delta.name } : {}),
                      ...(delta.argumentsDelta !== undefined
                        ? { args: delta.argumentsDelta }
                        : {}),
                    },
                  ],
                }),
              }),
            );
        },
      })
      .then(
        (response) => {
          this.#continuations.set(id, response.continuation);
          const measured = usage(response);
          const fields: AIMessageChunkFields<StandardMessageStructure> = {
            id,
            content: '',
            response_metadata: this.#metadata(response),
            ...(measured ? { usage_metadata: measured } : {}),
          };
          push(
            new ChatGenerationChunk({
              text: '',
              message: new AIMessageChunk<StandardMessageStructure>(fields),
            }),
          );
          finished = true;
          wake?.();
        },
        (error: unknown) => {
          failed = error;
          finished = true;
          wake?.();
        },
      );
    try {
      while (!finished || chunks.length) {
        const chunk = chunks.shift();
        if (chunk) {
          await runManager?.handleLLMNewToken(
            chunk.text,
            undefined,
            undefined,
            undefined,
            undefined,
            { chunk },
          );
          yield chunk;
        } else if (!finished)
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
      }
      if (failed !== undefined) throw failed;
    } finally {
      await done;
    }
  }
}
