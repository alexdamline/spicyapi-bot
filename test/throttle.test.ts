import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ThrottledEditor } from "../src/core/throttle.js";

describe("ThrottledEditor", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("sends the first update now and coalesces the rest into one edit per interval", async () => {
    const sent: string[] = [];
    const editor = new ThrottledEditor(async (text) => void sent.push(text), 5000, () => Date.now());
    editor.update("Queued 0s");
    editor.update("Generating 2s");
    editor.update("Generating 4s");
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toEqual(["Queued 0s"]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(sent).toEqual(["Queued 0s", "Generating 4s"]);
  });

  it("never re-sends unchanged text", async () => {
    const sent: string[] = [];
    const editor = new ThrottledEditor(async (text) => void sent.push(text), 1000, () => Date.now(), "Pricing...");
    editor.update("Pricing...");
    await vi.advanceTimersByTimeAsync(2000);
    expect(sent).toEqual([]);
  });

  it("flushes the final text immediately and ignores later updates", async () => {
    const sent: string[] = [];
    const editor = new ThrottledEditor(async (text) => void sent.push(text), 5000, () => Date.now());
    editor.update("Generating 1s");
    editor.update("Generating 3s");
    await editor.flush("Done");
    editor.update("late");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sent).toEqual(["Generating 1s", "Done"]);
  });

  it("keeps going after a failed edit", async () => {
    const sent: string[] = [];
    let fail = true;
    const editor = new ThrottledEditor(
      async (text) => {
        if (fail) {
          fail = false;
          throw new Error("rate limited");
        }
        sent.push(text);
      },
      100,
      () => Date.now(),
    );
    editor.update("a");
    await vi.advanceTimersByTimeAsync(0);
    editor.update("b");
    await vi.advanceTimersByTimeAsync(200);
    expect(sent).toEqual(["b"]);
  });
});
