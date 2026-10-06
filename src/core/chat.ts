import OpenAI from "openai";
import { SpicyApiError, isTerminal, type RequestOptions, type TaskRecord } from "@spicyapi/sdk";
import type { ChatMessage } from "./characters.js";
import type { SpendLedger, SpendVerdict } from "./ledger.js";
import { NANOS_PER_USD, parseUsd, type Nanos } from "./money.js";

export interface ChatUsage {
  promptTokens: number;
  completionTokens: number;
}

export interface ChatStreamRequest {
  model: string;
  messages: ChatMessage[];
  maxTokens: number;
  idempotencyKey: string;
  signal?: AbortSignal;
}

export interface ChatStream {
  /** The task that holds the charge (`X-Spicy-Task-Id`); absent in rare cases, see below. */
  taskId: string | undefined;
  deltas: AsyncIterable<string>;
  /** Filled in once `deltas` is exhausted, when the server reported usage. */
  usage(): ChatUsage | undefined;
}

export type ChatStreamer = (request: ChatStreamRequest) => Promise<ChatStream>;

/** Streams through the official `openai` package pointed at SpicyAPI's OpenAI-compatible endpoint. */
export function openAiStreamer(client: OpenAI): ChatStreamer {
  return async (request) => {
    const { data, response } = await client.chat.completions
      .create(
        {
          model: request.model,
          messages: request.messages,
          max_tokens: request.maxTokens,
          stream: true,
          stream_options: { include_usage: true },
        },
        { headers: { "Idempotency-Key": request.idempotencyKey }, ...(request.signal ? { signal: request.signal } : {}) },
      )
      .withResponse();
    let usage: ChatUsage | undefined;
    async function* deltas(): AsyncGenerator<string> {
      try {
        for await (const chunk of data) {
          const piece = chunk.choices[0]?.delta?.content;
          if (piece) yield piece;
          if (chunk.usage) usage = { promptTokens: chunk.usage.prompt_tokens, completionTokens: chunk.usage.completion_tokens };
        }
      } finally {
        data.controller.abort();
      }
    }
    return { taskId: response.headers.get("x-spicy-task-id") ?? undefined, deltas: deltas(), usage: () => usage };
  };
}

export function createOpenAiClient(apiKey: string, baseURL: string): OpenAI {
  // maxRetries 0: never silently repeat a billable request.
  return new OpenAI({ apiKey, baseURL, maxRetries: 0, timeout: 180_000 });
}

export interface TaskLookup {
  getTask(taskId: string, options?: RequestOptions): Promise<TaskRecord>;
}

export interface ChatRequest {
  user: string;
  owner: boolean;
  model: string;
  messages: ChatMessage[];
  idempotencyKey: string;
  /** USD per 1K tokens for this model's output, from the catalogue; used for the hold estimate. */
  pricePer1k: Nanos | undefined;
  onText?: (fullText: string) => void;
  signal?: AbortSignal;
}

export type ChatOutcome =
  | { kind: "done"; text: string; charged: Nanos; taskId: string | undefined }
  | { kind: "blocked"; verdict: Exclude<SpendVerdict, { ok: true }> };

/** When the catalogue has no price for the model, hold this much while the reply streams. */
const FALLBACK_HOLD: Nanos = 0.05 * NANOS_PER_USD;

/** A generous token estimate for the prompt: about three characters per token. */
export function estimateHold(messages: readonly ChatMessage[], maxTokens: number, pricePer1k: Nanos | undefined): Nanos {
  if (pricePer1k === undefined) return FALLBACK_HOLD;
  const promptChars = messages.reduce((sum, message) => sum + message.content.length, 0);
  const tokens = Math.ceil(promptChars / 3) + maxTokens;
  return Math.ceil((tokens * pricePer1k) / 1000);
}

/** Upper-bound cost from usage when no task record is available: every token at the output rate. */
export function costFromUsage(usage: ChatUsage, pricePer1k: Nanos | undefined): Nanos | undefined {
  if (pricePer1k === undefined) return undefined;
  return Math.ceil(((usage.promptTokens + usage.completionTokens) * pricePer1k) / 1000);
}

/**
 * One chat reply: hold an estimate, stream, then settle against the task SpicyAPI created for it.
 */
export interface ChatRunnerOptions {
  log?: (message: string) => void;
  /** Reads of the task after the stream ends, waiting for the final charge. */
  settleAttempts?: number;
  settleDelayMs?: number;
}

export class ChatRunner {
  private readonly log: (message: string) => void;
  private readonly settleAttempts: number;
  private readonly settleDelayMs: number;

  constructor(
    private readonly streamer: ChatStreamer,
    private readonly tasks: TaskLookup,
    private readonly ledger: SpendLedger,
    private readonly maxTokens: number,
    options: ChatRunnerOptions = {},
  ) {
    this.log = options.log ?? (() => {});
    this.settleAttempts = Math.max(1, options.settleAttempts ?? 3);
    this.settleDelayMs = options.settleDelayMs ?? 1500;
  }

  async run(request: ChatRequest): Promise<ChatOutcome> {
    const hold = estimateHold(request.messages, this.maxTokens, request.pricePer1k);
    const reserved = this.ledger.reserve(request.user, hold, { kind: "chat", exemptFromUserCap: request.owner });
    if (!reserved.ok) return { kind: "blocked", verdict: reserved };
    const holdId = reserved.holdId;

    let stream: ChatStream;
    try {
      stream = await this.streamer({
        model: request.model,
        messages: request.messages,
        maxTokens: this.maxTokens,
        idempotencyKey: request.idempotencyKey,
        ...(request.signal ? { signal: request.signal } : {}),
      });
    } catch (error) {
      const taskId = error instanceof OpenAI.APIError ? (error.headers?.get("x-spicy-task-id") ?? undefined) : undefined;
      if (taskId) this.ledger.attachTask(holdId, taskId);
      else this.ledger.release(holdId);
      throw error;
    }
    if (stream.taskId) this.ledger.attachTask(holdId, stream.taskId);

    let text = "";
    try {
      for await (const piece of stream.deltas) {
        text += piece;
        request.onText?.(text);
      }
    } catch (error) {
      // Interrupted mid-stream: what was delivered is billed. Settle from the task when we can.
      await this.settle(holdId, stream, request.pricePer1k);
      throw error;
    }
    const charged = await this.settle(holdId, stream, request.pricePer1k);
    this.log(`chat ${stream.taskId ?? "(no task id)"} done, cost about ${charged / NANOS_PER_USD} USD`);
    return { kind: "done", text, charged, taskId: stream.taskId };
  }

  private async settle(holdId: string, stream: ChatStream, pricePer1k: Nanos | undefined): Promise<Nanos> {
    if (stream.taskId) {
      try {
        // The charge is usually final within a second or two of the last token.
        for (let attempt = 1; ; attempt++) {
          const task = await this.tasks.getTask(stream.taskId);
          const cost = parseUsd(task.cost) ?? 0;
          if (task.settled && isTerminal(task)) {
            this.ledger.settle(holdId, cost);
            return cost;
          }
          if (attempt >= this.settleAttempts) {
            // Not final yet: keep the server's hold; the reconciler settles it later.
            this.ledger.adjustHold(holdId, cost);
            return cost;
          }
          await new Promise((resolve) => setTimeout(resolve, this.settleDelayMs));
        }
      } catch (error) {
        if (!(error instanceof SpicyApiError)) this.log(`chat task lookup failed: ${String(error)}`);
      }
    }
    const usage = stream.usage();
    const estimate = usage ? costFromUsage(usage, pricePer1k) : undefined;
    const current = this.ledger.hold(holdId)?.amount ?? 0;
    if (stream.taskId) {
      // Keep the hold; the reconciler reads the task again later.
      if (estimate !== undefined) this.ledger.adjustHold(holdId, estimate);
      return estimate ?? current;
    }
    const charged = estimate ?? current;
    this.ledger.settle(holdId, charged);
    return charged;
  }
}

/** Settles chat holds whose task was not final when the reply ended. */
export async function reconcileChatHolds(ledger: SpendLedger, tasks: TaskLookup): Promise<void> {
  for (const hold of ledger.pendingTasks()) {
    if (hold.kind !== "chat" || !hold.taskId) continue;
    try {
      const task = await tasks.getTask(hold.taskId);
      if (isTerminal(task) && task.settled) ledger.settle(hold.id, parseUsd(task.cost) ?? 0);
    } catch (error) {
      if (error instanceof SpicyApiError && error.status === 404) ledger.settle(hold.id, hold.amount);
    }
  }
}
