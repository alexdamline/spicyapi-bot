import { describe, expect, it } from "vitest";
import { emptyLedger, SpendLedger, type LedgerData } from "../src/core/ledger.js";
import { formatUsd, NANOS_PER_USD, parseUsd } from "../src/core/money.js";

const usd = (value: number) => Math.round(value * NANOS_PER_USD);
const limits = { globalDaily: usd(5), userDaily: usd(1), maxConcurrentPerUser: 2 };

function ledger(now = { t: Date.parse("2026-10-06T10:00:00Z") }, data: LedgerData = emptyLedger()) {
  let saves = 0;
  const instance = new SpendLedger(data, limits, () => saves++, () => now.t);
  return { instance, now, data, saves: () => saves };
}

describe("money", () => {
  it("parses decimal strings exactly, up to nine places", () => {
    expect(parseUsd("0.01")).toBe(10_000_000);
    expect(parseUsd("0.000000001")).toBe(1);
    expect(parseUsd("1.663185419")).toBe(1_663_185_419);
    expect(parseUsd("12")).toBe(12 * NANOS_PER_USD);
    expect(parseUsd("-1")).toBeUndefined();
    expect(parseUsd("abc")).toBeUndefined();
    expect(parseUsd(undefined)).toBeUndefined();
  });

  it("formats with at least two and at most six decimals", () => {
    expect(formatUsd(usd(0.01))).toBe("$0.01");
    expect(formatUsd(usd(1.5))).toBe("$1.50");
    expect(formatUsd(usd(0.0225))).toBe("$0.0225");
    expect(formatUsd(usd(5))).toBe("$5.00");
    expect(formatUsd(1_663_185_419)).toBe("$1.663185");
  });

  it("adds amounts without float drift", () => {
    let total = 0;
    for (let i = 0; i < 10; i++) total += parseUsd("0.1")!;
    expect(total).toBe(usd(1));
  });
});

describe("SpendLedger", () => {
  it("counts settled spend and holds in flight against the daily caps", () => {
    const { instance } = ledger();
    const first = instance.reserve("tg:1", usd(0.6), { kind: "media" });
    expect(first.ok).toBe(true);
    // 0.6 held + 0.5 asked > 1.00 per person
    const second = instance.check("tg:1", usd(0.5), { kind: "media" });
    expect(second).toMatchObject({ ok: false, reason: "user_cap", remaining: usd(0.4) });
    if (first.ok) instance.settle(first.holdId, usd(0.3));
    expect(instance.check("tg:1", usd(0.5), { kind: "media" })).toEqual({ ok: true });
    const snap = instance.snapshot("tg:1");
    expect(snap.userSettled).toBe(usd(0.3));
    expect(snap.userHeld).toBe(0);
    expect(snap.globalSettled).toBe(usd(0.3));
  });

  it("releases a hold without charging it", () => {
    const { instance } = ledger();
    const hold = instance.reserve("tg:1", usd(0.9), { kind: "media" });
    if (!hold.ok) throw new Error("expected a hold");
    instance.release(hold.holdId);
    expect(instance.snapshot("tg:1")).toMatchObject({ userSettled: 0, userHeld: 0, userRunning: 0 });
  });

  it("lets owners past the per-person cap but never past the global cap", () => {
    const { instance } = ledger();
    expect(instance.reserve("tg:owner", usd(3), { kind: "media", exemptFromUserCap: true }).ok).toBe(true);
    expect(instance.check("tg:owner", usd(1.5), { kind: "chat", exemptFromUserCap: true }).ok).toBe(true);
    expect(instance.check("tg:owner", usd(2.5), { kind: "chat", exemptFromUserCap: true })).toMatchObject({
      ok: false,
      reason: "global_cap",
      remaining: usd(2),
    });
  });

  it("applies the global cap across people", () => {
    const { instance } = ledger();
    for (let i = 0; i < 5; i++) {
      const hold = instance.reserve(`tg:${i}`, usd(0.9), { kind: "chat" });
      if (hold.ok) instance.settle(hold.holdId, usd(0.9));
    }
    expect(instance.check("tg:99", usd(0.6), { kind: "chat" })).toMatchObject({ ok: false, reason: "global_cap" });
  });

  it("limits media tasks running at once per person, but not chat", () => {
    const { instance } = ledger();
    expect(instance.reserve("tg:1", usd(0.01), { kind: "media" }).ok).toBe(true);
    expect(instance.reserve("tg:1", usd(0.01), { kind: "media" }).ok).toBe(true);
    expect(instance.reserve("tg:1", usd(0.01), { kind: "media" })).toMatchObject({ ok: false, reason: "concurrency", limit: 2 });
    expect(instance.reserve("tg:1", usd(0.01), { kind: "chat" }).ok).toBe(true);
    expect(instance.reserve("tg:2", usd(0.01), { kind: "media" }).ok).toBe(true);
  });

  it("starts a fresh day at 00:00 UTC and books settlements on the day of the hold", () => {
    const { instance, now } = ledger();
    const hold = instance.reserve("tg:1", usd(0.8), { kind: "media" });
    if (!hold.ok) throw new Error("expected a hold");
    now.t = Date.parse("2026-10-07T00:00:01Z");
    // Yesterday's hold no longer counts against today's budget.
    expect(instance.check("tg:1", usd(0.9), { kind: "chat" }).ok).toBe(true);
    instance.settle(hold.holdId, usd(0.8));
    expect(instance.snapshot("tg:1").userSettled).toBe(0);
  });

  it("persists every change", () => {
    const { instance, saves } = ledger();
    const hold = instance.reserve("tg:1", usd(0.1), { kind: "media" });
    if (!hold.ok) throw new Error("expected a hold");
    instance.attachTask(hold.holdId, "job_1");
    instance.settle(hold.holdId, usd(0.1));
    expect(saves()).toBe(3);
  });

  it("cleans up holds that never reached the server, and old days", () => {
    const data: LedgerData = {
      days: { "2026-09-01": { total: 5, users: {} }, "2026-10-06": { total: 1, users: {} } },
      holds: {
        a: { id: "a", user: "tg:1", day: "2026-10-06", amount: 10, kind: "media", createdAt: 0 },
        b: { id: "b", user: "tg:1", day: "2026-10-06", amount: 10, kind: "media", createdAt: 0, taskId: "job_b" },
      },
    };
    const { instance } = ledger(undefined, data);
    instance.cleanUp();
    expect(Object.keys(data.holds)).toEqual(["b"]);
    expect(Object.keys(data.days)).toEqual(["2026-10-06"]);
    expect(instance.pendingTasks().map((hold) => hold.taskId)).toEqual(["job_b"]);
  });
});
