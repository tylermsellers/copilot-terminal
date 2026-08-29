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

## Configuring the relay connection (phone-side settings)

The G2/R1 touchpad has no keyboard, so there's no way to type a relay URL or
auth token from the glasses themselves. Instead, opening this app from the
**Even App's own plugin menu on your phone** (rather than launching it to the
glasses) shows a normal HTML settings screen — enter the relay server's URL
and (optional) auth token there, tap **Test connection** to confirm it's
reachable, then **Save**. The glasses UI picks up the saved value on its next
launch, via the SDK's persistent `setLocalStorage`.

Note: the relay's address must also be included in this app's `network`
permission whitelist (`app.json`) — that's a build-time allowlist enforced by
the Even App itself, separate from what's saved in settings. If your relay's
address moves to a different network, the app needs to be repacked with the
new address whitelisted.

