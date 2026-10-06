import type { TaskOutputAsset } from "@spicyapi/sdk";
import { describe, expect, it, vi } from "vitest";
import { BotCore } from "../src/core/bot-core.js";
import type { ChatStreamer } from "../src/core/chat.js";
import { resolvePending, runChat, splitMessage, startMedia, type Button, type ChatSurface, type MediaSurface } from "../src/core/flows.js";
import { MemoryStore } from "../src/core/store.js";
import { I2V_SCHEMA, fakeSpicy, model, NOW, quote, task, testConfig } from "./fakes.js";

const IMAGE = model();
const ANIMATE = model({
  model: "example/video-model/image-to-video",
  displayName: "Example Video",
  modality: "video",
  tasks: ["image-to-video"],
  inputSchema: I2V_SCHEMA,
  startingPrice: { variant: "480p", unit: "per_second", price: "0.025", currency: "USD" },
});

function recordingSurface() {
  const statuses: Array<{ text: string; buttons?: Button[] }> = [];
  const delivered: Array<{ asset: TaskOutputAsset; caption: string; buttons: Button[] }> = [];
  const surface: MediaSurface = {
    progressIntervalMs: 1,
    status: async (text, buttons) => void statuses.push({ text, ...(buttons ? { buttons } : {}) }),
    deliver: async (asset, caption, buttons) => void delivered.push({ asset, caption, buttons }),
    done: async () => {},
  };
  return { surface, statuses, delivered };
}

function makeCore(env: Record<string, string> = {}, streamer?: ChatStreamer) {
  const spicy = fakeSpicy([IMAGE, ANIMATE]);
  const store = new MemoryStore();
  const core = new BotCore(
    testConfig({ DEFAULT_IMAGE_MODEL: IMAGE.model, DEFAULT_ANIMATE_MODEL: ANIMATE.model, ...env }),
    {
      spicy,
      store,
      streamer: streamer ?? (async () => ({ taskId: undefined, deltas: (async function* () {})(), usage: () => undefined })),
      characters: [{ id: "mira", name: "Mira", system: "You are {{char}}.", greeting: "Hello {{user}}" }],
      log: () => {},
      now: () => NOW,
      chatOptions: { settleDelayMs: 1 },
    },
  );
  return { core, spicy, store };
}

const caller = { user: "tg:111", owner: false, name: "Sam" };

describe("media flow with a fake SpicyAPI", () => {
  it("prices, runs and delivers a cheap image with an Animate button", async () => {
    const { core, spicy } = makeCore();
    const { surface, statuses, delivered } = recordingSurface();
    await startMedia(core, caller, "image", "a lighthouse at dusk", "sbot-k1", surface);
    expect(spicy.quoteTask).toHaveBeenCalledWith({ model: IMAGE.model, input: { prompt: "a lighthouse at dusk" } });
    expect(spicy.createTask).toHaveBeenCalledTimes(1);
    expect(statuses[0]?.text).toMatch(/Checking the price/);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.caption).toBe("Example Image · $0.01 · task job_test1");
    expect(delivered[0]?.buttons).toEqual([{ id: "an:job_test1", label: "Animate", style: "secondary" }]);
    expect(core.ledger.snapshot("tg:111").userSettled).toBe(10_000_000);
  });

  it("asks before spending above the threshold, and only the asker can confirm", async () => {
    const { core, spicy } = makeCore();
    spicy.quoteTask.mockResolvedValue(quote({ estimatedCost: "0.125", maxCharge: "0.125" }));
    spicy.waitForTask.mockResolvedValue(task({ output: { assets: [{ url: "https://files.example.test/v.mp4", mime: "video/mp4" }] } }));
    const { surface, statuses, delivered } = recordingSurface();
    await startMedia(core, caller, "animate", "slow push-in", "sbot-k2", surface, "spicy://f/fil_1");
    expect(spicy.createTask).not.toHaveBeenCalled();
    const ask = statuses.at(-1)!;
    expect(ask.text).toMatch(/up to \$0\.125/);
    const confirm = ask.buttons!.find((button) => button.id.startsWith("ok:"))!;
    expect(confirm.label).toBe("Confirm ($0.125)");

    expect(await resolvePending(core, confirm.id, "tg:999", surface)).toMatch(/Only the person who asked/);
    expect(spicy.createTask).not.toHaveBeenCalled();

    expect(await resolvePending(core, confirm.id, "tg:111", surface)).toBeUndefined();
    await vi.waitFor(() => expect(delivered).toHaveLength(1));
    expect((spicy.createTask.mock.calls[0] as unknown[])[0]).toMatchObject({
      model: ANIMATE.model,
      input: { prompt: "slow push-in", image_url: "spicy://f/fil_1", duration_seconds: 5, resolution: "480p" },
    });
    expect(delivered[0]?.buttons).toEqual([]);

    // A second tap on the same button finds nothing.
    await resolvePending(core, confirm.id, "tg:111", surface);
    expect(statuses.at(-1)?.text).toMatch(/expired/);
    expect(spicy.createTask).toHaveBeenCalledTimes(1);
  });

  it("cancels without charging", async () => {
    const { core, spicy } = makeCore();
    spicy.quoteTask.mockResolvedValue(quote({ estimatedCost: "0.5", maxCharge: "0.5" }));
    const { surface, statuses } = recordingSurface();
    await startMedia(core, caller, "image", "x", "sbot-k3", surface);
    const cancel = statuses.at(-1)!.buttons!.find((button) => button.id.startsWith("no:"))!;
    await resolvePending(core, cancel.id, "tg:111", surface);
    expect(statuses.at(-1)?.text).toBe("Cancelled. Nothing was charged.");
    expect(spicy.createTask).not.toHaveBeenCalled();
  });

  it("refuses above the per-request limit without submitting", async () => {
    const { core, spicy } = makeCore({ MAX_COST_PER_REQUEST_USD: "0.20" });
    spicy.quoteTask.mockResolvedValue(quote({ estimatedCost: "0.25", maxCharge: "0.30" }));
    const { surface, statuses } = recordingSurface();
    await startMedia(core, caller, "image", "x", "sbot-k4", surface);
    expect(statuses.at(-1)?.text).toBe("This would cost up to $0.30, above the per-request limit of $0.20. Nothing was charged.");
    expect(spicy.createTask).not.toHaveBeenCalled();
  });

  it("refuses when today's personal limit is used up", async () => {
    const { core, spicy } = makeCore({ USER_DAILY_BUDGET_USD: "0.015" });
    const { surface, statuses } = recordingSurface();
    await startMedia(core, caller, "image", "x", "sbot-k5", surface);
    await startMedia(core, caller, "image", "y", "sbot-k6", surface);
    expect(spicy.createTask).toHaveBeenCalledTimes(1);
    expect(statuses.at(-1)?.text).toMatch(/daily limit of \$0\.015 .*Nothing was charged/);
  });

  it("explains a model rejection and keeps the money", async () => {
    const { core, spicy } = makeCore();
    spicy.waitForTask.mockResolvedValue(task({ state: "failed", cost: "0", settled: true, errorCode: "content_rejected", errorMessage: "Declined", output: {} }));
    const { surface, statuses, delivered } = recordingSurface();
    await startMedia(core, caller, "image", "x", "sbot-k7", surface);
    expect(delivered).toHaveLength(0);
    expect(statuses.at(-1)?.text).toMatch(/declined this request[\s\S]*Reason: Declined/);
    expect(core.ledger.snapshot("tg:111").userSettled).toBe(0);
  });

  it("animates the bot's own image from its task with a fresh link and the original prompt", async () => {
    const { core, spicy } = makeCore();
    spicy.getTask.mockResolvedValue(task({ input: { prompt: "a lighthouse" } }));
    const source = await core.imageFromTask("job_test1");
    expect(source).toEqual({ url: "https://files.example.test/result.png", prompt: "a lighthouse" });
    expect(core.motionPrompt(undefined, source.prompt)).toBe("a lighthouse Subtle, natural motion with a slow camera push-in.");
    expect(core.motionPrompt("  the waves crash  ", source.prompt)).toBe("the waves crash");
  });
});

describe("chat flow", () => {
  it("streams into the surface and remembers the turn", async () => {
    const streamer: ChatStreamer = vi.fn(async () => ({
      taskId: undefined,
      deltas: (async function* () {
        yield "Hi ";
        yield "Sam.";
      })(),
      usage: () => ({ promptTokens: 10, completionTokens: 2 }),
    }));
    const { core } = makeCore({}, streamer);
    const shown: string[] = [];
    const surface: ChatSurface = { intervalMs: 1, show: async (text) => void shown.push(text), finish: async (text) => void shown.push(`final:${text}`) };
    await runChat(core, caller, "tg:1:111", "hello", "sbot-c1", surface, 4000);
    expect(shown.at(-1)).toBe("final:Hi Sam.");
    const messages = (streamer as ReturnType<typeof vi.fn>).mock.calls[0]![0].messages;
    expect(messages).toEqual([
      { role: "system", content: "You are Mira." },
      { role: "assistant", content: "Hello Sam" },
      { role: "user", content: "hello" },
    ]);
    expect(core.conversations.history("tg:1:111", "mira")).toHaveLength(2);
  });
});

describe("splitMessage", () => {
  it("splits long text at paragraph or line breaks", () => {
    const text = `${"a".repeat(60)}\n\n${"b".repeat(60)}`;
    expect(splitMessage(text, 100)).toEqual(["a".repeat(60), "b".repeat(60)]);
    expect(splitMessage("short", 100)).toEqual(["short"]);
    expect(splitMessage("x".repeat(250), 100).map((part) => part.length)).toEqual([100, 100, 50]);
  });
});

describe("duplicate requests", () => {
  it("runs a repeated key once while the first is still going", async () => {
    const { core, spicy } = makeCore();
    let finish: () => void = () => {};
    spicy.waitForTask.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = () => resolve(task());
        }),
    );
    const first = recordingSurface();
    const second = recordingSurface();
    const running = startMedia(core, caller, "image", "x", "sbot-same", first.surface);
    await vi.waitFor(() => expect(spicy.waitForTask).toHaveBeenCalledTimes(1));
    await startMedia(core, caller, "image", "x", "sbot-same", second.surface);
    expect(second.statuses.at(-1)?.text).toBe("Already working on this one.");
    finish();
    await running;
    expect(spicy.createTask).toHaveBeenCalledTimes(1);
    // Once finished, the key is free again (the server would return the same task for it).
    await startMedia(core, caller, "image", "x", "sbot-same", second.surface);
    expect(spicy.quoteTask).toHaveBeenCalledTimes(2);
  });

  it("refuses a model the operator did not allow", async () => {
    const { core, spicy } = makeCore({ ALLOWED_MODELS: "other/*" });
    const { surface, statuses } = recordingSurface();
    await startMedia(core, caller, "image", "x", "sbot-k9", surface);
    expect(statuses.at(-1)?.text).toMatch(/not allowed on this bot/);
    expect(spicy.quoteTask).not.toHaveBeenCalled();
  });
});
