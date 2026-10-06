import { describe, expect, it } from "vitest";
import { ConfigError, DEFAULT_MODELS, loadConfig } from "../src/config.js";
import { NANOS_PER_USD } from "../src/core/money.js";

const minimal = { SPICY_API_KEY: "sk-spicy-abc", TELEGRAM_BOT_TOKEN: "1:x", OWNER_ID: "111" };

describe("loadConfig", () => {
  it("has safe defaults", () => {
    const { config, warnings } = loadConfig(minimal);
    expect(warnings).toEqual([]);
    expect(config.limits).toEqual({ globalDaily: 5 * NANOS_PER_USD, userDaily: 1 * NANOS_PER_USD, maxConcurrentPerUser: 2 });
    expect(config.spend).toEqual({ maxPerRequest: 1 * NANOS_PER_USD, confirmAbove: 0.1 * NANOS_PER_USD });
    expect(config.allowPhotoUploads).toBe(false);
    expect(config.access.users.ids.size).toBe(0);
    expect(config.access.chats.ids.size).toBe(0);
    expect(config.defaults).toEqual(DEFAULT_MODELS);
    expect(config.spicyBaseUrl).toBe("https://api.spicyapi.ai");
    expect(config.discordToken).toBeUndefined();
  });

  it("lists every problem at once", () => {
    try {
      loadConfig({ DAILY_BUDGET_USD: "five", MAX_CONCURRENT_TASKS_PER_USER: "0", SPOILER_MEDIA: "maybe" });
      throw new Error("expected a ConfigError");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      const text = (error as ConfigError).problems.join("\n");
      expect(text).toMatch(/SPICY_API_KEY is required/);
      expect(text).toMatch(/TELEGRAM_BOT_TOKEN, DISCORD_TOKEN/);
      expect(text).toMatch(/OWNER_ID is required/);
      expect(text).toMatch(/DAILY_BUDGET_USD/);
      expect(text).toMatch(/MAX_CONCURRENT_TASKS_PER_USER/);
      expect(text).toMatch(/SPOILER_MEDIA/);
    }
  });

  it("rejects a key that is not a SpicyAPI key", () => {
    expect(() => loadConfig({ ...minimal, SPICY_API_KEY: "sk-openai" })).toThrow(/sk-spicy-/);
  });

  it("refuses OWNER_ID=* and warns about open allow lists", () => {
    expect(() => loadConfig({ ...minimal, OWNER_ID: "*" })).toThrow(/OWNER_ID cannot be \*/);
    const { warnings } = loadConfig({ ...minimal, ALLOWED_USER_IDS: "*", ALLOWED_CHAT_IDS: "*" });
    expect(warnings).toHaveLength(2);
  });

  it("reads switches and lists", () => {
    const { config } = loadConfig({
      ...minimal,
      DISCORD_TOKEN: "d",
      ALLOW_PHOTO_UPLOADS: "yes",
      ALLOWED_MODELS: "alibaba/*, minimax/h3/image-to-video",
      VIDEO_RESOLUTION: "720p",
      RETENTION_SECONDS: "3600",
    });
    expect(config.allowPhotoUploads).toBe(true);
    expect(config.allowedModels).toEqual(["alibaba/*", "minimax/h3/image-to-video"]);
    expect(config.videoResolution).toBe("720p");
    expect(config.retentionSeconds).toBe(3600);
    expect(config.discordToken).toBe("d");
  });
});
