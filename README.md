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
# 1. Start the relay (needs your Azure Speech key/region in the environment)
cd server
npm install
node src/index.js

# 2. Start the glasses app dev server
cd ../app
npm install
npm run dev

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
