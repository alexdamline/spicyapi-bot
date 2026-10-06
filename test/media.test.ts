import { SpicyApiError, SpicyTransportError, SpicyWaitTimeoutError } from "@spicyapi/sdk";
import { describe, expect, it } from "vitest";
import { emptyLedger, SpendLedger } from "../src/core/ledger.js";
import { decideQuote, MediaRunner, waitBudget, worstCase, type MediaRequest } from "../src/core/media.js";
import { NANOS_PER_USD } from "../src/core/money.js";
import { accepted, fakeSpicy, NOW, quote, task } from "./fakes.js";

const usd = (value: number) => Math.round(value * NANOS_PER_USD);
const policy = { maxPerRequest: usd(1), confirmAbove: usd(0.1) };
const limits = { globalDaily: usd(5), userDaily: usd(1), maxConcurrentPerUser: 2 };

function setup(api = fakeSpicy()) {
  const data = emptyLedger();
  const ledger = new SpendLedger(data, limits, () => {}, () => NOW);
  const runner = new MediaRunner(api, ledger, policy, { now: () => NOW });
  const request: MediaRequest = { user: "tg:1", owner: false, model: "example/image-model/text-to-image", input: { prompt: "a lighthouse" }, idempotencyKey: "sbot-key-1" };
  return { api, ledger, runner, request, data };
}

describe("worstCase", () => {
  it("prefers maxCharge and falls back to estimatedCost", () => {
    expect(worstCase({ maxCharge: "0.30", estimatedCost: "0.12" })).toBe(usd(0.3));
    expect(worstCase({ maxCharge: "0", estimatedCost: "0.12" })).toBe(usd(0.12));
  });

  it("never treats an unreadable quote as free", () => {
    expect(worstCase({ maxCharge: "n/a", estimatedCost: "" })).toBe(Number.MAX_SAFE_INTEGER);
  });
});

describe("decideQuote", () => {
  it("goes at or below the confirmation threshold", () => {
    expect(decideQuote(usd(0.1), policy, { ok: true })).toEqual({ kind: "go", worst: usd(0.1) });
  });

  it("asks for confirmation above the threshold", () => {
    expect(decideQuote(usd(0.11), policy, { ok: true })).toEqual({ kind: "confirm", worst: usd(0.11) });
  });

  it("refuses above the per-request ceiling, even with budget left", () => {
    expect(decideQuote(usd(1.01), policy, { ok: true })).toEqual({ kind: "too_expensive", worst: usd(1.01), limit: usd(1) });
  });

  it("refuses when the daily budget would be exceeded", () => {
    const verdict = { ok: false as const, reason: "user_cap" as const, limit: usd(1), remaining: usd(0.05) };
    expect(decideQuote(usd(0.08), policy, verdict)).toEqual({ kind: "over_budget", worst: usd(0.08), verdict });
  });
});

describe("MediaRunner", () => {
  it("prepares without holding anything", async () => {
    const { runner, request, ledger } = setup();
    const prepared = await runner.prepare(request);
    expect(prepared.decision.kind).toBe("go");
    expect(ledger.snapshot("tg:1").userHeld).toBe(0);
  });

  it("asks for confirmation for expensive requests", async () => {
    const api = fakeSpicy();
    api.quoteTask.mockResolvedValue(quote({ estimatedCost: "0.125", maxCharge: "0.125" }));
    const { runner, request } = setup(api);
    expect((await runner.prepare(request)).decision).toEqual({ kind: "confirm", worst: usd(0.125) });
  });

  it("submits with the quote, the derived idempotency key, then settles the final cost", async () => {
    const api = fakeSpicy();
    api.waitForTask.mockResolvedValue(task({ cost: "0.008", settled: true }));
    const { runner, request, ledger } = setup(api);
    const outcome = await runner.run(await runner.prepare(request));
    expect(api.createTask).toHaveBeenCalledWith(
      { model: request.model, input: request.input, quoteId: "q_1", expectedCost: "0.01" },
      { idempotencyKey: "sbot-key-1" },
    );
    expect(outcome).toMatchObject({ kind: "succeeded", charged: usd(0.008), final: true });
    expect(ledger.snapshot("tg:1")).toMatchObject({ userSettled: usd(0.008), userHeld: 0, userRunning: 0 });
  });

  it("keeps an unsettled cost as a hold for the reconciler", async () => {
    const api = fakeSpicy();
    api.waitForTask.mockResolvedValue(task({ cost: "0.01", settled: false }));
    const { runner, request, ledger } = setup(api);
    await runner.run(await runner.prepare(request));
    expect(ledger.pendingTasks()).toHaveLength(1);
    api.getTask.mockResolvedValue(task({ cost: "0.009", settled: true }));
    await runner.reconcile();
    expect(ledger.pendingTasks()).toHaveLength(0);
    expect(ledger.snapshot("tg:1").userSettled).toBe(usd(0.009));
  });

  it("charges nothing for a failed task", async () => {
    const api = fakeSpicy();
    api.waitForTask.mockResolvedValue(task({ state: "failed", cost: "0", settled: true, errorCode: "content_rejected", output: {} }));
    const { runner, request, ledger } = setup(api);
    const outcome = await runner.run(await runner.prepare(request));
    expect(outcome.kind).toBe("failed");
    expect(ledger.snapshot("tg:1")).toMatchObject({ userSettled: 0, userHeld: 0 });
  });

  it("re-quotes and resends under the same key when the price moved (40901)", async () => {
    const api = fakeSpicy();
    api.createTask
      .mockRejectedValueOnce(new SpicyApiError("price changed", { status: 409, code: 40901 }))
      .mockResolvedValueOnce(accepted());
    api.quoteTask.mockResolvedValueOnce(quote()).mockResolvedValueOnce(quote({ quoteId: "q_2", estimatedCost: "0.009", maxCharge: "0.009" }));
    const { runner, request } = setup(api);
    const outcome = await runner.run(await runner.prepare(request));
    expect(outcome.kind).toBe("succeeded");
    expect(api.createTask).toHaveBeenCalledTimes(2);
    const keys = api.createTask.mock.calls.map((call) => (call as unknown[])[1]);
    expect(keys).toEqual([{ idempotencyKey: "sbot-key-1" }, { idempotencyKey: "sbot-key-1" }]);
    expect((api.createTask.mock.calls[1] as unknown[])[0]).toMatchObject({ quoteId: "q_2", expectedCost: "0.009" });
  });

  it("does not resend when the new price is above what was confirmed", async () => {
    const api = fakeSpicy();
    api.quoteTask.mockResolvedValueOnce(quote({ estimatedCost: "0.2", maxCharge: "0.2" })).mockResolvedValueOnce(quote({ estimatedCost: "0.3", maxCharge: "0.3" }));
    api.createTask.mockRejectedValueOnce(new SpicyApiError("price changed", { status: 409, code: 40901 }));
    const { runner, request, ledger } = setup(api);
    const prepared = await runner.prepare(request);
    expect(prepared.decision.kind).toBe("confirm");
    const outcome = await runner.run(prepared);
    expect(outcome).toMatchObject({ kind: "not_submitted", decision: { kind: "confirm", worst: usd(0.3) } });
    expect(api.createTask).toHaveBeenCalledTimes(1);
    expect(ledger.snapshot("tg:1").userHeld).toBe(0);
  });

  it("re-quotes an expired quote before submitting", async () => {
    const api = fakeSpicy();
    api.quoteTask.mockResolvedValueOnce(quote({ expiresAt: new Date(NOW - 1000).toISOString() })).mockResolvedValueOnce(quote({ quoteId: "q_fresh" }));
    const { runner, request } = setup(api);
    await runner.run(await runner.prepare(request));
    expect((api.createTask.mock.calls[0] as unknown[])[0]).toMatchObject({ quoteId: "q_fresh" });
  });

  it("refuses at submit time when the budget filled up meanwhile", async () => {
    const { runner, request, ledger } = setup();
    const prepared = await runner.prepare(request);
    ledger.reserve("tg:1", usd(0.995), { kind: "chat" });
    const outcome = await runner.run(prepared);
    expect(outcome).toMatchObject({ kind: "not_submitted", decision: { kind: "over_budget" } });
  });

  it("counts the hold as spent when the submit result is unknown", async () => {
    const api = fakeSpicy();
    api.createTask.mockRejectedValue(new SpicyTransportError("network down"));
    const { runner, request, ledger } = setup(api);
    const outcome = await runner.run(await runner.prepare(request));
    expect(outcome.kind).toBe("unknown");
    expect(ledger.snapshot("tg:1")).toMatchObject({ userSettled: usd(0.01), userHeld: 0 });
  });

  it("releases the hold and rethrows on a definite rejection", async () => {
    const api = fakeSpicy();
    api.createTask.mockRejectedValue(new SpicyApiError("balance", { status: 402, code: 40201 }));
    const { runner, request, ledger } = setup(api);
    await expect(runner.run(await runner.prepare(request))).rejects.toBeInstanceOf(SpicyApiError);
    expect(ledger.snapshot("tg:1").userHeld).toBe(0);
  });

  it("reports a still-running task after the wait budget and keeps its hold", async () => {
    const api = fakeSpicy();
    api.waitForTask.mockRejectedValue(new SpicyWaitTimeoutError("job_test1", 1000));
    const { runner, request, ledger } = setup(api);
    const outcome = await runner.run(await runner.prepare(request));
    expect(outcome).toEqual({ kind: "still_running", taskId: "job_test1" });
    expect(ledger.pendingTasks()[0]?.taskId).toBe("job_test1");
  });

  it("passes progress to the display hook without letting it break billing", async () => {
    const api = fakeSpicy();
    api.waitForTask.mockImplementation(async (_id, options) => {
      await options?.onUpdate?.(task({ state: "running" }));
      return task();
    });
    const { runner, request } = setup(api);
    const states: string[] = [];
    const outcome = await runner.run(await runner.prepare(request), {
      onProgress: (update) => {
        states.push(update.state);
        throw new Error("display failed");
      },
    });
    expect(states).toEqual(["running"]);
    expect(outcome.kind).toBe("succeeded");
  });
});

describe("waitBudget", () => {
  it("waits until the server deadline plus a margin", () => {
    expect(waitBudget(new Date(NOW + 10 * 60_000).toISOString(), NOW)).toBe(12 * 60_000);
    expect(waitBudget(undefined, NOW)).toBe(32 * 60_000);
    expect(waitBudget(new Date(NOW - 60 * 60_000).toISOString(), NOW)).toBe(60_000);
  });
});
