import { describe, expect, it } from "vitest";
import { decideAccess, listMatches, parseIdList, type AccessPolicy } from "../src/core/access.js";
import { idempotencyKey } from "../src/core/idempotency.js";

function policy(owners: string, users = "", chats = ""): AccessPolicy {
  return {
    owners: parseIdList(owners, "OWNER_ID"),
    users: parseIdList(users, "ALLOWED_USER_IDS"),
    chats: parseIdList(chats, "ALLOWED_CHAT_IDS"),
  };
}

describe("parseIdList", () => {
  it("reads bare and platform-prefixed IDs", () => {
    const list = parseIdList("123, tg:456 dc:789012345678901234 -1001234", "X");
    expect(listMatches(list, "telegram", 123)).toBe(true);
    expect(listMatches(list, "discord", "123")).toBe(true);
    expect(listMatches(list, "telegram", 456)).toBe(true);
    expect(listMatches(list, "discord", "456")).toBe(false);
    expect(listMatches(list, "discord", "789012345678901234")).toBe(true);
    expect(listMatches(list, "telegram", "-1001234")).toBe(true);
  });

  it("treats * as everyone and empty as nobody", () => {
    expect(listMatches(parseIdList("*", "X"), "telegram", 5)).toBe(true);
    expect(listMatches(parseIdList("", "X"), "telegram", 5)).toBe(false);
    expect(listMatches(parseIdList(undefined, "X"), "discord", "5")).toBe(false);
  });

  it("rejects typos instead of silently ignoring them", () => {
    expect(() => parseIdList("@myname", "OWNER_ID")).toThrow(/OWNER_ID/);
    expect(() => parseIdList("slack:123", "OWNER_ID")).toThrow(/prefix/);
  });
});

describe("decideAccess", () => {
  const p = policy("111", "222");

  it("lets the owner and listed people use private chats", () => {
    expect(decideAccess(p, { platform: "telegram", userId: 111, chat: { kind: "private" } })).toEqual({ allowed: true, owner: true });
    expect(decideAccess(p, { platform: "telegram", userId: 222, chat: { kind: "private" } })).toEqual({ allowed: true, owner: false });
  });

  it("turns away everyone else by default", () => {
    expect(decideAccess(p, { platform: "telegram", userId: 333, chat: { kind: "private" } })).toEqual({
      allowed: false,
      owner: false,
      reason: "user_not_allowed",
    });
  });

  it("keeps groups off until one is listed, even for the owner", () => {
    expect(decideAccess(p, { platform: "telegram", userId: 111, chat: { kind: "group", ids: ["-100555"] } })).toEqual({
      allowed: false,
      owner: true,
      reason: "chat_not_allowed",
    });
  });

  it("opens a listed group or server channel to its members", () => {
    const open = policy("111", "", "-100555,dc:900");
    expect(decideAccess(open, { platform: "telegram", userId: 999, chat: { kind: "group", ids: ["-100555"] } }).allowed).toBe(true);
    // A thread or channel inside a listed Discord server or parent channel counts.
    expect(decideAccess(open, { platform: "discord", userId: "7", chat: { kind: "group", ids: ["1", "2", "900"] } }).allowed).toBe(true);
    expect(decideAccess(open, { platform: "telegram", userId: 999, chat: { kind: "group", ids: ["900"] } }).allowed).toBe(false);
  });
});

describe("idempotencyKey", () => {
  it("is stable for the same chat event", () => {
    expect(idempotencyKey(["tg", 42, -100, 7, "image"])).toBe(idempotencyKey(["tg", "42", "-100", "7", "image"]));
  });

  it("differs per event, action, bot and person", () => {
    const base = ["tg", 42, -100, 7, "image"] as const;
    const keys = new Set([
      idempotencyKey([...base]),
      idempotencyKey(["tg", 42, -100, 8, "image"]),
      idempotencyKey(["tg", 42, -100, 7, "video"]),
      idempotencyKey(["tg", 43, -100, 7, "image"]),
      idempotencyKey(["dc", 42, -100, 7, "image"]),
      idempotencyKey([...base, "user-1"]),
      idempotencyKey([...base, "user-2"]),
    ]);
    expect(keys.size).toBe(7);
  });

  it("cannot be forged by shifting separators between parts", () => {
    expect(idempotencyKey(["a:b", "c"])).not.toBe(idempotencyKey(["a", "b:c"]));
    expect(idempotencyKey(["ab", "c"])).not.toBe(idempotencyKey(["a", "bc"]));
  });

  it("does not reveal chat or user IDs and has a fixed, header-safe shape", () => {
    const key = idempotencyKey(["tg", 42, -1001234567890, 99, "image", 555666777]);
    expect(key).toMatch(/^sbot-[0-9a-f]{48}$/);
    expect(key).not.toContain("1234567890");
  });

  it("refuses empty input", () => {
    expect(() => idempotencyKey([])).toThrow();
    expect(() => idempotencyKey(["tg", ""])).toThrow();
  });
});
