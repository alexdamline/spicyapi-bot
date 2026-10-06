import type { BotConfig } from "../config.js";
import { formatUsd } from "./money.js";

export interface CommandInfo {
  name: string;
  /** Shown in the Telegram command menu and Discord's command picker (max 100 characters). */
  description: string;
}

/**
 * Command names are deliberately not /image, /video, /chat, /model or /balance: several popular
 * bots use those, and in a group with more than one bot they would all answer.
 */
export const COMMANDS = {
  pic: { name: "pic", description: "Generate an image from a prompt" },
  vid: { name: "vid", description: "Generate a video from a prompt" },
  animate: { name: "animate", description: "Turn an image into a video (reply to an image)" },
  talk: { name: "talk", description: "Talk to the current character" },
  persona: { name: "persona", description: "Choose which character you talk to" },
  newchat: { name: "newchat", description: "Forget this conversation and start fresh" },
  models: { name: "models", description: "Choose the image, video and chat models" },
  spend: { name: "spend", description: "What you have spent today" },
  report: { name: "report", description: "Report a problem or abusive content to the operator" },
  help: { name: "help", description: "How this bot works" },
} as const satisfies Record<string, CommandInfo>;

export const RULES_TEXT = [
  "Before you start:",
  "• You must be 18 or older.",
  "• Never create anything involving minors, including fictional or drawn characters who look young.",
  "• Never create sexual or intimate content of a real, identifiable person, and never impersonate someone.",
  "• Only upload images you have the rights to, of adults who agreed to it.",
  "What you create is your responsibility. Rules: https://spicyapi.ai/legal/content-policy · Report abuse: https://spicyapi.ai/abuse",
].join("\n");

export function helpText(config: BotConfig, platform: "telegram" | "discord", names: { image: string; video: string; animate: string; chat: string; character: string }): string {
  const slash = "/";
  const lines = [
    "SpicyAPI bot: images, videos and character chat, paid from the operator's SpicyAPI balance.",
    "",
    `${slash}pic <prompt> — image (${names.image})`,
    `${slash}vid <prompt> — video (${names.video})`,
    platform === "telegram"
      ? `${slash}animate <motion> — reply to an image to turn it into a video (${names.animate}). Or tap "Animate" under any image the bot made.`
      : `Tap "Animate" under any image the bot made to turn it into a video (${names.animate}).` +
        (config.allowPhotoUploads ? ` Or use ${slash}animate with your own image.` : ""),
    `${slash}talk <message> — talk to ${names.character}` + (platform === "telegram" && config.privateChat ? " (in a private chat, just type)" : ""),
    `${slash}persona — choose a character · ${slash}newchat — start the conversation over`,
    `${slash}models — choose models · ${slash}spend — what you have spent today`,
    `${slash}report <text> — tell the operator about a problem or abusive content`,
    "",
    "Money:",
    `• Every image and video is priced before it runs. Above ${formatUsd(config.spend.confirmAbove)} you are asked to confirm; above ${formatUsd(config.spend.maxPerRequest)} it is refused.`,
    `• Daily limit: ${formatUsd(config.limits.userDaily)} per person, ${formatUsd(config.limits.globalDaily)} for the whole bot (reset 00:00 UTC).`,
    "• A started generation cannot be cancelled. Failed generations are not charged.",
  ];
  if (!config.allowPhotoUploads) lines.push("• Animating your own uploaded photos is turned off on this bot.");
  return lines.join("\n");
}
