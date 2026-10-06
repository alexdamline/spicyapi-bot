import { parseIdList, type AccessPolicy } from "./core/access.js";
import { requireUsd, type Nanos } from "./core/money.js";
import type { ModelKind } from "./core/store.js";

export type SpoilerMode = "groups" | "always" | "never";

export interface BotConfig {
  spicyApiKey: string;
  /** Root of the API, without a path: the SDK uses `${root}/api/v1`, chat uses `${root}/v1`. */
  spicyBaseUrl: string;
  telegramToken: string | undefined;
  discordToken: string | undefined;
  /** Register Discord commands on one server only (instant) instead of globally. */
  discordGuildId: string | undefined;
  access: AccessPolicy;
  limits: { globalDaily: Nanos; userDaily: Nanos; maxConcurrentPerUser: number };
  spend: { maxPerRequest: Nanos; confirmAbove: Nanos };
  defaults: Record<ModelKind, string>;
  allowedModels: string[];
  videoSeconds: number;
  videoResolution: string | undefined;
  imageAspectRatio: string | undefined;
  charactersFile: string;
  historyTurns: number;
  chatMaxTokens: number;
  /** Plain messages in a private chat (no command) go to the character. */
  privateChat: boolean;
  retentionSeconds: number | undefined;
  dataDir: string;
  allowPhotoUploads: boolean;
  spoilerMedia: SpoilerMode;
  progressIntervalMs: number;
  requireConsent: boolean;
  discordMediaInDms: boolean;
  discordChatRequiresNsfw: boolean;
}

export const DEFAULT_MODELS: Record<ModelKind, string> = {
  image: "alibaba/z-image-turbo/text-to-image",
  video: "minimax/h3/text-to-video",
  animate: "minimax/h3/image-to-video",
  chat: "deepseek/v4.1-flash/chat",
};

type Env = Record<string, string | undefined>;

export class ConfigError extends Error {
  override name = "ConfigError";
  constructor(readonly problems: string[]) {
    super(`Configuration problems:\n${problems.map((problem) => `  - ${problem}`).join("\n")}`);
  }
}

/**
 * Reads the configuration from environment variables. Every problem is reported at once, with
 * the variable name, so a first-time setup does not turn into a guessing game.
 */
export function loadConfig(env: Env): { config: BotConfig; warnings: string[] } {
  const problems: string[] = [];
  const warnings: string[] = [];
  const get = (name: string): string | undefined => {
    const value = env[name]?.trim();
    return value ? value : undefined;
  };
  const attempt = <T>(fn: () => T, fallback: T): T => {
    try {
      return fn();
    } catch (error) {
      problems.push((error as Error).message);
      return fallback;
    }
  };
  const usd = (name: string, fallback: string): Nanos => attempt(() => requireUsd(get(name) ?? fallback, name), 0);
  const integer = (name: string, fallback: number, min: number, max: number): number => {
    const raw = get(name);
    if (raw === undefined) return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < min || value > max) {
      problems.push(`${name} must be a whole number between ${min} and ${max} (got "${raw}")`);
      return fallback;
    }
    return value;
  };
  const flag = (name: string, fallback: boolean): boolean => {
    const raw = get(name)?.toLowerCase();
    if (raw === undefined) return fallback;
    if (["1", "true", "yes", "on"].includes(raw)) return true;
    if (["0", "false", "no", "off"].includes(raw)) return false;
    problems.push(`${name} must be true or false (got "${raw}")`);
    return fallback;
  };

  const spicyApiKey = get("SPICY_API_KEY") ?? "";
  if (!spicyApiKey) problems.push("SPICY_API_KEY is required (create one in the SpicyAPI console)");
  else if (!spicyApiKey.startsWith("sk-spicy-")) problems.push("SPICY_API_KEY does not look like a SpicyAPI key (it should start with sk-spicy-)");

  const telegramToken = get("TELEGRAM_BOT_TOKEN");
  const discordToken = get("DISCORD_TOKEN");
  if (!telegramToken && !discordToken) problems.push("Set TELEGRAM_BOT_TOKEN, DISCORD_TOKEN, or both");

  const owners = attempt(() => parseIdList(get("OWNER_ID"), "OWNER_ID"), { any: false, ids: new Set<string>() });
  if (owners.any) problems.push("OWNER_ID cannot be *; list your own user ID");
  if (owners.ids.size === 0 && !owners.any) problems.push("OWNER_ID is required: your own Telegram user ID and/or Discord user ID");
  const users = attempt(() => parseIdList(get("ALLOWED_USER_IDS"), "ALLOWED_USER_IDS"), { any: false, ids: new Set<string>() });
  const chats = attempt(() => parseIdList(get("ALLOWED_CHAT_IDS"), "ALLOWED_CHAT_IDS"), { any: false, ids: new Set<string>() });
  if (users.any) warnings.push("ALLOWED_USER_IDS=* lets anyone who finds the bot spend your SpicyAPI balance.");
  if (chats.any) warnings.push("ALLOWED_CHAT_IDS=* lets the bot answer in any group or channel it is added to.");

  const spoilerRaw = (get("SPOILER_MEDIA") ?? "groups").toLowerCase();
  if (!["groups", "always", "never"].includes(spoilerRaw)) problems.push(`SPOILER_MEDIA must be groups, always or never (got "${spoilerRaw}")`);

  const baseUrl = (get("SPICY_BASE_URL") ?? "https://api.spicyapi.ai").replace(/\/+$/, "");
  if (!/^https?:\/\//.test(baseUrl)) problems.push("SPICY_BASE_URL must start with https://");

  const retentionRaw = get("RETENTION_SECONDS");
  const retentionSeconds = retentionRaw === undefined ? undefined : integer("RETENTION_SECONDS", 0, 0, 14 * 86_400);

  const config: BotConfig = {
    spicyApiKey,
    spicyBaseUrl: baseUrl,
    telegramToken,
    discordToken,
    discordGuildId: get("DISCORD_GUILD_ID"),
    access: { owners, users, chats },
    limits: {
      globalDaily: usd("DAILY_BUDGET_USD", "5"),
      userDaily: usd("USER_DAILY_BUDGET_USD", "1"),
      maxConcurrentPerUser: integer("MAX_CONCURRENT_TASKS_PER_USER", 2, 1, 20),
    },
    spend: {
      maxPerRequest: usd("MAX_COST_PER_REQUEST_USD", "1"),
      confirmAbove: usd("CONFIRM_ABOVE_USD", "0.10"),
    },
    defaults: {
      image: get("DEFAULT_IMAGE_MODEL") ?? DEFAULT_MODELS.image,
      video: get("DEFAULT_VIDEO_MODEL") ?? DEFAULT_MODELS.video,
      animate: get("DEFAULT_ANIMATE_MODEL") ?? DEFAULT_MODELS.animate,
      chat: get("DEFAULT_CHAT_MODEL") ?? DEFAULT_MODELS.chat,
    },
    allowedModels: (get("ALLOWED_MODELS") ?? "")
      .split(/[\s,]+/)
      .map((item) => item.trim())
      .filter(Boolean),
    videoSeconds: integer("VIDEO_SECONDS", 5, 1, 60),
    videoResolution: get("VIDEO_RESOLUTION") ?? "480p",
    imageAspectRatio: get("IMAGE_ASPECT_RATIO"),
    charactersFile: get("CHARACTERS_FILE") ?? "characters/default.json",
    historyTurns: integer("HISTORY_TURNS", 20, 1, 200),
    chatMaxTokens: integer("CHAT_MAX_TOKENS", 2048, 64, 32_768),
    privateChat: flag("PRIVATE_CHAT_REPLIES", true),
    retentionSeconds,
    dataDir: get("DATA_DIR") ?? "./data",
    allowPhotoUploads: flag("ALLOW_PHOTO_UPLOADS", false),
    spoilerMedia: spoilerRaw as SpoilerMode,
    progressIntervalMs: integer("PROGRESS_INTERVAL_SECONDS", 6, 3, 30) * 1000,
    requireConsent: flag("REQUIRE_CONSENT", true),
    discordMediaInDms: flag("DISCORD_MEDIA_IN_DMS", false),
    discordChatRequiresNsfw: flag("DISCORD_CHAT_REQUIRES_NSFW", false),
  };

  if (problems.length > 0) throw new ConfigError(problems);
  return { config, warnings };
}
