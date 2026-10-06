# SpicyAPI Bot

A private Telegram (and optional Discord) bot that you run yourself. It generates images and videos,
turns images into videos, and lets you chat with characters you define, all paid from your own
[SpicyAPI](https://spicyapi.ai) balance, with spending limits that are checked before anything is
charged.

- **Images**: `/pic a lighthouse at dusk`
- **Videos**: `/vid waves rolling onto a beach at sunset`
- **Animate**: tap **Animate** under any image the bot made, or reply to it with `/animate <how it should move>`
- **Character chat**: just type in a private chat, or use `/talk`. Replies stream into one message.
- **Spend protection**: every request is priced first (free), expensive ones need a tap on Confirm,
  and per-person and whole-bot daily limits are enforced.
- **Private by default**: only you can use it until you allow other people or groups.

SpicyAPI's catalogue includes uncensored models that add no content filter of their own; the bot
works with any of them. The law and SpicyAPI's [content policy](https://spicyapi.ai/legal/content-policy)
still apply to everything you generate.

## Five-minute setup (Docker)

You need a computer or server that stays on, with [Docker](https://docs.docker.com/get-docker/) installed.

**1. Get a SpicyAPI key.** In the [SpicyAPI console](https://spicyapi.ai/console/keys), create a new API key
just for this bot. Give that key a **daily spend cap** (and, if you like, a list of allowed models).
The bot has its own limits too, but the key's cap is enforced by SpicyAPI itself, so it holds even if
the bot is misconfigured or its data is lost. New keys have no cap unless you set one.

**2. Create a Telegram bot.** Open [@BotFather](https://t.me/BotFather), send `/newbot`, pick a name
and a username, and copy the token it gives you.

**3. Configure.**

```sh
git clone https://github.com/spicyapi-ai/spicyapi-bot.git
cd spicyapi-bot
cp .env.example .env
```

Open `.env` and fill in the three required lines:

```sh
SPICY_API_KEY=sk-spicy-...
TELEGRAM_BOT_TOKEN=123456789:AA...
OWNER_ID=your-telegram-user-id
```

Don't know your Telegram user ID? Put `OWNER_ID=0` for now, finish step 4, send your bot any
message, and it will reply with your ID. Then set it and restart.

**4. Start.**

```sh
docker compose up -d --build
docker compose logs -f     # "Telegram bot @yourbot is running"
```

**5. Try it.** Open your bot in Telegram, send `/start`, accept the rules once, and send
`/pic a cozy cabin in the snow`. The default image model costs about $0.01 per image.

To update later: `git pull && docker compose up -d --build`.

## Deploy on Railway (from GitHub)

[Railway](https://railway.com) can run the bot without a server of your own.

1. Fork this repository to your GitHub account.
2. In Railway: **New Project → Deploy from GitHub repo**, and pick your fork. Railway finds the
   `Dockerfile` and builds it.
3. Open the service's **Variables** tab and add `SPICY_API_KEY`, `TELEGRAM_BOT_TOKEN` and `OWNER_ID`
   (plus any other setting from `.env.example`).
4. Right-click the service → **Attach volume**, mount path `/data`. Without a volume, every redeploy
   forgets today's spending and everyone's settings.
5. Deploy. The logs should show `Telegram bot @yourbot is running`.

Keep the service at **one replica**: two copies polling the same Telegram token fight over updates.
The bot needs no public domain and no open port.

## Discord (optional)

1. In the [Discord Developer Portal](https://discord.com/developers/applications), create an
   application, open **Bot**, reset and copy the token, and turn **Public Bot** off so only you can
   add it to servers. No privileged intents are needed.
2. Under **OAuth2 → URL Generator**, tick the scopes `bot` and `applications.commands`, and the
   permissions **Send Messages**, **Attach Files**, **Embed Links** and **Read Message History**.
   Open the generated link and add the bot to your server.
3. Set `DISCORD_TOKEN` in `.env` (and `DISCORD_GUILD_ID` with your server ID if you want the commands
   to appear instantly), add your Discord user ID to `OWNER_ID` (e.g. `OWNER_ID=tg:123,dc:456`), and
   add the channel or server ID to `ALLOWED_CHAT_IDS`.
4. Images and videos only work in **age-restricted channels**: Edit Channel → Overview →
   Age-Restricted Channel. The `/pic` and `/vid` commands are registered as age-restricted, so Discord
   only shows them there. Chat (`/talk`, or mentioning the bot) works in any allowed channel unless
   you set `DISCORD_CHAT_REQUIRES_NSFW=true`.

Discord does not allow apps with age-restricted commands in its App Directory, so keep the bot
private. To find IDs, turn on Developer Mode (User Settings → Advanced) and right-click a user,
channel or server → Copy ID.

## Commands

| Command | What it does |
|---|---|
| `/pic <prompt>` | Generate an image |
| `/vid <prompt>` | Generate a video from text |
| `/animate <motion>` | Reply to an image to turn it into a video. Images the bot made always work; your own photos only if the operator set `ALLOW_PHOTO_UPLOADS=true` |
| **Animate** button | Under every generated image: animates it, reusing its prompt |
| `/talk <message>` | Talk to the current character (in a private chat you can simply type) |
| `/persona` | Choose a character |
| `/newchat` | Forget the conversation and start over |
| `/models` | Choose your image, video, animate and chat models |
| `/spend` | What you have spent today; the owner also sees the whole bot and the account balance |
| `/report <text>` | Send a report to the operator |
| `/help` | Summary of all of this |

The names are deliberately not `/image`, `/video` or `/chat`, which other popular bots use, so the
bot can share a group with them. In a Telegram group, reply to one of the bot's chat messages to keep
talking to the character.

## How spending works

1. **Price first.** Each image or video is quoted by SpicyAPI before anything happens. Quotes are free.
2. **Hard ceiling.** If a request could cost more than `MAX_COST_PER_REQUEST_USD` (default $1), it is
   refused. Nothing is charged.
3. **Confirmation.** If it could cost more than `CONFIRM_ABOVE_USD` (default $0.10), the bot shows the
   price with **Confirm** and **Cancel** buttons. Only the person who asked can confirm.
4. **Daily limits.** Each person may spend `USER_DAILY_BUDGET_USD` (default $1) per UTC day, the whole
   bot `DAILY_BUDGET_USD` (default $5). Generations still running count as spent until they finish, so
   several requests at once cannot slip past a limit. Owners are only bound by the whole-bot limit.
5. **No double charges.** Each request carries an idempotency key derived from the chat message or
   button tap, so a duplicated Telegram update or a double tap returns the task that already exists.
6. **Results.** Progress is shown by editing one message every few seconds. The result shows the
   actual charge and the task ID, which you can look up under Logs in the SpicyAPI console.

A generation that has started **cannot be cancelled**; it finishes and is charged. **Failed
generations are not charged.** The bot's ledger lives in `DATA_DIR/state.json`; the key's spend cap in
the SpicyAPI console is the limit that can never be lost.

## Safety and privacy

- **Private by default.** Strangers who find the bot are told it is private and given their user ID
  to send you. Groups are ignored until listed in `ALLOWED_CHAT_IDS`; once listed, every member can
  use the bot. Setting `ALLOWED_USER_IDS=*` makes the bot public and lets anyone spend your balance.
- **Rules first.** Everyone confirms once that they are 18+ and will not create content involving
  minors, sexual content of real people, or impersonation (`REQUIRE_CONSENT`).
- **Spoilers.** In groups, results are hidden behind a spoiler (`SPOILER_MEDIA`).
- **Uploaded photos are off by default.** Turning photos of real people into videos is the main way
  bots like this get abused, so by default only images the bot generated can be animated. If you
  enable `ALLOW_PHOTO_UPLOADS`, uploaded images are downloaded by the bot and stored with SpicyAPI;
  Telegram file links are never passed on, because they contain your bot token.
- **What is stored.** `state.json` holds daily spend totals, each person's model and character
  choice, and who accepted the rules. Chat history is kept in memory only, forgotten on restart, after
  a day of inactivity, or with `/newchat`. Logs contain task IDs and amounts, never prompts or media.
  Set `RETENTION_SECONDS` to have SpicyAPI delete results and prompts sooner than your account default.
- **Reports.** `/report` forwards a message to the owner. Content that breaks SpicyAPI's rules can also
  be reported at [spicyapi.ai/abuse](https://spicyapi.ai/abuse).

You operate this bot and are responsible for who you let use it. SpicyAPI's
[terms](https://spicyapi.ai/legal/terms) apply, including the regions it does not serve.

## Characters

Characters live in a JSON file (`CHARACTERS_FILE`, default `characters/default.json`, which has two
example characters):

```json
{
  "characters": [
    {
      "id": "mira",
      "name": "Mira",
      "system": "You are Mira, ... Never speak or act for {{user}}.",
      "greeting": "Welcome aboard, {{user}}!",
      "model": "deepseek/v4.1-flash/chat"
    }
  ]
}
```

- `system` is the character's instructions; `greeting` (optional) is their first line; `model`
  (optional) pins a chat model for this character.
- `{{char}}` and `{{user}}` are replaced with the character's name and the person's first name.
- **Character cards**: entries can also be Character Card V2 JSON (the format most character sites
  and SillyTavern export). The description, personality, scenario, example dialogue and first
  message are used.

With Docker, mount your own file and point the setting at it (see `docker-compose.yml`):

```yaml
volumes:
  - ./my-characters.json:/app/characters/custom.json:ro
```

```sh
CHARACTERS_FILE=characters/custom.json
```

## Configuration

Every setting is an environment variable; `.env.example` explains each one. The most useful:

| Variable | Default | |
|---|---|---|
| `SPICY_API_KEY` | required | Your key (`sk-spicy-...`) |
| `TELEGRAM_BOT_TOKEN` / `DISCORD_TOKEN` | one required | Which platforms to run |
| `OWNER_ID` | required | Your user ID(s); `tg:` / `dc:` prefixes pin a platform |
| `ALLOWED_USER_IDS` | empty | Other people allowed in private chats |
| `ALLOWED_CHAT_IDS` | empty | Groups, channels or servers where the bot answers |
| `DAILY_BUDGET_USD` / `USER_DAILY_BUDGET_USD` | `5` / `1` | Daily limits (UTC) |
| `MAX_COST_PER_REQUEST_USD` / `CONFIRM_ABOVE_USD` | `1` / `0.10` | Per-request ceiling and confirmation threshold |
| `DEFAULT_IMAGE_MODEL` | `alibaba/z-image-turbo/text-to-image` | About $0.01 per image |
| `DEFAULT_VIDEO_MODEL` / `DEFAULT_ANIMATE_MODEL` | `minimax/h3/...` | About $0.025 per second at 480p |
| `DEFAULT_CHAT_MODEL` | `deepseek/v4.1-flash/chat` | Any chat model in the catalogue |
| `VIDEO_SECONDS` / `VIDEO_RESOLUTION` | `5` / `480p` | Snapped to what each model allows |
| `ALLOW_PHOTO_UPLOADS` | `false` | Animate photos people upload |
| `DATA_DIR` | `./data` (`/data` in Docker) | Where `state.json` lives |

Prices are from the public catalogue at the time of writing; the bot always shows the live quote.
Browse models at [spicyapi.ai/models](https://spicyapi.ai/models).

## Troubleshooting

| Message or symptom | What to do |
|---|---|
| "out of balance" (`40201`) | Top up your SpicyAPI balance |
| "reached the spend cap" (`40202`) | The key's cap in the console was reached; raise it or wait |
| "not allowed to use that model" (`40301`) | Allow the model on the key in the console, or pick another with `/models` |
| "has not verified its email" (`40310`) | Open the verification link from SpicyAPI |
| "The model declined this request" | That model refused the prompt; reword it or pick another model. Not charged |
| `Conflict: terminated by other getUpdates request` | Two copies of the bot use the same token. Stop one |
| Discord commands missing | `/pic` and `/vid` only show in age-restricted channels. Global commands can take a moment to appear; set `DISCORD_GUILD_ID` for instant registration |
| Network errors behind a proxy | Node's `fetch` ignores `HTTPS_PROXY` unless started with `NODE_USE_ENV_PROXY=1` |

## Development

Requires Node.js 22.13 or newer.

```sh
npm ci
npm run check        # typecheck, lint, tests
npm run dev          # build and run with .env
```

The tests use fakes for SpicyAPI and a stand-in Telegram Bot API, so they need no keys or network.
`npm run live-check` runs the core flow against the real API with `SPICY_API_KEY` (one image, one
480p image-to-video, two chat turns; about $0.12) without Telegram or Discord.

Built on [grammY](https://grammy.dev), [discord.js](https://discord.js.org), the official
[`@spicyapi/sdk`](https://www.npmjs.com/package/@spicyapi/sdk) for media and the official
[`openai`](https://www.npmjs.com/package/openai) package for chat, pointed at
`https://api.spicyapi.ai/v1`.

## License

MIT
