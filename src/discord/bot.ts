import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  Partials,
  type AutocompleteInteraction,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Interaction,
  type Message,
  type RepliableInteraction,
} from "discord.js";
import { decideAccess, userKey, type ChatContext } from "../core/access.js";
import type { BotCore, Caller } from "../core/bot-core.js";
import { KIND_LABEL, priceLabel } from "../core/catalog.js";
import { formatMb, resultFileName } from "../core/download.js";
import { CALLBACK, resolvePending, runChat, splitMessage, startMedia, type Button, type ChatSurface, type MediaSurface } from "../core/flows.js";
import { RULES_TEXT, helpText } from "../core/help.js";
import { idempotencyKey } from "../core/idempotency.js";
import { describeError } from "../core/messages.js";
import type { MediaKind, ModelKind } from "../core/store.js";
import { commandDefinitions } from "./commands.js";
import { channelInfo, mediaAllowed, mediaRefusal, type ChannelShape } from "./nsfw.js";

const TEXT_LIMIT = 2000;
/** Interaction tokens last 15 minutes; after that, results go out as ordinary channel messages. */
const TOKEN_LIFETIME_MS = 14 * 60_000;
const MODEL_KINDS: ModelKind[] = ["image", "video", "animate", "chat"];

export interface DiscordHandle {
  stop(): Promise<void>;
}

export async function startDiscord(core: BotCore, token: string): Promise<DiscordHandle> {
  const config = core.config;
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.DirectMessages],
    // DMs arrive as partial channels.
    partials: [Partials.Channel],
  });

  // ---- access ---------------------------------------------------------------------------------

  function chatContext(guildId: string | null, channel: { id: string; parentId?: string | null } | null): ChatContext {
    if (!guildId) return { kind: "private" };
    const ids = [guildId];
    if (channel) ids.unshift(channel.id);
    if (channel?.parentId) ids.splice(1, 0, channel.parentId);
    return { kind: "group", ids };
  }

  type Gate = { caller: Caller } | { refusal: string; consent?: boolean };

  function gate(user: { id: string; bot: boolean; displayName?: string; username: string }, guildId: string | null, channel: (ChannelShape & { id: string; parentId?: string | null }) | null, need: { media?: boolean; nsfwChat?: boolean; consent?: boolean }): Gate {
    if (user.bot) return { refusal: "" };
    const decision = decideAccess(config.access, { platform: "discord", userId: user.id, chat: chatContext(guildId, channel) });
    if (!decision.allowed) {
      return {
        refusal:
          decision.reason === "user_not_allowed"
            ? `This is a private bot. If you know its operator, send them your Discord user ID: ${user.id}`
            : "This bot is not enabled in this channel. The operator can add the channel or server ID to ALLOWED_CHAT_IDS.",
      };
    }
    if (need.media || need.nsfwChat) {
      const verdict = mediaAllowed(channelInfo(channel), { allowInDms: need.media ? config.discordMediaInDms : true });
      if (!verdict.ok) {
        return { refusal: need.media ? mediaRefusal(verdict.reason) : "Chat on this bot is only available in age-restricted channels." };
      }
    }
    const caller: Caller = { user: userKey("discord", user.id), owner: decision.owner, name: user.displayName || user.username };
    if (need.consent !== false && core.needsConsent(caller.user)) return { refusal: RULES_TEXT, consent: true };
    return { caller };
  }

  function consentRow(): ActionRowBuilder<ButtonBuilder> {
    return new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId("consent").setLabel("I am 18+ and agree").setStyle(ButtonStyle.Primary));
  }

  async function admitInteraction(interaction: RepliableInteraction, need: { media?: boolean; nsfwChat?: boolean; consent?: boolean }): Promise<Caller | undefined> {
    const result = gate(interaction.user, interaction.guildId, interaction.channel as never, need);
    if ("caller" in result) return result.caller;
    if (!result.refusal) return undefined;
    await interaction.reply({
      content: result.refusal,
      flags: MessageFlags.Ephemeral,
      ...(result.consent ? { components: [consentRow()] } : {}),
    });
    return undefined;
  }

  function rowsOf(buttons: Button[] | undefined): ActionRowBuilder<ButtonBuilder>[] {
    if (!buttons || buttons.length === 0) return [];
    const row = new ActionRowBuilder<ButtonBuilder>();
    for (const button of buttons) {
      row.addComponents(
        new ButtonBuilder()
          .setCustomId(button.id)
          .setLabel(button.label)
          .setStyle(button.style === "primary" ? ButtonStyle.Primary : button.style === "danger" ? ButtonStyle.Danger : ButtonStyle.Secondary),
      );
    }
    return [row];
  }

  function spoilerName(name: string, inGuild: boolean): string {
    const hidden = config.spoilerMedia === "always" || (config.spoilerMedia === "groups" && inGuild);
    return hidden ? `SPOILER_${name}` : name;
  }

  function detach(work: Promise<unknown>): void {
    work.catch((error) => core.log(`discord handler failed: ${error instanceof Error ? error.message : String(error)}`));
  }

  // ---- media surface --------------------------------------------------------------------------

  /** Status and results on an interaction's reply; falls back to channel messages once the token has expired. */
  function mediaSurface(interaction: RepliableInteraction): MediaSurface {
    const startedAt = Date.now();
    const expired = () => Date.now() - startedAt > TOKEN_LIFETIME_MS;
    let delivered = 0;
    return {
      progressIntervalMs: Math.max(config.progressIntervalMs, 5000),
      async status(text, buttons) {
        if (expired()) return;
        await interaction.editReply({ content: text, components: rowsOf(buttons), files: [] });
      },
      async deliver(asset, caption, buttons) {
        const limit = interaction.attachmentSizeLimit || 10 * 1024 * 1024;
        const content = expired() ? `<@${interaction.user.id}> ${caption}` : caption;
        const components = rowsOf(buttons);
        const tooBig = asset.bytes !== undefined && asset.bytes > limit;
        const send = async (payload: { content: string; files?: AttachmentBuilder[]; components: ActionRowBuilder<ButtonBuilder>[] }) => {
          if (expired()) {
            const channel = interaction.channel;
            if (channel && "send" in channel) await channel.send(payload);
          } else if (delivered === 0) await interaction.editReply(payload);
          else await interaction.followUp(payload);
          delivered += 1;
        };
        if (!tooBig) {
          try {
            // discord.js downloads the signed link and uploads it as an attachment.
            const file = new AttachmentBuilder(asset.url!, { name: spoilerName(resultFileName(asset.mime, "result"), interaction.inGuild()) });
            await send({ content, files: [file], components });
            return;
          } catch (error) {
            core.log(`discord attachment failed: ${error instanceof Error ? error.message : "error"}`);
          }
        }
        const size = asset.bytes ? ` (${formatMb(asset.bytes)})` : "";
        await send({ content: `${content}\nThe file is too large to attach here${size}. Download it within about 20 minutes: ${asset.url}`, components });
      },
      async done() {},
    };
  }

  async function media(interaction: RepliableInteraction, caller: Caller, kind: MediaKind, prompt: string, key: string, imageUrl?: string): Promise<void> {
    await interaction.deferReply();
    detach(startMedia(core, caller, kind, prompt, key, mediaSurface(interaction), imageUrl));
  }

  // ---- chat -----------------------------------------------------------------------------------

  async function chatOnInteraction(interaction: ChatInputCommandInteraction, caller: Caller, text: string): Promise<void> {
    await interaction.deferReply();
    const key = `dc:${interaction.channelId}:${interaction.user.id}`;
    const character = core.characterFor(caller.user);
    const greeting = character.greeting && core.conversations.isNew(key, character.id) ? `*${character.name}:* ${core.greetingFor(character, caller.name)}\n\n` : "";
    const surface: ChatSurface = {
      intervalMs: 1500,
      async show(value) {
        await interaction.editReply({ content: clip(`${greeting}${value}`) });
      },
      async finish(value) {
        const [first, ...rest] = splitMessage(`${greeting}${value}`, TEXT_LIMIT);
        await interaction.editReply({ content: first! });
        for (const part of rest) await interaction.followUp({ content: part });
      },
    };
    detach(runChat(core, caller, key, text, idempotencyKey(["dc", interaction.applicationId, interaction.id, "chat"]), surface, TEXT_LIMIT - 10 - greeting.length));
  }

  async function chatOnMessage(message: Message, caller: Caller, text: string): Promise<void> {
    const key = `dc:${message.channelId}:${message.author.id}`;
    const character = core.characterFor(caller.user);
    if (character.greeting && core.conversations.isNew(key, character.id) && message.channel.isSendable()) {
      await message.channel.send(core.greetingFor(character, caller.name).slice(0, TEXT_LIMIT));
    }
    let replyMessage: Message | undefined;
    const surface: ChatSurface = {
      intervalMs: 1500,
      typing: () => {
        if (message.channel.isSendable()) message.channel.sendTyping().catch(() => {});
      },
      async show(value) {
        if (!replyMessage) replyMessage = await message.reply({ content: clip(value), allowedMentions: { repliedUser: false } });
        else await replyMessage.edit({ content: clip(value) });
      },
      async finish(value) {
        const [first, ...rest] = splitMessage(value, TEXT_LIMIT);
        await this.show(first!);
        for (const part of rest) if (message.channel.isSendable()) await message.channel.send(part);
      },
    };
    detach(runChat(core, caller, key, text, idempotencyKey(["dc", client.user!.id, message.id, "chat"]), surface, TEXT_LIMIT - 10));
  }

  // ---- slash commands -------------------------------------------------------------------------

  async function onCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const name = interaction.commandName;
    const key = (action: string) => idempotencyKey(["dc", interaction.applicationId, interaction.id, action]);

    if (name === "pic" || name === "vid") {
      const caller = await admitInteraction(interaction, { media: true });
      if (!caller) return;
      const kind: MediaKind = name === "pic" ? "image" : "video";
      await media(interaction, caller, kind, interaction.options.getString("prompt", true), key(kind));
      return;
    }

    if (name === "animate") {
      const caller = await admitInteraction(interaction, { media: true });
      if (!caller) return;
      if (!config.allowPhotoUploads) {
        await interaction.reply({ content: "Animating uploaded images is turned off on this bot.", flags: MessageFlags.Ephemeral });
        return;
      }
      const attachment = interaction.options.getAttachment("image", true);
      if (!attachment.contentType || !["image/jpeg", "image/png", "image/webp"].includes(attachment.contentType.split(";")[0]!)) {
        await interaction.reply({ content: "Attach a JPEG, PNG or WebP image.", flags: MessageFlags.Ephemeral });
        return;
      }
      if (attachment.size > 10 * 1024 * 1024) {
        await interaction.reply({ content: "That image is larger than 10 MB.", flags: MessageFlags.Ephemeral });
        return;
      }
      await interaction.deferReply();
      try {
        // Discord attachment links are signed and expire; upload the bytes to SpicyAPI instead of passing the link on.
        const response = await fetch(attachment.url);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const uri = await core.uploadImage(new Uint8Array(await response.arrayBuffer()), attachment.contentType.split(";")[0]!);
        const prompt = core.motionPrompt(interaction.options.getString("motion") ?? undefined, undefined);
        detach(startMedia(core, caller, "animate", prompt, key("animate"), mediaSurface(interaction), uri));
      } catch (error) {
        await interaction.editReply({ content: describeError(error) });
      }
      return;
    }

    if (name === "talk") {
      const caller = await admitInteraction(interaction, { nsfwChat: config.discordChatRequiresNsfw });
      if (!caller) return;
      await chatOnInteraction(interaction, caller, interaction.options.getString("message", true));
      return;
    }

    const caller = await admitInteraction(interaction, { consent: false });
    if (!caller) return;
    const ephemeral = (content: string) => interaction.reply({ content: clip(content), flags: MessageFlags.Ephemeral });

    switch (name) {
      case "help": {
        const label = (kind: ModelKind) => core.catalog.displayName(core.modelFor(caller.user, kind));
        await Promise.all(MODEL_KINDS.map((kind) => core.catalog.list(kind).catch(() => [])));
        await ephemeral(
          helpText(config, "discord", {
            image: label("image"),
            video: label("video"),
            animate: label("animate"),
            chat: label("chat"),
            character: core.characterFor(caller.user).name,
          }) + "\n\nImages and videos work in age-restricted channels only.",
        );
        return;
      }
      case "spend":
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        await interaction.editReply({ content: await core.spendText(caller) });
        return;
      case "newchat":
        core.conversations.reset(`dc:${interaction.channelId}:${interaction.user.id}`);
        await ephemeral(`Started over with ${core.characterFor(caller.user).name}.`);
        return;
      case "persona": {
        const character = core.setCharacter(caller.user, interaction.options.getString("character", true));
        await ephemeral(character ? `Now talking to ${character.name}.` : "No character with that name. Pick one from the list.");
        return;
      }
      case "models": {
        const kind = interaction.options.getString("kind") as ModelKind | null;
        const model = interaction.options.getString("model");
        if (!kind || !model) {
          await interaction.deferReply({ flags: MessageFlags.Ephemeral });
          await Promise.all(MODEL_KINDS.map((item) => core.catalog.list(item).catch(() => [])));
          const lines = MODEL_KINDS.map((item) => `• ${KIND_LABEL[item]}: ${core.catalog.displayName(core.modelFor(caller.user, item))}`);
          await interaction.editReply({ content: `Your models:\n${lines.join("\n")}\n\nChange one with /models kind:<kind> model:<name>.` });
          return;
        }
        const available = await core.catalog.list(kind);
        const chosen = available.find((item) => item.model === model);
        if (!chosen) return void (await ephemeral("That model is not available for this. Start typing and pick one from the list."));
        core.setModel(caller.user, kind, chosen.model);
        await ephemeral(`${KIND_LABEL[kind]} model set to ${chosen.displayName} (${priceLabel(chosen)}).`);
        return;
      }
      case "report": {
        const text = interaction.options.getString("text", true);
        let delivered = 0;
        for (const id of config.access.owners.ids) {
          const [platform, ownerId] = id.split(":");
          if (platform !== "discord" && platform !== "*") continue;
          try {
            const owner = await client.users.fetch(ownerId!);
            await owner.send(clip(`Report from <@${interaction.user.id}> (${interaction.user.id}) in ${interaction.guildId ? `<#${interaction.channelId}>` : "a DM"}:\n${text}`));
            delivered += 1;
          } catch {
            // The owner may not share a server with the bot or may have DMs closed.
          }
        }
        await ephemeral(
          `${delivered > 0 ? "Sent to the operator." : "Could not reach the operator."} Content that breaks SpicyAPI's rules can also be reported at https://spicyapi.ai/abuse`,
        );
        return;
      }
    }
  }

  async function onAutocomplete(interaction: AutocompleteInteraction): Promise<void> {
    const focused = interaction.options.getFocused(true);
    const typed = String(focused.value).toLowerCase();
    if (interaction.commandName === "persona") {
      const options = core.characters.filter((item) => item.name.toLowerCase().includes(typed)).slice(0, 25);
      await interaction.respond(options.map((item) => ({ name: item.name.slice(0, 100), value: item.id })));
      return;
    }
    if (interaction.commandName === "models") {
      const kind = (interaction.options.getString("kind") ?? "image") as ModelKind;
      const models = MODEL_KINDS.includes(kind) ? await core.catalog.list(kind).catch(() => []) : [];
      const matches = models.filter((item) => item.displayName.toLowerCase().includes(typed) || item.model.includes(typed)).slice(0, 25);
      await interaction.respond(
        matches.map((item) => {
          const price = priceLabel(item);
          return { name: `${item.displayName}${price ? ` · ${price}` : ""}`.slice(0, 100), value: item.model };
        }),
      );
    }
  }

  // ---- buttons --------------------------------------------------------------------------------

  async function onButton(interaction: ButtonInteraction): Promise<void> {
    const data = interaction.customId;
    if (data === "consent") {
      const caller = await admitInteraction(interaction, { consent: false });
      if (!caller) return;
      core.giveConsent(caller.user);
      await interaction.update({ content: `${RULES_TEXT}\n\nAccepted. Run your command again.`, components: [] });
      return;
    }
    if (data.startsWith(CALLBACK.confirm) || data.startsWith(CALLBACK.cancel)) {
      const caller = await admitInteraction(interaction, { media: true });
      if (!caller) return;
      await interaction.deferUpdate();
      // resolvePending checks that the person tapping is the person who asked.
      const notice = await resolvePending(core, data, caller.user, mediaSurface(interaction));
      if (notice) await interaction.followUp({ content: notice, flags: MessageFlags.Ephemeral });
      return;
    }
    if (data.startsWith(CALLBACK.animate)) {
      const caller = await admitInteraction(interaction, { media: true });
      if (!caller) return;
      await interaction.deferReply();
      try {
        const source = await core.imageFromTask(data.slice(CALLBACK.animate.length));
        const key = idempotencyKey(["dc", interaction.applicationId, interaction.message.id, "animate", interaction.user.id]);
        detach(startMedia(core, caller, "animate", core.motionPrompt(undefined, source.prompt), key, mediaSurface(interaction), source.url));
      } catch (error) {
        await interaction.editReply({ content: describeError(error) });
      }
    }
  }

  // ---- events ---------------------------------------------------------------------------------

  client.on(Events.InteractionCreate, (interaction: Interaction) => {
    const work = interaction.isChatInputCommand()
      ? onCommand(interaction)
      : interaction.isAutocomplete()
        ? onAutocomplete(interaction)
        : interaction.isButton()
          ? onButton(interaction)
          : Promise.resolve();
    work.catch(async (error) => {
      core.log(`discord interaction failed: ${error instanceof Error ? error.message : String(error)}`);
      if (interaction.isRepliable()) {
        const content = describeError(error);
        if (interaction.deferred || interaction.replied) await interaction.editReply({ content }).catch(() => {});
        else await interaction.reply({ content, flags: MessageFlags.Ephemeral }).catch(() => {});
      }
    });
  });

  // DMs talk to the character; in a server, mentioning the bot does.
  client.on(Events.MessageCreate, (message: Message) => {
    if (message.author.bot) return;
    const inDm = !message.guildId;
    const mentioned = !inDm && client.user !== null && message.mentions.users.has(client.user.id);
    if (!inDm && !mentioned) return;
    if (inDm && !config.privateChat) return;
    const text = message.content.replace(/<@!?\d+>/g, "").trim();
    if (!text) return;
    const result = gate(message.author, message.guildId, message.channel as never, { nsfwChat: !inDm && config.discordChatRequiresNsfw });
    if (!("caller" in result)) {
      if (!result.refusal) return;
      // Stay quiet in channels nobody enabled; explain in DMs and in enabled channels.
      if (!inDm && result.refusal.startsWith("This bot is not enabled")) return;
      detach(message.reply({ content: result.refusal, ...(result.consent ? { components: [consentRow()] } : {}), allowedMentions: { repliedUser: false } }));
      return;
    }
    detach(chatOnMessage(message, result.caller, text));
  });

  client.once(Events.ClientReady, async (ready) => {
    core.log(`Discord bot ${ready.user.tag} is running`);
    try {
      const definitions = commandDefinitions(config);
      if (config.discordGuildId) await ready.application.commands.set(definitions, config.discordGuildId);
      else await ready.application.commands.set(definitions);
      core.log(`Registered ${definitions.length} Discord commands${config.discordGuildId ? " on one server" : " globally"}`);
    } catch (error) {
      core.log(`Registering Discord commands failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  });

  await client.login(token);
  return {
    async stop() {
      await client.destroy();
    },
  };
}

function clip(text: string): string {
  return text.length > TEXT_LIMIT ? `${text.slice(0, TEXT_LIMIT - 3)}...` : text;
}
