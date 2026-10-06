import { readFileSync } from "node:fs";

export interface Character {
  /** Short, unique, URL-safe identifier used in buttons and commands. */
  id: string;
  name: string;
  /** Instructions sent as the system message. `{{char}}` and `{{user}}` are filled in. */
  system: string;
  /** Optional first message from the character, shown when a conversation starts. */
  greeting?: string;
  /** Optional chat model for this character; falls back to the person's or the bot's default. */
  model?: string;
}

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

type Loose = Record<string, unknown>;

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function slug(value: string, fallback: string): string {
  const cleaned = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  return cleaned || fallback;
}

/**
 * Character Card V1/V2 (the format SillyTavern and most character sites export as JSON) turned
 * into one system message.
 */
function fromCard(card: Loose, index: number): Character {
  const data = (card.spec === "chara_card_v2" || card.spec === "chara_card_v3") && typeof card.data === "object" && card.data !== null ? (card.data as Loose) : card;
  const name = text(data.name);
  if (!name) throw new Error(`character #${index + 1} has no name`);
  const sections = [
    text(data.system_prompt) || "You are {{char}}. Stay in character and write {{char}}'s next reply in this conversation with {{user}}.",
    text(data.description) && `Description of {{char}}:\n${text(data.description)}`,
    text(data.personality) && `Personality:\n${text(data.personality)}`,
    text(data.scenario) && `Scenario:\n${text(data.scenario)}`,
    text(data.mes_example) && `Example dialogue:\n${text(data.mes_example)}`,
    text(data.post_history_instructions),
  ].filter(Boolean);
  return {
    id: slug(text(card.id) || name, `character-${index + 1}`),
    name,
    system: sections.join("\n\n"),
    ...(text(data.first_mes) ? { greeting: text(data.first_mes) } : {}),
  };
}

function fromEntry(entry: unknown, index: number): Character {
  if (typeof entry !== "object" || entry === null) throw new Error(`character #${index + 1} is not an object`);
  const item = entry as Loose;
  if (!("system" in item)) return fromCard(item, index);
  const name = text(item.name);
  const system = text(item.system);
  if (!name) throw new Error(`character #${index + 1} has no name`);
  if (!system) throw new Error(`character "${name}" has an empty system prompt`);
  return {
    id: slug(text(item.id) || name, `character-${index + 1}`),
    name,
    system,
    ...(text(item.greeting) ? { greeting: text(item.greeting) } : {}),
    ...(text(item.model) ? { model: text(item.model) } : {}),
  };
}

/**
 * Accepts `{ "characters": [...] }`, a bare array, or a single character. Each entry is either the
 * bot's own shape (`name`, `system`, optional `greeting`, `model`, `id`) or a Character Card.
 */
export function parseCharacters(json: unknown): Character[] {
  const list = Array.isArray(json)
    ? json
    : typeof json === "object" && json !== null && Array.isArray((json as Loose).characters)
      ? ((json as Loose).characters as unknown[])
      : [json];
  const characters = list.map(fromEntry);
  if (characters.length === 0) throw new Error("the characters file lists no characters");
  const seen = new Set<string>();
  for (const character of characters) {
    if (seen.has(character.id)) throw new Error(`two characters share the id "${character.id}"; give one a different "id"`);
    seen.add(character.id);
  }
  return characters;
}

export function loadCharacters(path: string): Character[] {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    throw new Error(`CHARACTERS_FILE: cannot read ${path} (${(error as Error).message})`, { cause: error });
  }
  try {
    return parseCharacters(JSON.parse(raw));
  } catch (error) {
    throw new Error(`CHARACTERS_FILE ${path}: ${(error as Error).message}`, { cause: error });
  }
}

export function fillPlaceholders(value: string, character: Character, userName: string): string {
  return value.replace(/\{\{\s*char\s*\}\}/gi, character.name).replace(/\{\{\s*user\s*\}\}/gi, userName);
}

/**
 * Keeps the newest `maxTurns` user/assistant pairs. Trimming always starts at a user message, so
 * the history never opens with a dangling assistant reply.
 */
export function trimHistory(history: readonly ChatMessage[], maxTurns: number): ChatMessage[] {
  const limit = Math.max(1, maxTurns) * 2;
  if (history.length <= limit) return [...history];
  let start = history.length - limit;
  while (start < history.length && history[start]?.role !== "user") start += 1;
  return history.slice(start);
}

/** System message, the greeting as the character's first line, then the recent turns. */
export function buildMessages(character: Character, history: readonly ChatMessage[], userName: string): ChatMessage[] {
  const messages: ChatMessage[] = [{ role: "system", content: fillPlaceholders(character.system, character, userName) }];
  if (character.greeting) messages.push({ role: "assistant", content: fillPlaceholders(character.greeting, character, userName) });
  messages.push(...history);
  return messages;
}

interface Conversation {
  characterId: string;
  history: ChatMessage[];
  touchedAt: number;
}

/**
 * Chat history, in memory only: nothing is written to disk, a restart or /newchat forgets it, and a
 * conversation idle for `idleMs` is dropped.
 */
export class Conversations {
  private readonly items = new Map<string, Conversation>();

  constructor(
    private readonly maxTurns: number,
    private readonly idleMs = 24 * 60 * 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  history(key: string, characterId: string): ChatMessage[] {
    this.sweep();
    const item = this.items.get(key);
    if (!item || item.characterId !== characterId) return [];
    return [...item.history];
  }

  /** True when this key has no history with this character yet. */
  isNew(key: string, characterId: string): boolean {
    return this.history(key, characterId).length === 0;
  }

  append(key: string, characterId: string, user: string, assistant: string): void {
    const current = this.items.get(key);
    const history = current && current.characterId === characterId ? current.history : [];
    history.push({ role: "user", content: user }, { role: "assistant", content: assistant });
    this.items.set(key, { characterId, history: trimHistory(history, this.maxTurns), touchedAt: this.now() });
  }

  reset(key: string): void {
    this.items.delete(key);
  }

  private sweep(): void {
    const cutoff = this.now() - this.idleMs;
    for (const [key, item] of this.items) if (item.touchedAt < cutoff) this.items.delete(key);
  }
}
