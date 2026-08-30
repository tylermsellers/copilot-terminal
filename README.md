# Copilot Terminal

Talk to a live GitHub Copilot CLI session from Even Realities G2 smart glasses.

This project has two parts:

- **`server/`** — a local Node relay that wraps `@github/copilot-sdk`. It exposes
  a small HTTP API (list/create/resume sessions, send prompts, stream events,
  transcribe voice via Azure Speech, interrupt, fetch history) for the glasses
  app to talk to.
- **`app/`** — an Even Hub G2 glasses app (Vite + TypeScript, built on
  `@evenrealities/even_hub_sdk`) with a terminal-style UI: a session picker,
  a bordered scrolling transcript + status footer, permission/question
  prompts, and a voice-compose flow (record → transcribe → confirm → send).

## Important: this is a self-pack app, not a single shared Even Hub download

The relay server runs **locally on your own machine**, reachable only on
your LAN, at an address that's different for everyone. Even Hub's `app.json`
network permission whitelist only accepts exact origins — no wildcards, no
bare hostnames (confirmed in
[Even's own networking docs](https://hub.evenrealities.com/docs/build/networking)).
That means there is no single `.ehpk` that can work out of the box for every
user: whoever's LAN IP got baked into the whitelist at build time is the only
person it will ever work for.

So instead of a single public Even Hub store listing, **everyone builds and
packs their own copy** with their own address baked in, then sideloads it as
a Private Build. It's still the same open-source app — just a per-user build
step instead of a one-click install. See "Packaging your own build" below.

Want to reach your relay from outside your LAN (e.g. while traveling)? Fork
the repo and point it at a [Tailscale](https://tailscale.com/) address, a
Cloudflare Tunnel, or similar — anything that gives you one stable address to
whitelist works the same way.

## Running locally

```powershell
# 1. Configure a speech-to-text provider (one-time, interactive)
cd server
npm install
npm run setup   # choose Azure Speech, OpenAI Whisper, or Google Gemini, paste your key
node src/index.js

# 2. Start the glasses app dev server
cd ../app
npm install
npm run dev
```

`npm run setup` writes your key(s) to `server/.env`, which is gitignored and
never leaves this machine. You can re-run it any time to switch providers or
update a key. Prefer doing it by hand? Copy `server/.env.example` to
`server/.env` and fill in one provider's block yourself, or set the same
variables directly in your shell environment — either works, since the
server loads `.env` automatically on startup.

### Speech-to-text providers

Only one is required. If `STT_PROVIDER` isn't set explicitly, the relay
auto-detects the first one with credentials present, in this order:

| Provider | Env vars | Get a key |
|---|---|---|
| Azure Speech | `AZURE_SPEECH_KEY`, `AZURE_SPEECH_REGION` | [portal.azure.com](https://portal.azure.com) → create a Speech resource → Keys and Endpoint |
| OpenAI Whisper | `OPENAI_API_KEY` | [platform.openai.com/api-keys](https://platform.openai.com/api-keys) |
| Google Gemini | `GEMINI_API_KEY` | [aistudio.google.com/apikey](https://aistudio.google.com/apikey) — has a free tier |

Anthropic isn't offered here — Claude's API doesn't currently accept audio
input, so it can't do speech-to-text.

```powershell
# 3. Preview in the Even Hub simulator
npx evenhub-simulator http://localhost:5173

# 4. Or sideload onto real G2 hardware (same Wi-Fi network)
npx evenhub qr --url http://<your-lan-ip>:5173
```

## Controls

- **Picker screen**: tap an item to select/resume it, or tap "+ New session"
  to start a new one. Double-tap exits the app (standard SDK confirm-to-exit
  flow).
- **Chat screen**: tap the footer to start/stop voice recording. Double-tap
  returns to the session picker.

## First-time setup on the glasses

The first time you launch the app to your glasses, before any relay URL has
been saved, it shows **"Setup required: Open this app from your phone menu
to connect"** instead of guessing an address. Open the app from the Even
App's own plugin menu on your phone (not by launching it to the glasses) to
complete setup — see the next section.

## Packaging your own build

Before you can pack a working `.ehpk`, tell it which relay address to trust:

```powershell
cd app
npm run configure   # auto-detects your LAN IP, lets you confirm the port
```

This rewrites `app.json`'s `network` permission whitelist to your own
`http://<your-lan-ip>:<port>` — it only affects your local copy of the repo,
nothing is shared. Then build and pack as usual:

```powershell
npm run build
npx evenhub pack app.json dist -o copilot-terminal.ehpk
```

Sideload the resulting `.ehpk` as a **Private Build** from the Even App
(Even Hub → your account → Private Builds → upload), rather than publishing
it to the public store — see Even's
[Private Testing docs](https://hub.evenrealities.com/docs/test/private-testing).

Bump `app.json`'s `"version"` before every rebuild/repack you plan to
distribute (even to yourself) so you can tell builds apart later.

## Configuring the relay connection (phone-side app)

Opening this app from the **Even App's own plugin menu on your phone**
(rather than launching it to the glasses) is a first-class client, not just
a settings form: you get a session list, can start a new session or open an
existing one, and converse with Copilot using your phone's own keyboard —
including typing free-text answers to permission/question prompts, which
the glasses can only do by voice.

The first time it's opened with no relay configured yet, it goes straight to
**Settings** to get you connected. After that, Settings lives behind the
gear icon (⚙︎) in the top-right of the session list — enter the relay
server's URL and (optional) auth token, tap **Test connection** to confirm
it's reachable, then **Save**. The glasses UI picks up the saved value on
its next launch too, via the SDK's persistent `setLocalStorage`.

Note: the relay's address must also be included in this app's `network`
permission whitelist (`app.json`, set via `npm run configure` above) — that's
a build-time allowlist enforced by the Even App itself, separate from what's
saved in settings. If your relay's address moves to a different network, the
app needs to be reconfigured, rebuilt, and repacked with the new address
whitelisted.

