import { describe, expect, it, vi } from "vitest";
import { ChatRunner, costFromUsage, estimateHold, reconcileChatHolds, type ChatStreamer } from "../src/core/chat.js";
import { emptyLedger, SpendLedger } from "../src/core/ledger.js";
import { NANOS_PER_USD } from "../src/core/money.js";
import { NOW, task } from "./fakes.js";

const usd = (value: number) => Math.round(value * NANOS_PER_USD);
const limits = { globalDaily: usd(5), userDaily: usd(1), maxConcurrentPerUser: 2 };
const PRICE = usd(0.0012);

function streamerOf(pieces: string[], taskId: string | undefined, usage = { promptTokens: 400, completionTokens: 100 }): ChatStreamer {
  return vi.fn(async () => {
    let done = false;
    return {
      taskId,
      deltas: (async function* () {
        for (const piece of pieces) yield piece;
        done = true;
      })(),
      usage: () => (done ? usage : undefined),
    };
  });
}

function setup(streamer: ChatStreamer, getTask = vi.fn(async () => task({ taskId: "job_chat", cost: "0.0006", settled: true }))) {
  const ledger = new SpendLedger(emptyLedger(), limits, () => {}, () => NOW);
  const runner = new ChatRunner(streamer, { getTask }, ledger, 1000, { settleAttempts: 2, settleDelayMs: 1 });
  return { ledger, runner, getTask };
}

const request = {
  user: "tg:1",
  owner: false,
  model: "example/chat-model/chat",
  messages: [{ role: "user" as const, content: "hello there" }],
  idempotencyKey: "sbot-chat-1",
  pricePer1k: PRICE,
};

describe("ChatRunner", () => {
  it("streams the reply and settles the cost recorded on the task", async () => {
    const streamer = streamerOf(["Hel", "lo!"], "job_chat");
    const { runner, ledger, getTask } = setup(streamer);
    const seen: string[] = [];
    const outcome = await runner.run({ ...request, onText: (text) => seen.push(text) });
    expect(seen).toEqual(["Hel", "Hello!"]);
    expect(outcome).toEqual({ kind: "done", text: "Hello!", charged: usd(0.0006), taskId: "job_chat" });
    expect(getTask).toHaveBeenCalledWith("job_chat");
    expect(streamer).toHaveBeenCalledWith(expect.objectContaining({ idempotencyKey: "sbot-chat-1", maxTokens: 1000 }));
    expect(ledger.snapshot("tg:1")).toMatchObject({ userSettled: usd(0.0006), userHeld: 0 });
  });

  it("falls back to an upper bound from usage when there is no task ID", async () => {
    const { runner, ledger } = setup(streamerOf(["ok"], undefined));
    const outcome = await runner.run(request);
    // 500 tokens at the output rate
    expect(outcome).toMatchObject({ kind: "done", charged: usd(0.0006) });
    expect(ledger.snapshot("tg:1").userSettled).toBe(usd(0.0006));
  });

  it("waits briefly for the final charge", async () => {
    const getTask = vi
      .fn(async () => task({ taskId: "job_chat", cost: "0.0006", settled: true }))
      .mockResolvedValueOnce(task({ taskId: "job_chat", state: "running", cost: "0.02", settled: false }));
    const { runner, ledger } = setup(streamerOf(["ok"], "job_chat"), getTask);
    const outcome = await runner.run(request);
    expect(getTask).toHaveBeenCalledTimes(2);
    expect(outcome).toMatchObject({ charged: usd(0.0006) });
    expect(ledger.snapshot("tg:1")).toMatchObject({ userHeld: 0, userSettled: usd(0.0006) });
  });

  it("keeps an unsettled task as a hold and settles it later", async () => {
    const getTask = vi.fn(async () => task({ taskId: "job_chat", state: "running", cost: "0.002", settled: false }));
    const { runner, ledger } = setup(streamerOf(["ok"], "job_chat"), getTask);
    await runner.run(request);
    expect(getTask).toHaveBeenCalledTimes(2);
    expect(ledger.snapshot("tg:1").userHeld).toBe(usd(0.002));
    getTask.mockResolvedValue(task({ taskId: "job_chat", cost: "0.0007", settled: true }));
    await reconcileChatHolds(ledger, { getTask });
    expect(ledger.snapshot("tg:1")).toMatchObject({ userHeld: 0, userSettled: usd(0.0007) });
  });

  it("refuses before calling the model when the budget is used up", async () => {
    const streamer = streamerOf(["never"], "job_chat");
    const { runner, ledger } = setup(streamer);
    const hold = ledger.reserve("tg:1", usd(0.9999), { kind: "media" });
    expect(hold.ok).toBe(true);
    const outcome = await runner.run(request);
    expect(outcome).toMatchObject({ kind: "blocked", verdict: { reason: "user_cap" } });
    expect(streamer).not.toHaveBeenCalled();
  });

  it("releases the hold when the request is rejected before a task exists", async () => {
    const streamer: ChatStreamer = vi.fn(async () => {
      throw new Error("connection refused");
    });
    const { runner, ledger } = setup(streamer);
    await expect(runner.run(request)).rejects.toThrow("connection refused");
    expect(ledger.snapshot("tg:1")).toMatchObject({ userHeld: 0, userSettled: 0 });
  });
});

describe("chat cost estimates", () => {
  it("holds prompt plus the reply ceiling at the output rate", () => {
    expect(estimateHold([{ role: "user", content: "x".repeat(300) }], 1000, PRICE)).toBe(Math.ceil(1100 * PRICE / 1000));
    expect(estimateHold([], 1000, undefined)).toBe(usd(0.05));
  });

  it("prices usage at the output rate as an upper bound", () => {
    expect(costFromUsage({ promptTokens: 1000, completionTokens: 1000 }, PRICE)).toBe(usd(0.0024));
    expect(costFromUsage({ promptTokens: 1, completionTokens: 1 }, undefined)).toBeUndefined();
  });
});
