import { z } from 'zod';
import {
  sendMessageInputSchema,
  taskAcceptedSchema,
  type SendMessageInput,
} from '../../../packages/contracts/src/conversations';

const itemSchema = z.strictObject({
  input: sendMessageInputSchema,
  label: z.string().max(1000),
  createdAt: z.string(),
  state: z.enum(['queued', 'dispatching', 'unknown', 'failed']),
  error: z.string().nullable(),
});
const queueSchema = z.strictObject({
  conversationId: z.uuid(),
  items: z.array(itemSchema).max(10),
  blockingTaskId: z.uuid().nullable(),
  paused: z.string().nullable(),
  cancel: z
    .strictObject({
      taskId: z.uuid(),
      commandId: z.uuid(),
      dispatched: z.boolean(),
    })
    .nullable(),
});
export const savedWorkspaceQueueSchema = z.array(queueSchema).max(100);
export type WorkspaceQueuedMessage = z.infer<typeof itemSchema>;
export type WorkspaceConversationQueue = z.infer<typeof queueSchema>;
type Accepted = Pick<
  z.infer<typeof taskAcceptedSchema>,
  'taskId' | 'userMessageId' | 'assistantMessageId'
>;

export interface WorkspaceQueuePorts {
  active: () => boolean;
  persist: (queues: WorkspaceConversationQueue[]) => void;
  changed: () => void;
  wait: () => Promise<void>;
  status: (
    taskId: string,
  ) => Promise<{ terminal: boolean; safeToContinue: boolean }>;
  cancel: (taskId: string, commandId: string) => Promise<void>;
  send: (conversationId: string, input: SendMessageInput) => Promise<Accepted>;
  receipt: (conversationId: string, commandId: string) => Promise<Accepted>;
  accepted: (conversationId: string, receipt: Accepted) => void;
  uncertain: (error: unknown) => boolean;
  errorText: (error: unknown) => string;
}

/** Per-owner/per-conversation draft queue. Only accepted receipts create chat
 * messages. An interrupted connection is never treated as a finished task. */
export class WorkspaceSendQueue {
  readonly queues = new Map<string, WorkspaceConversationQueue>();
  readonly running = new Set<string>();
  private readonly recovering = new Set<string>();
  private readonly wake = new Map<string, () => void>();
  constructor(
    private readonly ports: WorkspaceQueuePorts,
    saved: unknown = [],
  ) {
    const parsed = savedWorkspaceQueueSchema.safeParse(saved);
    if (!parsed.success)
      throw new Error('待发消息草稿不符合当前格式，请保留原记录后核对。');
    for (const queue of parsed.data) {
      for (const item of queue.items)
        if (item.state === 'dispatching') item.state = 'unknown';
      this.queues.set(queue.conversationId, queue);
    }
  }
  snapshot(conversationId: string) {
    return this.queues.get(conversationId);
  }
  private save() {
    this.ports.persist([...this.queues.values()]);
    this.ports.changed();
  }
  enqueue(
    conversationId: string,
    input: SendMessageInput,
    label: string,
    blockingTaskId: string | null,
    interrupt = false,
  ) {
    z.uuid().parse(conversationId);
    const queue = this.queues.get(conversationId) ?? {
      conversationId,
      items: [],
      blockingTaskId,
      paused: null,
      cancel: null,
    };
    const existed = this.queues.has(conversationId);
    const previous = { ...queue, items: [...queue.items] };
    if (queue.items.length >= 10)
      throw new Error('本对话最多保留 10 条待发消息，请先处理已有队列。');
    if (queue.items.some((item) => item.state !== 'queued'))
      throw new Error('队列中有待核对的原提交，请先处理其回执。');
    if (queue.items.some((item) => item.input.commandId === input.commandId))
      return;
    const item = itemSchema.parse({
      input,
      label,
      createdAt: new Date().toISOString(),
      state: 'queued',
      error: null,
    });
    if (!queue.items.length) {
      queue.blockingTaskId = blockingTaskId;
      queue.cancel = null;
      queue.paused = null;
    }
    if (interrupt) queue.items.unshift(item);
    else queue.items.push(item);
    queue.blockingTaskId ??= blockingTaskId;
    if (interrupt && queue.blockingTaskId)
      queue.cancel = {
        taskId: queue.blockingTaskId,
        commandId: crypto.randomUUID(),
        dispatched: false,
      };
    this.queues.set(conversationId, queue);
    try {
      this.save();
    } catch (error) {
      Object.assign(queue, previous);
      if (!existed) this.queues.delete(conversationId);
      this.ports.changed();
      throw error;
    }
    if (interrupt) this.wake.get(conversationId)?.();
    void this.pump(conversationId);
  }
  remove(conversationId: string, commandId: string) {
    const queue = this.queues.get(conversationId);
    const item = queue?.items.find(
      (entry) => entry.input.commandId === commandId,
    );
    if (!queue || !item) return;
    if (item.state === 'dispatching' || item.state === 'unknown')
      throw new Error('原提交受理情况尚未确认，请先查回执。');
    const previous = { ...queue, items: [...queue.items] };
    queue.items = queue.items.filter((entry) => entry !== item);
    if (!queue.items.length) queue.paused = null;
    try {
      this.save();
    } catch (error) {
      Object.assign(queue, previous);
      this.ports.changed();
      throw error;
    }
  }
  prioritize(conversationId: string, commandId: string, taskId: string | null) {
    const queue = this.queues.get(conversationId);
    if (!queue || queue.items.some((item) => item.state !== 'queued')) return;
    const item = queue.items.find(
      (entry) => entry.input.commandId === commandId,
    );
    if (!item) return;
    const previous = { ...queue, items: [...queue.items] };
    queue.items = [item, ...queue.items.filter((entry) => entry !== item)];
    queue.blockingTaskId ??= taskId;
    if (queue.blockingTaskId)
      queue.cancel = {
        taskId: queue.blockingTaskId,
        commandId: crypto.randomUUID(),
        dispatched: false,
      };
    try {
      this.save();
    } catch (error) {
      Object.assign(queue, previous);
      this.ports.changed();
      throw error;
    }
    this.wake.get(conversationId)?.();
    void this.pump(conversationId);
  }
  async recover(conversationId: string) {
    const queue = this.queues.get(conversationId);
    const item = queue?.items[0];
    if (
      !queue ||
      !item ||
      this.running.has(conversationId) ||
      this.recovering.has(conversationId) ||
      !this.ports.active()
    )
      return;
    this.recovering.add(conversationId);
    try {
      if (item.state === 'unknown' || item.state === 'dispatching') {
        try {
          const receipt = await this.ports.receipt(
            conversationId,
            item.input.commandId,
          );
          if (
            !this.ports.active() ||
            this.queues.get(conversationId) !== queue ||
            queue.items[0] !== item
          )
            return;
          queue.items = queue.items.filter((entry) => entry !== item);
          queue.blockingTaskId = receipt.taskId;
          queue.paused = null;
          this.save();
          this.ports.accepted(conversationId, receipt);
        } catch (error) {
          if (!queue.items.includes(item)) queue.items.unshift(item);
          item.state = 'unknown';
          queue.paused =
            '原回执尚未核实，未重新发送。' + this.ports.errorText(error);
          this.save();
          return;
        }
      } else {
        // Status is checked again; this cannot override an unknown/unfinished task.
        queue.paused = null;
        this.save();
      }
    } finally {
      this.recovering.delete(conversationId);
    }
    await this.pump(conversationId);
  }
  resume() {
    for (const queue of this.queues.values())
      if (queue.items.length) void this.pump(queue.conversationId);
  }
  async pump(conversationId: string) {
    const queue = this.queues.get(conversationId);
    if (
      !queue ||
      this.running.has(conversationId) ||
      this.recovering.has(conversationId) ||
      queue.paused
    )
      return;
    this.running.add(conversationId);
    try {
      while (queue.items.length && this.ports.active() && !queue.paused) {
        if (queue.cancel && !queue.cancel.dispatched) {
          queue.cancel.dispatched = true;
          this.save();
          try {
            await this.ports.cancel(
              queue.cancel.taskId,
              queue.cancel.commandId,
            );
          } catch (error) {
            queue.paused =
              '停止请求的回执待核对；队列未发送。' +
              this.ports.errorText(error);
            this.save();
            break;
          }
        }
        if (queue.blockingTaskId) {
          const status = await this.ports.status(queue.blockingTaskId);
          if (!this.ports.active()) break;
          if (!status.terminal) {
            if (queue.cancel && !queue.cancel.dispatched) continue;
            try {
              await Promise.race([
                this.ports.wait(),
                new Promise<void>((resolve) =>
                  this.wake.set(conversationId, resolve),
                ),
              ]);
            } finally {
              this.wake.delete(conversationId);
            }
            continue;
          }
          if (!status.safeToContinue) {
            queue.paused =
              '上一轮任务或工具结果尚未确认，请核对原回执；待发消息已保留。';
            this.save();
            break;
          }
          queue.blockingTaskId = null;
          queue.cancel = null;
          this.save();
        }
        const item = queue.items[0];
        if (!item) break;
        if (item.state !== 'queued') {
          queue.paused = '请核对原提交回执，队列不会自动重发。';
          this.save();
          break;
        }
        item.state = 'dispatching';
        this.save();
        let accepted: Accepted | undefined;
        try {
          const receipt = await this.ports.send(conversationId, item.input);
          accepted = receipt;
          if (!this.ports.active()) break;
          queue.items = queue.items.filter((entry) => entry !== item);
          queue.blockingTaskId = receipt.taskId;
          this.save();
          this.ports.accepted(conversationId, receipt);
        } catch (error) {
          if (!queue.items.includes(item)) queue.items.unshift(item);
          item.state =
            accepted || this.ports.uncertain(error) ? 'unknown' : 'failed';
          item.error = this.ports.errorText(error);
          queue.paused = item.error;
          this.save();
        }
      }
    } catch (error) {
      queue.paused =
        '队列已暂停，待发消息已保留。' + this.ports.errorText(error);
      try {
        this.save();
      } catch {
        this.ports.changed();
      }
    } finally {
      this.running.delete(conversationId);
    }
  }
}
