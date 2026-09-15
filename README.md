# Copilot Terminal

Talk to a live GitHub Copilot CLI session from Even Realities G2 smart
glasses (or the R1 ring), using the Even App's own built-in **Terminal
Mode** feature.

`server/src/evenTerminal/` is a small local Node adapter that implements
Terminal Mode's wire protocol (an `/api/*` HTTP + SSE contract) on top of
[`@github/copilot-sdk`](https://www.npmjs.com/package/@github/copilot-sdk).
It presents itself as provider `"claude"` cosmetically — Even's Terminal
Mode UI only renders a few known provider names — but every session
underneath is a real GitHub Copilot CLI session.

Because it speaks Even's own official protocol, there's no custom glasses
app to build, no `.ehpk` packaging, and no version-bump-and-resideload cycle:
you just point the Even App's Terminal Mode at your adapter's address, and
you get Even's polished native UI plus R1 ring input for free.

## Running it

```powershell
cd server
npm install
copy .env.example .env   # then set TERMINAL_TOKEN to any fixed random string
npm run start:terminal
```

This prints a pairing URL (`http://<lan-ip>:<port>?token=...`) — scan/enter
it in the Even App under **Terminal Mode**. Keep `TERMINAL_PORT` and
`TERMINAL_TOKEN` fixed in `.env` so your saved pairing survives restarts (a
random token is generated instead if you leave it blank).

## Running it in the background, at logon

`server/src/evenTerminal/register-tasks.ps1` registers two Windows
Scheduled Tasks — no admin elevation required — that start automatically
when you log in, with no visible console window:

```powershell
cd server/src/evenTerminal
./register-tasks.ps1
```

- **`CopilotGlassesEvenTerminal`** — runs the adapter itself (via
  `start-hidden.vbs` → `run.bat`, output logged to `adapter.log`).
- **`CopilotGlassesEvenTerminalTray`** — a system tray icon (glasses shape,
  green/red for reachable/unreachable) with a right-click menu to
  Start/Stop/Restart the adapter and open its log file.

All paths in these scripts resolve relative to their own location, so the
same script works unmodified after `git clone` on a different machine —
just re-run `register-tasks.ps1` there.

Notes:
- The task trigger is "at logon," not raw power-on — after a reboot the
  adapter won't start until you actually sign in to Windows (unless you
  configure auto-login).
- It won't run while the PC is asleep — consider enabling Wake-on-LAN if you
  need the adapter reachable while away from the machine.
- If your LAN IP changes, the pairing URL changes too — a router DHCP
  reservation (or static IP) keeps it stable.

## Known limitations

- Terminal Mode's input is R1-ring/voice only (via Even's own
  speech-to-text) — there's no typed free-text entry for answering
  permission/question prompts from the glasses themselves.
- The full approve/deny prompt flow is untested on real G2/R1 hardware
  end-to-end; only the HTTP/SSE contract has been verified directly.

## How it's built

- `server/src/copilotSession.js` — a `Bridge` class wrapping
  `@github/copilot-sdk`: creates/resumes sessions, tracks messages, emits
  events, exposes `onMessage()` for listeners.
- `server/src/registry.js`, `server/src/store.js` — lightweight local
  session bookkeeping used by the Bridge.
- `server/src/evenTerminal/provider.js` — implements the `EvenProvider`
  interface on top of the Bridge.
- `server/src/evenTerminal/translate.js` — maps Bridge message types to
  even-terminal's wire message shapes.
- `server/src/evenTerminal/hub.js` — per-session SSE fan-out/ring buffer.
- `server/src/evenTerminal/server.js` — the Express app implementing the
  even-terminal `/api/*` routes + SSE, with Bearer/query token auth.
- `server/src/evenTerminal/index.js` — entry point; prints the pairing URL.
