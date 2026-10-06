import { autoRetry } from "@grammyjs/auto-retry";
import { Bot, GrammyError, InlineKeyboard, InputFile, type Context } from "grammy";
import type { Message } from "grammy/types";
import type { TaskOutputAsset } from "@spicyapi/sdk";
import { decideAccess, userKey, type ChatContext } from "../core/access.js";
import type { BotCore, Caller } from "../core/bot-core.js";
import { KIND_LABEL, priceLabel } from "../core/catalog.js";
import { MB, TooLargeError, fetchBytes, formatMb, resultFileName, taskIdFromText } from "../core/download.js";
import { CALLBACK, resolvePending, runChat, splitMessage, startMedia, type Button, type ChatSurface, type MediaSurface } from "../core/flows.js";
import { COMMANDS, RULES_TEXT, helpText } from "../core/help.js";
import { idempotencyKey } from "../core/idempotency.js";
import { InputError } from "../core/inputs.js";
import { describeError } from "../core/messages.js";
import type { MediaKind, ModelKind } from "../core/store.js";

const TEXT_LIMIT = 4096;
/** Telegram fetches files from a URL itself up to these sizes (Bot API "Sending files"). */
const URL_LIMIT = { photo: 5 * MB, other: 20 * MB };
/** Multipart upload limits. */
const UPLOAD_LIMIT = { photo: 10 * MB, other: 50 * MB };
const PAGE_SIZE = 8;
const MODEL_KINDS: ModelKind[] = ["image", "video", "animate", "chat"];

export interface TelegramHandle {
  stop(): Promise<void>;
}

export interface TelegramOptions {
  /** A self-hosted Bot API server (or a test double). Defaults to https://api.telegram.org. */
  apiRoot?: string;
}

export async function startTelegram(core: BotCore, token: string, options: TelegramOptions = {}): Promise<TelegramHandle> {
  const config = core.config;
  const apiRoot = (options.apiRoot ?? "https://api.telegram.org").replace(/\/+$/, "");
  const bot = new Bot(token, { client: { apiRoot } });
  bot.api.config.use(autoRetry({ maxRetryAttempts: 3, maxDelaySeconds: 60 }));
  await bot.init();
  const botId = bot.botInfo.id;

  // ---- access ---------------------------------------------------------------------------------

  function chatContext(ctx: Context): ChatContext {
    const chat = ctx.chat;
    if (!chat || chat.type === "private") return { kind: "private" };
    return { kind: "group", ids: [String(chat.id)] };
  }

  function callerOf(ctx: Context, owner: boolean): Caller {
    const from = ctx.from!;
    return { user: userKey("telegram", from.id), owner, name: from.first_name || "you" };
  }

  /** Returns the caller when this person may use the bot here, otherwise explains (in private) and returns undefined. */
  async function admit(ctx: Context, { needsConsent = true } = {}): Promise<Caller | undefined> {
    if (!ctx.from || ctx.from.is_bot) return undefined;
    const decision = decideAccess(config.access, { platform: "telegram", userId: ctx.from.id, chat: chatContext(ctx) });
    if (!decision.allowed) {
      if (decision.reason === "user_not_allowed") {
        await reply(ctx, `This is a private bot. If you know its operator, send them your Telegram user ID: ${ctx.from.id}`);
      } else if (ctx.callbackQuery) {
        await ctx.answerCallbackQuery({ text: "This bot is not enabled in this chat." }).catch(() => {});
      }
      // Unlisted groups get no answer at all, so the bot stays quiet where nobody approved it.
      return undefined;
    }
    const caller = callerOf(ctx, decision.owner);
    if (needsConsent && core.needsConsent(caller.user)) {
      await reply(ctx, RULES_TEXT, new InlineKeyboard().text("I am 18+ and agree", "consent"));
      if (ctx.callbackQuery) await ctx.answerCallbackQuery().catch(() => {});
      return undefined;
    }
    return caller;
  }

  async function reply(ctx: Context, text: string, keyboard?: InlineKeyboard): Promise<Message | undefined> {
    const chatId = ctx.chat?.id;
    if (chatId === undefined) return undefined;
    const replyTo = ctx.msg?.message_id && !ctx.callbackQuery ? { reply_parameters: { message_id: ctx.msg.message_id, allow_sending_without_reply: true } } : {};
    return bot.api.sendMessage(chatId, text, { ...replyTo, ...(keyboard ? { reply_markup: keyboard } : {}), link_preview_options: { is_disabled: true } });
  }

  function keyboardOf(buttons: Button[] | undefined): InlineKeyboard | undefined {
    if (!buttons || buttons.length === 0) return undefined;
    const keyboard = new InlineKeyboard();
    for (const button of buttons) keyboard.text(button.label, button.id);
    return keyboard;
  }

  function spoiler(ctx: Context): boolean {
    if (config.spoilerMedia === "always") return true;
    if (config.spoilerMedia === "never") return false;
    return ctx.chat?.type !== "private";
  }

  function detach(work: Promise<unknown>): void {
    work.catch((error) => core.log(`telegram handler failed: ${error instanceof Error ? error.message : String(error)}`));
  }

  // ---- media surface --------------------------------------------------------------------------

  /** A status message edited in place; created on first use, or reused when given (button taps). */
  function mediaSurface(ctx: Context, chatId: number, replyTo: number | undefined, existing?: number): MediaSurface {
    let statusId = existing;
    return {
      progressIntervalMs: config.progressIntervalMs,
      async status(text, buttons) {
        const keyboard = keyboardOf(buttons);
        if (statusId === undefined) {
          const sent = await bot.api.sendMessage(chatId, text, {
            ...(keyboard ? { reply_markup: keyboard } : {}),
            ...(replyTo ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } } : {}),
          });
          statusId = sent.message_id;
          return;
        }
        // An empty keyboard removes the Confirm / Cancel buttons once they have been used.
        await bot.api.editMessageText(chatId, statusId, text, { reply_markup: keyboard ?? new InlineKeyboard() }).catch(ignoreNotModified);
      },
      async deliver(asset, caption, buttons) {
        await sendAsset(chatId, asset, caption, keyboardOf(buttons), spoiler(ctx), replyTo);
      },
      async done() {
        if (statusId !== undefined) await bot.api.deleteMessage(chatId, statusId).catch(() => {});
      },
      activity(kind) {
        const action = kind === "image" ? "upload_photo" : "upload_video";
        bot.api.sendChatAction(chatId, action).catch(() => {});
      },
    };
  }

  async function sendAsset(
    chatId: number,
    asset: TaskOutputAsset,
    caption: string,
    keyboard: InlineKeyboard | undefined,
    hidden: boolean,
    replyTo: number | undefined,
  ): Promise<void> {
    const url = asset.url!;
    const mime = asset.mime ?? "";
    const type = mime.startsWith("image/") ? "photo" : mime.startsWith("video/") ? "video" : "document";
    const common = {
      caption,
      ...(keyboard ? { reply_markup: keyboard } : {}),
      ...(replyTo ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } } : {}),
    };
    const send = (file: string | InputFile, as: typeof type) =>
      as === "photo"
        ? bot.api.sendPhoto(chatId, file, { ...common, has_spoiler: hidden })
        : as === "video"
          ? bot.api.sendVideo(chatId, file, { ...common, has_spoiler: hidden, supports_streaming: true })
          : bot.api.sendDocument(chatId, file, common);

    // 1. Let Telegram fetch the signed link itself: no bytes pass through this machine.
    const urlLimit = type === "photo" ? URL_LIMIT.photo : URL_LIMIT.other;
    if (asset.bytes === undefined || asset.bytes <= urlLimit) {
      try {
        await send(url, type);
        return;
      } catch (error) {
        core.log(`sending by link failed, uploading instead (${error instanceof GrammyError ? error.description : "error"})`);
      }
    }
    // 2. Download and upload; a large image goes as a file instead of a photo.
    let tooLarge = "";
    try {
      const { bytes } = await fetchBytes(url, UPLOAD_LIMIT.other);
      const name = resultFileName(mime, "result");
      const as = type === "photo" && bytes.byteLength > UPLOAD_LIMIT.photo ? "document" : type;
      try {
        await send(new InputFile(bytes, name), as);
      } catch (error) {
        // Telegram rejects some images as photos (dimensions, format); a file always goes through.
        if (as === "document") throw error;
        await send(new InputFile(bytes, name), "document");
      }
      return;
    } catch (error) {
      if (error instanceof TooLargeError) tooLarge = error.bytes ? ` (${formatMb(error.bytes)})` : "";
      core.log(`upload to Telegram failed: ${error instanceof Error ? error.message : "error"}`);
    }
    // 3. Could not send the file: hand over the link, which expires.
    await bot.api.sendMessage(
      chatId,
      `${caption}\n${tooLarge ? `The file is too large to send here${tooLarge}.` : "The file could not be sent here."} Download it within about 20 minutes:\n${url}`,
      { ...(keyboard ? { reply_markup: keyboard } : {}), link_preview_options: { is_disabled: true } },
    );
  }

  function mediaKey(ctx: Context, action: string): string {
    return idempotencyKey(["tg", botId, ctx.chat!.id, ctx.msg!.message_id, action]);
  }

  function media(ctx: Context, caller: Caller, kind: MediaKind, prompt: string, imageUrl?: string): void {
    const chatId = ctx.chat!.id;
    const replyTo = ctx.msg?.message_id;
    detach(startMedia(core, caller, kind, prompt, mediaKey(ctx, kind), mediaSurface(ctx, chatId, replyTo), imageUrl));
  }

  // ---- commands -------------------------------------------------------------------------------

  const names = async (caller: Caller) => {
    const character = core.characterFor(caller.user);
    const name = (kind: ModelKind) => core.catalog.displayName(core.modelFor(caller.user, kind));
    await Promise.all(MODEL_KINDS.map((kind) => core.catalog.list(kind).catch(() => [])));
    return { image: name("image"), video: name("video"), animate: name("animate"), chat: name("chat"), character: character.name };
  };

  bot.command(["start", COMMANDS.help.name], async (ctx) => {
    const caller = await admit(ctx, { needsConsent: false });
    if (!caller) return;
    await reply(ctx, helpText(config, "telegram", await names(caller)));
    if (core.needsConsent(caller.user)) await reply(ctx, RULES_TEXT, new InlineKeyboard().text("I am 18+ and agree", "consent"));
  });

  bot.command(COMMANDS.pic.name, async (ctx) => {
    const caller = await admit(ctx);
    if (!caller) return;
    if (!ctx.match.trim()) return void (await reply(ctx, "Usage: /pic <what to draw>"));
    media(ctx, caller, "image", ctx.match);
  });

  bot.command(COMMANDS.vid.name, async (ctx) => {
    const caller = await admit(ctx);
    if (!caller) return;
    if (!ctx.match.trim()) return void (await reply(ctx, "Usage: /vid <what should happen>"));
    media(ctx, caller, "video", ctx.match);
  });

  bot.command(COMMANDS.animate.name, async (ctx) => animateFromReply(ctx, ctx.match, ctx.msg.reply_to_message));

  // A photo sent with the caption "/animate ..." (Telegram does not treat captions as commands).
  bot.on("message:photo", async (ctx, next) => {
    const caption = ctx.msg.caption ?? "";
    const match = /^\/animate(?:@\w+)?(?:\s+([\s\S]*))?$/i.exec(caption.trim());
    if (!match) return next();
    await animateFromReply(ctx, match[1] ?? "", ctx.msg);
  });

  async function animateFromReply(ctx: Context, motion: string, target: Message | undefined): Promise<void> {
    const caller = await admit(ctx);
    if (!caller) return;
    if (!target) {
      await reply(ctx, 'Reply to an image with /animate <how it should move>, or tap "Animate" under an image the bot made.');
      return;
    }
    try {
      let imageUrl: string;
      let basePrompt: string | undefined;
      const fromBot = target.from?.id === botId;
      const taskId = fromBot ? (taskIdFromText(target.caption) ?? animateTaskFromMarkup(target)) : undefined;
      if (taskId) {
        ({ url: imageUrl, prompt: basePrompt } = await core.imageFromTask(taskId));
      } else {
        if (!config.allowPhotoUploads) {
          await reply(ctx, 'Animating uploaded photos is turned off on this bot. Use "Animate" under an image the bot made.');
          return;
        }
        imageUrl = await uploadFromMessage(target);
      }
      media(ctx, caller, "animate", core.motionPrompt(motion, basePrompt), imageUrl);
    } catch (error) {
      await reply(ctx, describeError(error));
    }
  }

  function animateTaskFromMarkup(message: Message): string | undefined {
    for (const row of message.reply_markup?.inline_keyboard ?? []) {
      for (const button of row) {
        if ("callback_data" in button && button.callback_data?.startsWith(CALLBACK.animate)) return button.callback_data.slice(CALLBACK.animate.length);
      }
    }
    return undefined;
  }

  /**
   * Telegram file links contain the bot token, so they must never be handed to SpicyAPI. The bytes
   * are downloaded here and uploaded to SpicyAPI storage instead.
   */
  async function uploadFromMessage(message: Message): Promise<string> {
    const photo = message.photo?.at(-1);
    const document = message.document?.mime_type?.startsWith("image/") ? message.document : undefined;
    const fileId = photo?.file_id ?? document?.file_id;
    if (!fileId) throw new InputError("That message has no image. Reply to a photo.");
    const size = photo?.file_size ?? document?.file_size;
    if (size !== undefined && size > 10 * MB) throw new InputError("That image is larger than 10 MB. Send a smaller one.");
    const file = await bot.api.getFile(fileId);
    if (!file.file_path) throw new InputError("Telegram did not return that file. Send it again.");
    const { bytes, contentType } = await fetchBytes(`${apiRoot}/file/bot${token}/${file.file_path}`, 10 * MB);
    const type = document?.mime_type ?? (contentType.startsWith("image/") ? contentType : "image/jpeg");
    return core.uploadImage(bytes, type);
  }

  bot.command(COMMANDS.talk.name, async (ctx) => {
    const caller = await admit(ctx);
    if (!caller) return;
    if (!ctx.match.trim()) return void (await reply(ctx, `Usage: /talk <message>`));
    await chat(ctx, ctx.match, caller);
  });

  bot.command(COMMANDS.newchat.name, async (ctx) => {
    const caller = await admit(ctx, { needsConsent: false });
    if (!caller) return;
    core.conversations.reset(conversationKey(ctx));
    await reply(ctx, `Started over with ${core.characterFor(caller.user).name}.`);
  });

  bot.command(COMMANDS.persona.name, async (ctx) => {
    const caller = await admit(ctx, { needsConsent: false });
    if (!caller) return;
    const current = core.characterFor(caller.user).id;
    const keyboard = new InlineKeyboard();
    for (const character of core.characters) keyboard.text(`${character.id === current ? "✓ " : ""}${character.name}`, `ps:${character.id}`).row();
    await reply(ctx, "Who do you want to talk to?", keyboard);
  });

  bot.command(COMMANDS.models.name, async (ctx) => {
    const caller = await admit(ctx, { needsConsent: false });
    if (!caller) return;
    await reply(ctx, "Which model do you want to change?", kindKeyboard());
  });

  bot.command(COMMANDS.spend.name, async (ctx) => {
    const caller = await admit(ctx, { needsConsent: false });
    if (!caller) return;
    await reply(ctx, await core.spendText(caller));
  });

  bot.command(COMMANDS.report.name, async (ctx) => {
    const caller = await admit(ctx, { needsConsent: false });
    if (!caller) return;
    const text = ctx.match.trim();
    if (!text) return void (await reply(ctx, "Usage: /report <what happened> (you can also reply to the message with /report <text>)"));
    const about = taskIdFromText(ctx.msg.reply_to_message?.caption) ?? taskIdFromText(ctx.msg.reply_to_message?.text);
    const owners = [...config.access.owners.ids].filter((id) => id.startsWith("telegram:") || id.startsWith("*:")).map((id) => id.split(":")[1]!);
    let delivered = 0;
    for (const owner of owners) {
      await bot.api
        .sendMessage(owner, `Report from user ${ctx.from!.id} in chat ${ctx.chat.id}${about ? ` about task ${about}` : ""}:\n${text}`)
        .then(() => delivered++)
        .catch(() => {});
    }
    await reply(
      ctx,
      `${delivered > 0 ? "Sent to the operator." : "Could not reach the operator here."} Content that breaks SpicyAPI's rules can also be reported at https://spicyapi.ai/abuse`,
    );
  });

  // ---- chat -----------------------------------------------------------------------------------

  /** Bot messages that are chat replies, so replying to one in a group continues the conversation. */
  const chatReplies = new Set<string>();
  function rememberChatReply(chatId: number, messageId: number): void {
    chatReplies.add(`${chatId}:${messageId}`);
    if (chatReplies.size > 5000) chatReplies.delete(chatReplies.values().next().value!);
  }

  function conversationKey(ctx: Context): string {
    return `tg:${ctx.chat!.id}:${ctx.from!.id}`;
  }

  async function chat(ctx: Context, text: string, admitted?: Caller): Promise<void> {
    const caller = admitted ?? (await admit(ctx));
    if (!caller) return;
    const chatId = ctx.chat!.id;
    const key = conversationKey(ctx);
    const character = core.characterFor(caller.user);
    if (character.greeting && core.conversations.isNew(key, character.id)) {
      rememberChatReply(chatId, (await bot.api.sendMessage(chatId, core.greetingFor(character, caller.name))).message_id);
    }
    const replyTo = ctx.msg!.message_id;
    let messageId: number | undefined;
    const surface: ChatSurface = {
      intervalMs: ctx.chat!.type === "private" ? 1500 : 3500,
      typing: () => void bot.api.sendChatAction(chatId, "typing").catch(() => {}),
      async show(value) {
        if (messageId === undefined) {
          const sent = await bot.api.sendMessage(chatId, value, { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } });
          messageId = sent.message_id;
          rememberChatReply(chatId, sent.message_id);
        } else {
          await bot.api.editMessageText(chatId, messageId, value).catch(ignoreNotModified);
        }
      },
      async finish(value) {
        const [first, ...rest] = splitMessage(value, TEXT_LIMIT);
        await this.show(first!);
        for (const part of rest) rememberChatReply(chatId, (await bot.api.sendMessage(chatId, part)).message_id);
      },
    };
    detach(runChat(core, caller, key, text, idempotencyKey(["tg", botId, chatId, replyTo, "chat"]), surface, TEXT_LIMIT - 10));
  }

  // Plain text: private chats talk to the character; in groups, replying to the bot's chat message continues it.
  bot.on("message:text", async (ctx) => {
    const text = ctx.msg.text;
    if (text.startsWith("/")) {
      if (ctx.chat.type === "private") await reply(ctx, "Unknown command. Send /help to see what this bot can do.");
      return;
    }
    if (ctx.chat.type === "private") {
      if (config.privateChat) await chat(ctx, text);
      return;
    }
    const replied = ctx.msg.reply_to_message;
    if (replied?.from?.id === botId && chatReplies.has(`${ctx.chat.id}:${replied.message_id}`)) await chat(ctx, text);
  });

  // ---- buttons --------------------------------------------------------------------------------

  function kindKeyboard(): InlineKeyboard {
    const keyboard = new InlineKeyboard();
    for (const kind of MODEL_KINDS) keyboard.text(KIND_LABEL[kind], `mk:${kind}:0`).row();
    return keyboard;
  }

  async function modelPage(caller: Caller, kind: ModelKind, page: number): Promise<{ text: string; keyboard: InlineKeyboard }> {
    const models = await core.catalog.list(kind);
    const current = core.modelFor(caller.user, kind);
    const pages = Math.max(1, Math.ceil(models.length / PAGE_SIZE));
    const safePage = Math.min(Math.max(0, page), pages - 1);
    const keyboard = new InlineKeyboard();
    models.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE).forEach((model, offset) => {
      const index = safePage * PAGE_SIZE + offset;
      const price = priceLabel(model);
      keyboard.text(`${model.model === current ? "✓ " : ""}${model.displayName}${price ? ` · ${price}` : ""}`, `mm:${kind}:${index}`).row();
    });
    if (pages > 1) {
      if (safePage > 0) keyboard.text("‹ Previous", `mk:${kind}:${safePage - 1}`);
      if (safePage < pages - 1) keyboard.text("Next ›", `mk:${kind}:${safePage + 1}`);
      keyboard.row();
    }
    keyboard.text("Back", "mk:back:0");
    const text = models.length === 0 ? `No ${KIND_LABEL[kind].toLowerCase()} models are available right now.` : `${KIND_LABEL[kind]} model (page ${safePage + 1} of ${pages}). Current: ${core.catalog.displayName(current)}`;
    return { text, keyboard };
  }

  bot.on("callback_query:data", async (ctx) => {
    const data = ctx.callbackQuery.data;
    const message = ctx.callbackQuery.message;
    const chatId = message?.chat.id;

    if (data === "consent") {
      const caller = await admit(ctx, { needsConsent: false });
      if (!caller) return;
      core.giveConsent(caller.user);
      await ctx.answerCallbackQuery({ text: "Thanks!" });
      if (message) await ctx.editMessageText(`${RULES_TEXT}\n\nAccepted. Send /help to see what you can do.`).catch(() => {});
      return;
    }

    if (data.startsWith(CALLBACK.confirm) || data.startsWith(CALLBACK.cancel)) {
      const caller = await admit(ctx);
      if (!caller || !message || chatId === undefined) return;
      const surface = mediaSurface(ctx, chatId, message.reply_to_message?.message_id, message.message_id);
      const notice = await resolvePending(core, data, caller.user, surface);
      await ctx.answerCallbackQuery(notice ? { text: notice, show_alert: true } : undefined).catch(() => {});
      return;
    }

    if (data.startsWith(CALLBACK.animate)) {
      const caller = await admit(ctx);
      if (!caller || !message || chatId === undefined) return;
      await ctx.answerCallbackQuery({ text: "Pricing the video..." }).catch(() => {});
      const taskId = data.slice(CALLBACK.animate.length);
      try {
        const source = await core.imageFromTask(taskId);
        const key = idempotencyKey(["tg", botId, chatId, message.message_id, "animate", ctx.from.id]);
        detach(
          startMedia(core, caller, "animate", core.motionPrompt(undefined, source.prompt), key, mediaSurface(ctx, chatId, message.message_id), source.url),
        );
      } catch (error) {
        await bot.api.sendMessage(chatId, describeError(error), { reply_parameters: { message_id: message.message_id, allow_sending_without_reply: true } });
      }
      return;
    }

    if (data.startsWith("ps:")) {
      const caller = await admit(ctx, { needsConsent: false });
      if (!caller) return;
      const character = core.setCharacter(caller.user, data.slice(3));
      await ctx.answerCallbackQuery({ text: character ? `Now talking to ${character.name}` : "That character no longer exists." });
      if (character && message) await ctx.editMessageText(`Now talking to ${character.name}. Say hello!`).catch(() => {});
      return;
    }

    if (data.startsWith("mk:") || data.startsWith("mm:")) {
      const caller = await admit(ctx, { needsConsent: false });
      if (!caller) return;
      const [action, kindRaw, numberRaw] = data.split(":");
      if (kindRaw === "back") {
        await ctx.editMessageText("Which model do you want to change?", { reply_markup: kindKeyboard() }).catch(ignoreNotModified);
        await ctx.answerCallbackQuery().catch(() => {});
        return;
      }
      const kind = kindRaw as ModelKind;
      if (!MODEL_KINDS.includes(kind)) return void (await ctx.answerCallbackQuery());
      const number = Number(numberRaw) || 0;
      try {
        if (action === "mm") {
          const chosen = (await core.catalog.list(kind))[number];
          if (!chosen) {
            await ctx.answerCallbackQuery({ text: "The model list changed; please pick again." });
          } else {
            core.setModel(caller.user, kind, chosen.model);
            await ctx.answerCallbackQuery({ text: `${KIND_LABEL[kind]}: ${chosen.displayName}` });
          }
        } else {
          await ctx.answerCallbackQuery().catch(() => {});
        }
        const page = action === "mm" ? Math.floor(number / PAGE_SIZE) : number;
        const view = await modelPage(caller, kind, page);
        await ctx.editMessageText(view.text, { reply_markup: view.keyboard }).catch(ignoreNotModified);
      } catch (error) {
        await ctx.answerCallbackQuery({ text: describeError(error).slice(0, 190), show_alert: true }).catch(() => {});
      }
      return;
    }

    await ctx.answerCallbackQuery().catch(() => {});
  });

  bot.catch((error) => {
    core.log(`telegram update ${error.ctx.update.update_id} failed: ${error.error instanceof Error ? error.error.message : String(error.error)}`);
  });

  await bot.api.setMyCommands(Object.values(COMMANDS).map(({ name, description }) => ({ command: name, description })));

  // Long polling: no public address, no webhook secret, no TLS to set up.
  let stopping = false;
  bot
    .start({
      allowed_updates: ["message", "callback_query"],
      onStart: (info) => core.log(`Telegram bot @${info.username} is running`),
    })
    .catch((error) => {
      // Stopping aborts the poll in flight; anything else means polling has ended for good.
      if (stopping) return;
      core.log(`Telegram polling stopped: ${error instanceof Error ? error.message : String(error)}`);
      // Exit so Docker or Railway restarts the bot. A "Conflict" here means a second copy is running with the same token.
      process.exit(1);
    });

  return {
    async stop() {
      stopping = true;
      await bot.stop();
    },
  };
}

function ignoreNotModified(error: unknown): void {
  if (error instanceof GrammyError && error.description.includes("message is not modified")) return;
  throw error;
}
