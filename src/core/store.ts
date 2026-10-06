import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { emptyLedger, type LedgerData } from "./ledger.js";

export type MediaKind = "image" | "video" | "animate";
export type ModelKind = MediaKind | "chat";

export interface UserPrefs {
  models?: Partial<Record<ModelKind, string>>;
  character?: string;
}

/**
 * Everything the bot keeps on disk. Deliberately small: spend totals, per-person settings and
 * who accepted the usage rules. No prompts, chat history or media are ever written here.
 */
export interface BotState {
  version: 1;
  ledger: LedgerData;
  prefs: Record<string, UserPrefs>;
  /** user key -> ISO time the person accepted the usage rules. */
  consents: Record<string, string>;
}

export function emptyState(): BotState {
  return { version: 1, ledger: emptyLedger(), prefs: {}, consents: {} };
}

export interface StateStore {
  readonly state: BotState;
  save(): void;
}

/** In-memory store for tests and for running without a data directory. */
export class MemoryStore implements StateStore {
  saves = 0;
  constructor(readonly state: BotState = emptyState()) {}
  save(): void {
    this.saves += 1;
  }
}

/**
 * A JSON file written atomically (temp file + rename), so a crash mid-write leaves the previous
 * version intact. Mount DATA_DIR as a volume, or every restart forgets today's spending.
 */
export class JsonFileStore implements StateStore {
  readonly state: BotState;
  private readonly path: string;

  constructor(dataDir: string, log: (message: string) => void = console.warn) {
    this.path = join(dataDir, "state.json");
    mkdirSync(dirname(this.path), { recursive: true });
    this.state = this.load(log);
  }

  private load(log: (message: string) => void): BotState {
    if (!existsSync(this.path)) return emptyState();
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8")) as Partial<BotState>;
      const base = emptyState();
      return {
        version: 1,
        ledger: {
          days: parsed.ledger?.days ?? base.ledger.days,
          holds: parsed.ledger?.holds ?? base.ledger.holds,
        },
        prefs: parsed.prefs ?? {},
        consents: parsed.consents ?? {},
      };
    } catch (error) {
      const aside = `${this.path}.unreadable-${Date.now()}`;
      renameSync(this.path, aside);
      log(`State file could not be read and was moved to ${aside}; starting with an empty ledger. (${String(error)})`);
      return emptyState();
    }
  }

  save(): void {
    const temp = `${this.path}.tmp`;
    writeFileSync(temp, JSON.stringify(this.state), { mode: 0o600 });
    renameSync(temp, this.path);
  }
}
