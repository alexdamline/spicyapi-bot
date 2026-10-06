import { ConfigError, loadConfig } from "./config.js";
import { BotCore } from "./core/bot-core.js";
import { startDiscord, type DiscordHandle } from "./discord/bot.js";
import { startTelegram, type TelegramHandle } from "./telegram/bot.js";

const RECONCILE_INTERVAL_MS = 5 * 60_000;

async function main(): Promise<void> {
  let loaded: ReturnType<typeof loadConfig>;
  try {
    loaded = loadConfig(process.env);
  } catch (error) {
    console.error(error instanceof ConfigError ? error.message : error);
    console.error("See .env.example for every setting.");
    process.exit(1);
  }
  const { config, warnings } = loaded;
  for (const warning of warnings) console.warn(`[spicyapi-bot] WARNING: ${warning}`);

  const core = new BotCore(config);
  await core.start().catch((error) => core.log(`startup reconcile failed: ${String(error)}`));
  const reconcileTimer = setInterval(() => {
    core.reconcile().catch((error) => core.log(`reconcile failed: ${String(error)}`));
  }, RECONCILE_INTERVAL_MS);
  reconcileTimer.unref();

  const handles: Array<TelegramHandle | DiscordHandle> = [];
  if (config.telegramToken) handles.push(await startTelegram(core, config.telegramToken));
  if (config.discordToken) handles.push(await startDiscord(core, config.discordToken));

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    core.log(`${signal} received, stopping`);
    clearInterval(reconcileTimer);
    await Promise.allSettled(handles.map((handle) => handle.stop()));
    core.store.save();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((error) => {
  console.error("[spicyapi-bot] fatal:", error instanceof Error ? error.message : error);
  process.exit(1);
});
