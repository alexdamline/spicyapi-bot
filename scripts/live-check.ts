/**
 * Real-API smoke test of the bot's core, without Telegram or Discord. It spends real money
 * (about $0.12 with the defaults), so it is never run in CI.
 *
 *   SPICY_API_KEY=sk-spicy-... npm run live-check
 *
 * Steps: quote and generate one image; animate that image through the confirmation path (the
 * cheapest settings: 480p, shortest duration); stream two chat turns with the first character.
 * Optional: LIVE_IMAGE_PROMPT, LIVE_MOTION_PROMPT, LIVE_CHAT_MESSAGE, DEFAULT_*_MODEL.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TaskOutputAsset } from "@spicyapi/sdk";
import { loadConfig } from "../src/config.js";
import { BotCore } from "../src/core/bot-core.js";
import { resolvePending, startMedia, type Button, type MediaSurface } from "../src/core/flows.js";
import { idempotencyKey } from "../src/core/idempotency.js";
import { formatUsd, parseUsd } from "../src/core/money.js";

const started = Date.now();
const stamp = () => `${((Date.now() - started) / 1000).toFixed(1).padStart(6)}s`;
const say = (message: string) => console.log(`${stamp()}  ${message}`);

function surface(label: string) {
  const statuses: string[] = [];
  const delivered: Array<{ asset: TaskOutputAsset; caption: string; buttons: Button[] }> = [];
  let lastButtons: Button[] | undefined;
  const value: MediaSurface = {
    progressIntervalMs: 3000,
    async status(text, buttons) {
      statuses.push(text);
      lastButtons = buttons;
      say(`[${label}] status: ${text.replace(/\n/g, " | ")}${buttons ? ` [buttons: ${buttons.map((b) => b.label).join(", ")}]` : ""}`);
    },
    async deliver(asset, caption, buttons) {
      delivered.push({ asset, caption, buttons });
      say(`[${label}] result: ${caption} (${asset.mime ?? "?"}, ${asset.bytes ?? "?"} bytes${asset.durationSeconds ? `, ${asset.durationSeconds}s` : ""})`);
    },
    async done() {},
  };
  return { value, statuses, delivered, buttons: () => lastButtons };
}

async function checkLink(asset: TaskOutputAsset): Promise<string> {
  const response = await fetch(asset.url!, { headers: { Range: "bytes=0-1023" } });
  await response.body?.cancel();
  return `HTTP ${response.status}, ${response.headers.get("content-type") ?? "no type"}, host ${new URL(asset.url!).host}`;
}

async function waitFor<T>(read: () => T | undefined, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error("timed out waiting for the result");
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

async function main(): Promise<void> {
  const dataDir = mkdtempSync(join(tmpdir(), "spicyapi-bot-live-"));
  const { config } = loadConfig({
    TELEGRAM_BOT_TOKEN: "live-check-unused",
    OWNER_ID: "1",
    CONFIRM_ABOVE_USD: "0.05",
    VIDEO_SECONDS: "1",
    VIDEO_RESOLUTION: "480p",
    ...process.env,
    DATA_DIR: dataDir,
  });
  const core = new BotCore(config, { log: (message) => say(`log: ${message}`) });
  const caller = { user: "live:1", owner: false, name: "Sam" };
  const run = Date.now().toString(36);
  const before = await core.spicy.getBalance();
  say(`balance before: ${before.available} USD`);

  // 1. Image
  const image = surface("image");
  await startMedia(core, caller, "image", process.env.LIVE_IMAGE_PROMPT ?? "A lighthouse on a cliff at dusk, warm light in the windows, film photo", idempotencyKey(["live", run, "image"]), image.value);
  const picture = image.delivered[0];
  if (!picture) throw new Error("no image was delivered");
  say(`[image] link check: ${await checkLink(picture.asset)}`);
  const animate = picture.buttons.find((button) => button.id.startsWith("an:"));
  if (!animate) throw new Error("the image result has no Animate button");

  // 2. Animate the generated image (the button path), confirming the price
  const source = await core.imageFromTask(animate.id.slice(3));
  say(`[animate] source image from task ${animate.id.slice(3)} (prompt kept: ${source.prompt ? "yes" : "no"})`);
  const video = surface("animate");
  const motion = core.motionPrompt(process.env.LIVE_MOTION_PROMPT, source.prompt);
  await startMedia(core, caller, "animate", motion, idempotencyKey(["live", run, "animate"]), video.value, source.url);
  const confirm = video.buttons()?.find((button) => button.id.startsWith("ok:"));
  if (confirm) {
    say(`[animate] confirming (${confirm.label})`);
    await resolvePending(core, confirm.id, caller.user, video.value);
  }
  const clip = await waitFor(() => video.delivered[0] ?? (video.statuses.at(-1)?.match(/failed|declined|Nothing was charged|still running/i) ? null : undefined), 15 * 60_000);
  if (!clip) throw new Error(`video did not finish: ${video.statuses.at(-1)}`);
  say(`[animate] link check: ${await checkLink(clip.asset)}`);
  say(`[animate] progress updates shown: ${video.statuses.filter((text) => /Queued|Generating/.test(text)).length}`);

  // 3. Chat: two streamed turns with the first character
  const conversation = `live:${run}`;
  for (const [index, message] of [process.env.LIVE_CHAT_MESSAGE ?? "Hi! I'm Sam, your new crewmate. What's that signal?", "Quick check: what did I say my name was?"].entries()) {
    let deltas = 0;
    let firstAt: number | undefined;
    const turnStart = Date.now();
    const outcome = await core.chatTurn(caller, conversation, message, idempotencyKey(["live", run, "chat", index]), () => {
      deltas += 1;
      firstAt ??= Date.now();
    });
    if (outcome.kind !== "done") throw new Error(`chat blocked: ${JSON.stringify(outcome)}`);
    say(`[chat ${index + 1}] ${outcome.character.name} via ${config.defaults.chat}: ${deltas} streamed updates, first token after ${firstAt ? firstAt - turnStart : "?"}ms, task ${outcome.taskId ?? "(none)"}, charged ${formatUsd(outcome.charged)}`);
    say(`[chat ${index + 1}] reply (${outcome.text.length} chars): ${outcome.text.slice(0, 160).replace(/\n/g, " ")}${outcome.text.length > 160 ? "..." : ""}`);
  }

  await core.reconcile();
  const snap = core.ledger.snapshot(caller.user);
  const after = await core.spicy.getBalance();
  const spent = (parseUsd(before.available) ?? 0) - (parseUsd(after.available) ?? 0);
  say(`ledger: settled ${formatUsd(snap.userSettled)}, still held ${formatUsd(snap.userHeld)}`);
  say(`balance after: ${after.available} USD (account balance moved by ${formatUsd(spent)})`);
  rmSync(dataDir, { recursive: true, force: true });
}

main().catch((error) => {
  console.error(`live check failed: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`);
  process.exit(1);
});
