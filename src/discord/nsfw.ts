/**
 * Discord's rule for adult content: it may only appear in age-restricted channels (Community
 * Guidelines; Developer Policy). The image and video commands are registered as age-restricted
 * (`nsfw: true`), so Discord hides them elsewhere, and this check runs again in code in case a
 * command is reached some other way.
 *
 * Anything that cannot be confirmed as age-restricted is treated as not age-restricted.
 */
export type ChannelInfo =
  | { kind: "dm" }
  | { kind: "guild"; nsfw: boolean }
  /** Threads have no flag of their own; they follow their parent channel. */
  | { kind: "thread"; parentNsfw: boolean | undefined }
  | { kind: "unknown" };

export type MediaVerdict = { ok: true } | { ok: false; reason: "not_age_restricted" | "dm_disabled" | "unknown_channel" };

export function mediaAllowed(channel: ChannelInfo, options: { allowInDms: boolean }): MediaVerdict {
  switch (channel.kind) {
    case "guild":
      return channel.nsfw === true ? { ok: true } : { ok: false, reason: "not_age_restricted" };
    case "thread":
      return channel.parentNsfw === true ? { ok: true } : { ok: false, reason: "not_age_restricted" };
    case "dm":
      return options.allowInDms ? { ok: true } : { ok: false, reason: "dm_disabled" };
    default:
      return { ok: false, reason: "unknown_channel" };
  }
}

/** Discord channel type numbers (discord-api-types ChannelType). */
const DM_TYPES = new Set([1, 3]);
const THREAD_TYPES = new Set([10, 11, 12]);

/** The fields of a discord.js channel this check reads; plain objects work too, which keeps it testable. */
export interface ChannelShape {
  type: number;
  nsfw?: boolean | null;
  parent?: { nsfw?: boolean | null } | null;
}

export function channelInfo(channel: ChannelShape | null | undefined): ChannelInfo {
  if (!channel) return { kind: "unknown" };
  if (DM_TYPES.has(channel.type)) return { kind: "dm" };
  if (THREAD_TYPES.has(channel.type)) {
    const parentNsfw = channel.parent?.nsfw;
    return { kind: "thread", parentNsfw: typeof parentNsfw === "boolean" ? parentNsfw : undefined };
  }
  if (typeof channel.nsfw === "boolean") return { kind: "guild", nsfw: channel.nsfw };
  return { kind: "unknown" };
}

export function mediaRefusal(reason: Exclude<MediaVerdict, { ok: true }>["reason"]): string {
  switch (reason) {
    case "dm_disabled":
      return "Images and videos are only available in age-restricted server channels on this bot.";
    case "unknown_channel":
      return "Images and videos are only available in age-restricted channels, and this channel could not be confirmed as one.";
    default:
      return "Images and videos only work in age-restricted channels. A server admin can turn this on under Edit Channel > Overview > Age-Restricted Channel.";
  }
}
