import { randomBytes } from "node:crypto";
import { SpicyClient, type TaskRecord, type UploadContentType } from "@spicyapi/sdk";
import type { BotConfig } from "../config.js";
import { Catalog, KIND_LABEL } from "./catalog.js";
import {
  ChatRunner,
  createOpenAiClient,
  openAiStreamer,
  reconcileChatHolds,
  type ChatOutcome,
  type ChatRunnerOptions,
  type ChatStreamer,
} from "./chat.js";
import { buildMessages, Conversations, fillPlaceholders, loadCharacters, type Character } from "./characters.js";
import { buildMediaInput, InputError } from "./inputs.js";
import { SpendLedger } from "./ledger.js";
import { MediaRunner, type MediaApi, type PreparedMedia } from "./media.js";
import { spendSummary } from "./messages.js";
import { formatUsd, parseUsd } from "./money.js";
import { JsonFileStore, type MediaKind, type ModelKind, type StateStore } from "./store.js";

export const DEFAULT_MOTION = "Subtle, natural motion with a slow camera push-in.";

/** The SpicyAPI calls the bot makes; `SpicyClient` implements all of them. */
export type SpicyApi = MediaApi &
  Pick<SpicyClient, "listModels" | "getModel" | "getBalance" | "uploadBytes">;

export interface CoreDeps {
  spicy?: SpicyApi;
  streamer?: ChatStreamer;
  store?: StateStore;
  characters?: Character[];
  log?: (message: string) => void;
  now?: () => number;
  chatOptions?: ChatRunnerOptions;
}

export interface Caller {
  /** Ledger and preference key, such as "tg:123". */
  user: string;
  owner: boolean;
  /** How the character addresses the person. */
  name: string;
}

export interface PendingRequest<C> {
  id: string;
  caller: Caller;
  prepared: PreparedMedia;
  kind: MediaKind;
  modelName: string;
  context: C;
  createdAt: number;
}

/**
 * Everything both chat platforms share: settings, spend protection, SpicyAPI calls and chat history.
 * Platform code turns chat events into calls on this class and renders what comes back.
 */
export class BotCore {
  readonly spicy: SpicyApi;
  readonly store: StateStore;
  readonly ledger: SpendLedger;
  readonly catalog: Catalog;
  readonly media: MediaRunner;
  readonly chat: ChatRunner;
  readonly characters: Character[];
  readonly conversations: Conversations;
  readonly log: (message: string) => void;
  private readonly now: () => number;
  private readonly pending = new Map<string, PendingRequest<unknown>>();

  constructor(
    readonly config: BotConfig,
    deps: CoreDeps = {},
  ) {
    this.log = deps.log ?? ((message) => console.log(`[spicyapi-bot] ${message}`));
    this.now = deps.now ?? Date.now;
    this.spicy =
      deps.spicy ??
      new SpicyClient({ apiKey: config.spicyApiKey, apiBaseUrl: `${config.spicyBaseUrl}/api/v1`, maxRetries: 2 });
    this.store = deps.store ?? new JsonFileStore(config.dataDir, this.log);
    this.ledger = new SpendLedger(this.store.state.ledger, config.limits, () => this.store.save(), this.now);
    this.catalog = new Catalog(this.spicy, config.allowedModels, 10 * 60_000, this.now);
    this.media = new MediaRunner(this.spicy, this.ledger, config.spend, {
      ...(config.retentionSeconds === undefined ? {} : { retentionSeconds: config.retentionSeconds }),
      now: this.now,
      log: this.log,
    });
    const streamer = deps.streamer ?? openAiStreamer(createOpenAiClient(config.spicyApiKey, `${config.spicyBaseUrl}/v1`));
    this.chat = new ChatRunner(streamer, this.spicy, this.ledger, config.chatMaxTokens, { log: this.log, ...deps.chatOptions });
    this.characters = deps.characters ?? loadCharacters(config.charactersFile);
    this.conversations = new Conversations(config.historyTurns, 24 * 60 * 60_000, this.now);
  }

  /** Clears leftovers from a previous run and settles tasks that finished while the bot was down. */
  async start(): Promise<void> {
    this.ledger.cleanUp();
    await this.reconcile();
  }

  async reconcile(): Promise<void> {
    await this.media.reconcile();
    await reconcileChatHolds(this.ledger, this.spicy);
  }

  // ---- settings -------------------------------------------------------------------------------

  modelFor(user: string, kind: ModelKind): string {
    const chosen = this.store.state.prefs[user]?.models?.[kind];
    if (chosen && this.catalog.isAllowed(chosen)) return chosen;
    return this.config.defaults[kind];
  }

  setModel(user: string, kind: ModelKind, model: string): void {
    const prefs = (this.store.state.prefs[user] ??= {});
    (prefs.models ??= {})[kind] = model;
    this.store.save();
  }

  characterFor(user: string): Character {
    const id = this.store.state.prefs[user]?.character;
    return this.characters.find((character) => character.id === id) ?? this.characters[0]!;
  }

  setCharacter(user: string, id: string): Character | undefined {
    const character = this.characters.find((item) => item.id === id);
    if (!character) return undefined;
    (this.store.state.prefs[user] ??= {}).character = character.id;
    this.store.save();
    return character;
  }

  greetingFor(character: Character, userName: string): string {
    return fillPlaceholders(character.greeting ?? "", character, userName);
  }

  needsConsent(user: string): boolean {
    return this.config.requireConsent && !this.store.state.consents[user];
  }

  giveConsent(user: string): void {
    this.store.state.consents[user] = new Date(this.now()).toISOString();
    this.store.save();
  }

  // ---- media ----------------------------------------------------------------------------------

  /** Builds the request from the model schema and quotes it. Free. */
  async prepareMedia(
    caller: Caller,
    kind: MediaKind,
    prompt: string,
    idempotencyKey: string,
    imageUrl?: string,
  ): Promise<{ prepared: PreparedMedia; modelName: string }> {
    const model = this.modelFor(caller.user, kind);
    if (!this.catalog.isAllowed(model)) {
      throw new InputError(`${model} is not allowed on this bot (ALLOWED_MODELS). Pick another model with /models.`);
    }
    const details = await this.catalog.get(model);
    if (!details.enabled || !details.available) {
      throw new InputError(`${details.displayName} is not available right now. Pick another ${KIND_LABEL[kind].toLowerCase()} model with /models.`);
    }
    const input = buildMediaInput(kind, details.inputSchema, {
      prompt,
      ...(imageUrl ? { imageUrl } : {}),
      videoSeconds: this.config.videoSeconds,
      ...(this.config.videoResolution ? { videoResolution: this.config.videoResolution } : {}),
      ...(this.config.imageAspectRatio ? { aspectRatio: this.config.imageAspectRatio } : {}),
    });
    const prepared = await this.media.prepare({ user: caller.user, owner: caller.owner, model, input, idempotencyKey });
    return { prepared, modelName: details.displayName };
  }

  private readonly activeKeys = new Map<string, number>();

  /** Marks an idempotency key as in use; false when the same request is already running or waiting. */
  claimKey(key: string): boolean {
    const now = this.now();
    for (const [item, expiresAt] of this.activeKeys) if (expiresAt < now) this.activeKeys.delete(item);
    if (this.activeKeys.has(key)) return false;
    this.activeKeys.set(key, now + 60 * 60_000);
    return true;
  }

  releaseKey(key: string): void {
    this.activeKeys.delete(key);
  }

  /** Remembers a request that is waiting for a tap on Confirm. */
  park<C>(caller: Caller, kind: MediaKind, prepared: PreparedMedia, modelName: string, context: C): PendingRequest<C> {
    this.sweepPending();
    const item: PendingRequest<C> = {
      id: randomBytes(6).toString("base64url"),
      caller,
      prepared,
      kind,
      modelName,
      context,
      createdAt: this.now(),
    };
    this.pending.set(item.id, item);
    return item;
  }

  /**
   * Takes a parked request out for the person who asked for it; a second tap on the same button
   * finds nothing, and someone else's tap leaves it in place.
   */
  takePending<C>(id: string, user: string): PendingRequest<C> | "not_yours" | undefined {
    this.sweepPending();
    const item = this.pending.get(id) as PendingRequest<C> | undefined;
    if (!item) return undefined;
    if (item.caller.user !== user) return "not_yours";
    this.pending.delete(id);
    return item;
  }

  private sweepPending(): void {
    const cutoff = this.now() - 15 * 60_000;
    for (const [id, item] of this.pending) {
      if (item.createdAt >= cutoff) continue;
      this.pending.delete(id);
      this.releaseKey(item.prepared.request.idempotencyKey);
    }
  }

  /** The image to animate from a task this bot created, with a fresh download link. */
  async imageFromTask(taskId: string): Promise<{ url: string; prompt: string | undefined }> {
    const task: TaskRecord = await this.spicy.getTask(taskId);
    const asset = task.output?.assets?.find((item) => item.url && !item.unavailable && (item.mime ?? "image/").startsWith("image/"));
    if (task.state !== "succeeded" || !asset?.url) {
      throw new InputError("That image is no longer available to animate. Generate a new one first.");
    }
    const prompt = typeof task.input?.prompt === "string" ? task.input.prompt : undefined;
    return { url: asset.url, prompt };
  }

  /** The prompt used when someone taps Animate without describing the motion. */
  motionPrompt(motion: string | undefined, imagePrompt: string | undefined): string {
    const text = motion?.trim();
    if (text) return text;
    return imagePrompt ? `${imagePrompt.trim()} ${DEFAULT_MOTION}` : DEFAULT_MOTION;
  }

  /** Puts bytes someone sent into SpicyAPI storage, returning a spicy:// address. */
  async uploadImage(bytes: Uint8Array, contentType: string): Promise<string> {
    const allowed = ["image/jpeg", "image/png", "image/webp"];
    if (!allowed.includes(contentType)) throw new InputError("Send the picture as a JPEG, PNG or WebP image.");
    if (bytes.byteLength > 10 * 1024 * 1024) throw new InputError("That image is larger than 10 MB. Send a smaller one.");
    const file = await this.spicy.uploadBytes(bytes, { contentType: contentType as UploadContentType });
    return file.uri;
  }

  // ---- chat -----------------------------------------------------------------------------------

  async chatTurn(
    caller: Caller,
    conversationKey: string,
    text: string,
    idempotencyKey: string,
    onText?: (fullText: string) => void,
  ): Promise<ChatOutcome & { character: Character }> {
    const character = this.characterFor(caller.user);
    const model = character.model ?? this.modelFor(caller.user, "chat");
    const history = this.conversations.history(conversationKey, character.id);
    const messages = buildMessages(character, history, caller.name);
    messages.push({ role: "user", content: text });
    const price = await this.chatPrice(model);
    const outcome = await this.chat.run({
      user: caller.user,
      owner: caller.owner,
      model,
      messages,
      idempotencyKey,
      pricePer1k: price,
      ...(onText ? { onText } : {}),
    });
    if (outcome.kind === "done" && outcome.text.trim()) {
      this.conversations.append(conversationKey, character.id, text, outcome.text);
    }
    return { ...outcome, character };
  }

  private async chatPrice(model: string): Promise<number | undefined> {
    try {
      const details = await this.catalog.get(model);
      const prices = details.pricing.filter((tier) => tier.unit === "per_1k_tokens").map((tier) => parseUsd(tier.price) ?? 0);
      return prices.length > 0 ? Math.max(...prices) : undefined;
    } catch {
      return undefined;
    }
  }

  // ---- spend ----------------------------------------------------------------------------------

  async spendText(caller: Caller): Promise<string> {
    let balance: string | undefined;
    if (caller.owner) {
      try {
        const result = await this.spicy.getBalance();
        const available = parseUsd(result.available);
        balance = available === undefined ? result.available : formatUsd(available);
      } catch {
        balance = "unavailable right now";
      }
    }
    return spendSummary(this.ledger.snapshot(caller.user), this.config.limits, caller.owner, balance);
  }
}
