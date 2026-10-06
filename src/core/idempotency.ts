import { createHash } from "node:crypto";

/**
 * Builds the Idempotency-Key for a billable request from the chat event that caused it.
 *
 * The same event always produces the same key, so a Telegram update that is delivered twice, a
 * button that is tapped twice, or a network retry after a lost response returns the task that
 * already exists instead of paying for a second one. The parts are hashed so that chat and user IDs
 * never leave this machine, and so the key has a fixed, header-safe length.
 *
 * Parts should name the bot (so two bots sharing one API key never collide), where the event
 * happened, which event it was, and what it asked for, for example
 * `["tg", botId, chatId, messageId, "image"]`.
 */
export function idempotencyKey(parts: ReadonlyArray<string | number>): string {
  if (parts.length === 0) throw new TypeError("idempotencyKey needs at least one part");
  const material = parts
    .map((part) => {
      const text = String(part);
      if (text.length === 0) throw new TypeError("idempotencyKey parts must not be empty");
      // Length-prefix every part so ["a:b", "c"] and ["a", "b:c"] can never produce the same key.
      return `${text.length}:${text}`;
    })
    .join("|");
  return `sbot-${createHash("sha256").update(material).digest("hex").slice(0, 48)}`;
}
