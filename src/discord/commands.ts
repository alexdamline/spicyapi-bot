import {
  ApplicationCommandOptionType,
  ApplicationCommandType,
  ApplicationIntegrationType,
  InteractionContextType,
  type RESTPostAPIChatInputApplicationCommandsJSONBody,
} from "discord.js";
import type { BotConfig } from "../config.js";
import { COMMANDS } from "../core/help.js";

type CommandBody = RESTPostAPIChatInputApplicationCommandsJSONBody;

/**
 * Slash command definitions. The image and video commands are age-restricted (`nsfw: true`):
 * Discord only offers them in age-restricted channels and to age-verified adults who enabled them
 * in DMs. An app with age-restricted commands cannot be listed in Discord's App Directory, so keep
 * the bot private (Developer Portal > Bot > Public Bot off).
 */
export function commandDefinitions(config: BotConfig): CommandBody[] {
  const base: Pick<CommandBody, "type" | "contexts" | "integration_types"> = {
    type: ApplicationCommandType.ChatInput,
    contexts: [InteractionContextType.Guild, InteractionContextType.BotDM],
    integration_types: [ApplicationIntegrationType.GuildInstall],
  };
  const prompt = (description: string) => ({
    type: ApplicationCommandOptionType.String as const,
    name: "prompt",
    description,
    required: true,
    max_length: 2000,
  });

  const commands: CommandBody[] = [
    { ...base, ...COMMANDS.pic, nsfw: true, options: [prompt("What to draw")] },
    { ...base, ...COMMANDS.vid, nsfw: true, options: [prompt("What should happen in the video")] },
    {
      ...base,
      ...COMMANDS.talk,
      nsfw: config.discordChatRequiresNsfw,
      options: [{ type: ApplicationCommandOptionType.String, name: "message", description: "What you say", required: true, max_length: 4000 }],
    },
    {
      ...base,
      ...COMMANDS.persona,
      options: [{ type: ApplicationCommandOptionType.String, name: "character", description: "Who to talk to", required: true, autocomplete: true }],
    },
    { ...base, ...COMMANDS.newchat },
    {
      ...base,
      ...COMMANDS.models,
      options: [
        {
          type: ApplicationCommandOptionType.String,
          name: "kind",
          description: "Which model to change",
          required: false,
          choices: [
            { name: "Image", value: "image" },
            { name: "Video", value: "video" },
            { name: "Animate (image to video)", value: "animate" },
            { name: "Chat", value: "chat" },
          ],
        },
        { type: ApplicationCommandOptionType.String, name: "model", description: "Start typing a model name", required: false, autocomplete: true },
      ],
    },
    { ...base, ...COMMANDS.spend },
    {
      ...base,
      ...COMMANDS.report,
      options: [{ type: ApplicationCommandOptionType.String, name: "text", description: "What happened (include the task ID if you have it)", required: true, max_length: 1500 }],
    },
    { ...base, ...COMMANDS.help },
  ];

  if (config.allowPhotoUploads) {
    commands.splice(2, 0, {
      ...base,
      ...COMMANDS.animate,
      description: "Turn your own image into a video",
      nsfw: true,
      options: [
        { type: ApplicationCommandOptionType.Attachment, name: "image", description: "A JPEG, PNG or WebP image (max 10 MB)", required: true },
        { type: ApplicationCommandOptionType.String, name: "motion", description: "How it should move", required: false, max_length: 2000 },
      ],
    });
  }
  return commands;
}
