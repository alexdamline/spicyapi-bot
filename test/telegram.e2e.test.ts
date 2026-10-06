import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BotCore } from "../src/core/bot-core.js";
import { MemoryStore } from "../src/core/store.js";
import { startTelegram, type TelegramHandle } from "../src/telegram/bot.js";
import { I2V_SCHEMA, fakeSpicy, model, NOW, quote, task, testConfig } from "./fakes.js";

/**
 * Runs the real grammY bot against a stand-in Telegram Bot API on localhost and a fake SpicyAPI, so
 * the command, button and delivery wiring is exercised without a bot token or network access.
 */
const BOT_ID = 999;
const OWNER = { id: 111, is_bot: false, first_name: "Owner" };
const STRANGER = { id: 222, is_bot: false, first_name: "Stranger" };

interface Call {
  method: string;
  body: Record<string, unknown>;
}

class FakeTelegram {
  readonly calls: Call[] = [];
  private updates: unknown[] = [];
  private nextUpdateId = 1;
  private nextMessageId = 100;
  private server: Server | undefined;

  async listen(): Promise<string> {
    this.server = createServer((request, response) => {
      let raw = "";
      request.on("data", (chunk) => (raw += chunk));
      request.on("end", () => {
        const method = (request.url ?? "").split("/").pop() ?? "";
        const body = raw && (request.headers["content-type"] ?? "").includes("json") ? (JSON.parse(raw) as Record<string, unknown>) : {};
        void this.handle(method, body).then((result) => {
          response.setHeader("content-type", "application/json");
          response.end(JSON.stringify({ ok: true, result }));
        });
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${(this.server!.address() as AddressInfo).port}`;
  }

  async close(): Promise<void> {
    await new Promise((resolve) => this.server?.close(resolve));
  }

  push(update: Record<string, unknown>): void {
    this.updates.push({ update_id: this.nextUpdateId++, ...update });
  }

  method(name: string): Call[] {
    return this.calls.filter((call) => call.method === name);
  }

  private async handle(method: string, body: Record<string, unknown>): Promise<unknown> {
    if (method === "getUpdates") {
      await new Promise((resolve) => setTimeout(resolve, 20));
      const batch = this.updates;
      this.updates = [];
      return batch;
    }
    this.calls.push({ method, body });
    if (method === "getMe") return { id: BOT_ID, is_bot: true, first_name: "Spicy", username: "spicy_test_bot", can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false };
    if (method.startsWith("send")) {
      const chatId = Number(body.chat_id);
      return { message_id: this.nextMessageId++, date: 0, chat: { id: chatId, type: chatId > 0 ? "private" : "group" }, text: body.text };
    }
    return true;
  }
}

function message(from: typeof OWNER, text: string, chat: { id: number; type: string } = { id: from.id, type: "private" }, extra: Record<string, unknown> = {}) {
  const command = /^\/\w+/.exec(text);
  return {
    message: {
      message_id: Math.floor(Math.random() * 1e6),
      date: 0,
      chat,
      from,
      text,
      ...(command ? { entities: [{ type: "bot_command", offset: 0, length: command[0].length }] } : {}),
      ...extra,
    },
  };
}

let telegram: FakeTelegram | undefined;
let handle: TelegramHandle | undefined;

afterEach(async () => {
  await handle?.stop();
  await telegram?.close();
  handle = undefined;
  telegram = undefined;
});

async function start(env: Record<string, string> = {}) {
  telegram = new FakeTelegram();
  const apiRoot = await telegram.listen();
  const animateModel = model({ model: "example/video/image-to-video", displayName: "Example Video", modality: "video", tasks: ["image-to-video"], inputSchema: I2V_SCHEMA });
  const spicy = fakeSpicy([model(), animateModel]);
  const core = new BotCore(testConfig({ DEFAULT_IMAGE_MODEL: model().model, DEFAULT_ANIMATE_MODEL: animateModel.model, REQUIRE_CONSENT: "false", ...env }), {
    spicy,
    store: new MemoryStore(),
    streamer: async () => ({
      taskId: undefined,
      deltas: (async function* () {
        yield "Hello ";
        yield "there.";
      })(),
      usage: () => ({ promptTokens: 10, completionTokens: 2 }),
    }),
    characters: [{ id: "mira", name: "Mira", system: "You are {{char}}." }],
    log: () => {},
    now: () => NOW,
  });
  handle = await startTelegram(core, "123:TEST", { apiRoot });
  return { telegram, spicy, core };
}

describe("Telegram bot against a fake Bot API", () => {
  it("registers its commands on start", async () => {
    const { telegram } = await start();
    const commands = (telegram.method("setMyCommands")[0]?.body.commands ?? []) as Array<{ command: string }>;
    expect(commands.map((item) => item.command)).toEqual(["pic", "vid", "animate", "talk", "persona", "newchat", "models", "spend", "report", "help"]);
  });

  it("generates an image, sends it by link with an Animate button, then animates it", async () => {
    const { telegram, spicy } = await start();
    telegram.push(message(OWNER, "/pic a lighthouse at dusk"));
    await vi.waitFor(() => expect(telegram.method("sendPhoto")).toHaveLength(1), { timeout: 5000 });
    const photo = telegram.method("sendPhoto")[0]!.body;
    expect(photo.photo).toBe("https://files.example.test/result.png");
    expect(photo.caption).toBe("Example Image · $0.01 · task job_test1");
    expect(photo.has_spoiler).toBe(false);
    expect(photo.reply_markup).toEqual({ inline_keyboard: [[{ text: "Animate", callback_data: "an:job_test1" }]] });
    expect((spicy.createTask.mock.calls[0] as unknown[])[1]).toMatchObject({ idempotencyKey: expect.stringMatching(/^sbot-/) });

    spicy.getTask.mockResolvedValue(task({ input: { prompt: "a lighthouse at dusk" } }));
    spicy.waitForTask.mockResolvedValue(task({ taskId: "job_video", output: { assets: [{ url: "https://files.example.test/v.mp4", mime: "video/mp4", bytes: 2_000_000 }] } }));
    telegram.push({
      callback_query: {
        id: "cb1",
        from: OWNER,
        chat_instance: "x",
        data: "an:job_test1",
        message: { message_id: 555, date: 0, chat: { id: OWNER.id, type: "private" }, caption: photo.caption, photo: [] },
      },
    });
    await vi.waitFor(() => expect(telegram.method("sendVideo")).toHaveLength(1), { timeout: 5000 });
    expect(telegram.method("sendVideo")[0]!.body).toMatchObject({ video: "https://files.example.test/v.mp4", supports_streaming: true });
    expect((spicy.createTask.mock.calls[1] as unknown[])[0]).toMatchObject({
      input: { image_url: "https://files.example.test/result.png", prompt: expect.stringContaining("a lighthouse at dusk"), duration_seconds: 5, resolution: "480p" },
    });
    // The progress message was deleted once the result arrived.
    expect(telegram.method("deleteMessage").length).toBeGreaterThanOrEqual(2);
  });

  it("asks for confirmation above the threshold and runs only after the tap", async () => {
    const { telegram, spicy } = await start();
    spicy.quoteTask.mockResolvedValue(quote({ estimatedCost: "0.4", maxCharge: "0.4" }));
    telegram.push(message(OWNER, "/pic something big"));
    await vi.waitFor(() => expect(telegram.method("editMessageText").some((call) => String(call.body.text).includes("up to $0.40"))).toBe(true), { timeout: 5000 });
    const ask = telegram.method("editMessageText").find((call) => String(call.body.text).includes("up to $0.40"))!;
    const keyboard = ask.body.reply_markup as { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> };
    const confirm = keyboard.inline_keyboard[0]![0]!;
    expect(confirm.text).toBe("Confirm ($0.40)");
    expect(spicy.createTask).not.toHaveBeenCalled();

    telegram.push({
      callback_query: { id: "cb2", from: OWNER, chat_instance: "x", data: confirm.callback_data, message: { message_id: Number(ask.body.message_id), date: 0, chat: { id: OWNER.id, type: "private" }, text: "..." } },
    });
    await vi.waitFor(() => expect(telegram.method("sendPhoto")).toHaveLength(1), { timeout: 5000 });
    expect(spicy.createTask).toHaveBeenCalledTimes(1);
  });

  it("tells strangers it is private and spends nothing", async () => {
    const { telegram, spicy } = await start();
    telegram.push(message(STRANGER, "/pic hello"));
    await vi.waitFor(() => expect(telegram.method("sendMessage")).toHaveLength(1), { timeout: 5000 });
    expect(String(telegram.method("sendMessage")[0]!.body.text)).toMatch(/private bot.*222/);
    expect(spicy.quoteTask).not.toHaveBeenCalled();
  });

  it("stays silent in groups nobody listed, and hides results in listed ones", async () => {
    const { telegram, spicy } = await start({ ALLOWED_CHAT_IDS: "-100777" });
    telegram.push(message(OWNER, "/pic in an unlisted group", { id: -100555, type: "supergroup" }));
    telegram.push(message(STRANGER, "/pic in a listed group", { id: -100777, type: "supergroup" }));
    await vi.waitFor(() => expect(telegram.method("sendPhoto")).toHaveLength(1), { timeout: 5000 });
    expect(telegram.method("sendPhoto")[0]!.body).toMatchObject({ chat_id: -100777, has_spoiler: true });
    expect(spicy.quoteTask).toHaveBeenCalledTimes(1);
    expect(telegram.calls.some((call) => call.body.chat_id === -100555)).toBe(false);
  });

  it("refuses to animate uploaded photos unless the operator allows it", async () => {
    const { telegram, spicy } = await start();
    telegram.push(
      message(OWNER, "/animate wave hello", undefined, {
        reply_to_message: { message_id: 7, date: 0, chat: { id: OWNER.id, type: "private" }, from: OWNER, photo: [{ file_id: "f1", file_unique_id: "u1", width: 10, height: 10 }] },
      }),
    );
    await vi.waitFor(() => expect(telegram.method("sendMessage")).toHaveLength(1), { timeout: 5000 });
    expect(String(telegram.method("sendMessage")[0]!.body.text)).toMatch(/uploaded photos is turned off/);
    expect(telegram.method("getFile")).toHaveLength(0);
    expect(spicy.uploadBytes).not.toHaveBeenCalled();
  });

  it("asks for consent once before the first generation", async () => {
    const { telegram, spicy } = await start({ REQUIRE_CONSENT: "true" });
    telegram.push(message(OWNER, "/pic hello"));
    await vi.waitFor(() => expect(telegram.method("sendMessage")).toHaveLength(1), { timeout: 5000 });
    expect(String(telegram.method("sendMessage")[0]!.body.text)).toMatch(/18 or older/);
    expect(spicy.quoteTask).not.toHaveBeenCalled();
    telegram.push({ callback_query: { id: "cb3", from: OWNER, chat_instance: "x", data: "consent", message: { message_id: 100, date: 0, chat: { id: OWNER.id, type: "private" }, text: "rules" } } });
    await vi.waitFor(() => expect(telegram.method("answerCallbackQuery")).toHaveLength(1), { timeout: 5000 });
    telegram.push(message(OWNER, "/pic hello again"));
    await vi.waitFor(() => expect(telegram.method("sendPhoto")).toHaveLength(1), { timeout: 5000 });
  });

  it("streams a character reply into one edited message in a private chat", async () => {
    const { telegram } = await start();
    telegram.push(message(OWNER, "hi there"));
    await vi.waitFor(
      () => {
        const texts = [...telegram.method("sendMessage"), ...telegram.method("editMessageText")].map((call) => call.body.text);
        expect(texts.at(-1)).toBe("Hello there.");
      },
      { timeout: 5000 },
    );
  });
});
