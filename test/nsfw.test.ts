import { describe, expect, it } from "vitest";
import { commandDefinitions } from "../src/discord/commands.js";
import { channelInfo, mediaAllowed } from "../src/discord/nsfw.js";
import { testConfig } from "./fakes.js";

const GUILD_TEXT = 0;
const DM = 1;
const PUBLIC_THREAD = 11;

describe("Discord age-restricted check", () => {
  const closedDms = { allowInDms: false };

  it("allows media only in channels marked age-restricted", () => {
    expect(mediaAllowed(channelInfo({ type: GUILD_TEXT, nsfw: true }), closedDms)).toEqual({ ok: true });
    expect(mediaAllowed(channelInfo({ type: GUILD_TEXT, nsfw: false }), closedDms)).toEqual({ ok: false, reason: "not_age_restricted" });
  });

  it("judges a thread by its parent channel", () => {
    expect(mediaAllowed(channelInfo({ type: PUBLIC_THREAD, parent: { nsfw: true } }), closedDms).ok).toBe(true);
    expect(mediaAllowed(channelInfo({ type: PUBLIC_THREAD, parent: { nsfw: false } }), closedDms).ok).toBe(false);
    // Parent not cached: cannot be confirmed, so no.
    expect(mediaAllowed(channelInfo({ type: PUBLIC_THREAD, parent: null }), closedDms).ok).toBe(false);
    // A thread's own flag is not trusted.
    expect(mediaAllowed(channelInfo({ type: PUBLIC_THREAD, nsfw: true, parent: { nsfw: false } }), closedDms).ok).toBe(false);
  });

  it("fails closed when the channel is unknown", () => {
    expect(mediaAllowed(channelInfo(null), closedDms)).toEqual({ ok: false, reason: "unknown_channel" });
    expect(mediaAllowed(channelInfo({ type: GUILD_TEXT }), closedDms)).toEqual({ ok: false, reason: "unknown_channel" });
    expect(mediaAllowed(channelInfo({ type: GUILD_TEXT, nsfw: null }), closedDms).ok).toBe(false);
  });

  it("keeps DMs closed unless the operator opens them", () => {
    expect(mediaAllowed(channelInfo({ type: DM }), closedDms)).toEqual({ ok: false, reason: "dm_disabled" });
    expect(mediaAllowed(channelInfo({ type: DM }), { allowInDms: true })).toEqual({ ok: true });
  });
});

describe("Discord command definitions", () => {
  it("marks image and video commands age-restricted", () => {
    const commands = commandDefinitions(testConfig({ ALLOW_PHOTO_UPLOADS: "true" }));
    const byName = new Map(commands.map((command) => [command.name, command]));
    expect(byName.get("pic")?.nsfw).toBe(true);
    expect(byName.get("vid")?.nsfw).toBe(true);
    expect(byName.get("animate")?.nsfw).toBe(true);
    expect(byName.get("talk")?.nsfw).toBe(false);
    expect(byName.get("help")?.nsfw).toBeUndefined();
  });

  it("only offers /animate with uploads when the operator allows photo uploads", () => {
    expect(commandDefinitions(testConfig()).some((command) => command.name === "animate")).toBe(false);
    expect(commandDefinitions(testConfig({ ALLOW_PHOTO_UPLOADS: "true" })).some((command) => command.name === "animate")).toBe(true);
  });

  it("can restrict chat to age-restricted channels too", () => {
    const talk = commandDefinitions(testConfig({ DISCORD_CHAT_REQUIRES_NSFW: "true" })).find((command) => command.name === "talk");
    expect(talk?.nsfw).toBe(true);
  });

  it("keeps descriptions within Discord's limits", () => {
    for (const command of commandDefinitions(testConfig({ ALLOW_PHOTO_UPLOADS: "true" }))) {
      expect(command.name).toMatch(/^[a-z0-9_-]{1,32}$/);
      expect(command.description.length).toBeLessThanOrEqual(100);
    }
  });
});
