export type Platform = "telegram" | "discord";

const PLATFORM_PREFIX: Record<string, Platform> = {
  tg: "telegram",
  telegram: "telegram",
  dc: "discord",
  discord: "discord",
};

/**
 * A list of IDs from the environment, such as `OWNER_ID=123,dc:4567`.
 *
 * A bare ID matches on any platform. Telegram user IDs and Discord snowflakes live in very different
 * numeric ranges, so a bare ID cannot realistically match the wrong person. A prefix (`tg:` or
 * `dc:`) pins it to one platform. `*` matches everyone.
 */
export interface IdList {
  readonly any: boolean;
  readonly ids: ReadonlySet<string>;
}

export function parseIdList(raw: string | undefined, label: string): IdList {
  const ids = new Set<string>();
  let any = false;
  for (const part of (raw ?? "").split(/[\s,]+/)) {
    const item = part.trim();
    if (!item) continue;
    if (item === "*") {
      any = true;
      continue;
    }
    const colon = item.indexOf(":");
    let platform: Platform | "*" = "*";
    let id = item;
    if (colon > 0) {
      const prefix = item.slice(0, colon).toLowerCase();
      const mapped = PLATFORM_PREFIX[prefix];
      if (!mapped) throw new Error(`${label}: unknown platform prefix "${prefix}" in "${item}" (use tg: or dc:)`);
      platform = mapped;
      id = item.slice(colon + 1);
    }
    if (!/^-?\d+$/.test(id)) throw new Error(`${label}: "${item}" is not a numeric ID`);
    ids.add(`${platform}:${id}`);
  }
  return { any, ids };
}

export function listMatches(list: IdList, platform: Platform, id: string | number): boolean {
  if (list.any) return true;
  const value = String(id);
  return list.ids.has(`${platform}:${value}`) || list.ids.has(`*:${value}`);
}

export interface AccessPolicy {
  owners: IdList;
  users: IdList;
  chats: IdList;
}

export type ChatContext =
  | { kind: "private" }
  /** Every ID that identifies where the message was sent: the chat or channel, its parent channel for a thread, and the server. */
  | { kind: "group"; ids: string[] };

export interface AccessRequest {
  platform: Platform;
  userId: string | number;
  chat: ChatContext;
}

export type AccessDecision =
  | { allowed: true; owner: boolean }
  | { allowed: false; owner: boolean; reason: "user_not_allowed" | "chat_not_allowed" };

/**
 * Who may use the bot.
 *
 * - Private chats and DMs: owners, plus anyone on ALLOWED_USER_IDS.
 * - Groups and server channels: only chats on ALLOWED_CHAT_IDS, and then every member of that
 *   chat, because "allow this group" is what an operator means by listing it. Groups are off until
 *   one is listed, and that includes the owner: the bot never posts into a group nobody approved.
 */
export function decideAccess(policy: AccessPolicy, request: AccessRequest): AccessDecision {
  const owner = listMatches(policy.owners, request.platform, request.userId);
  if (request.chat.kind === "private") {
    if (owner || listMatches(policy.users, request.platform, request.userId)) return { allowed: true, owner };
    return { allowed: false, owner, reason: "user_not_allowed" };
  }
  const chatAllowed = request.chat.ids.some((id) => listMatches(policy.chats, request.platform, id));
  if (!chatAllowed) return { allowed: false, owner, reason: "chat_not_allowed" };
  return { allowed: true, owner };
}

export function userKey(platform: Platform, userId: string | number): string {
  return `${platform === "telegram" ? "tg" : "dc"}:${userId}`;
}
