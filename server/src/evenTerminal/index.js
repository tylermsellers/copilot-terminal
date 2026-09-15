// Entry point for the even-terminal-compatible bridge: run this instead of
// (or alongside — different port) ../index.js to make the Even App's own
// built-in Terminal Mode UI drive a real Copilot CLI session, instead of
// our custom copilot-glasses-link glasses app.
//
//   npm run start:terminal
//
// Then in the Even App: Terminal Mode -> scan the printed QR/URL. Terminal
// Mode's session picker will list your Copilot sessions under the "Claude"
// label (cosmetic only — see provider.js).
import "dotenv/config";
import { randomBytes } from "node:crypto";
import os from "node:os";
import { createEvenTerminalApp } from "./server.js";

const PORT = process.env.TERMINAL_PORT ? Number(process.env.TERMINAL_PORT) : 3456;
const TOKEN = process.env.TERMINAL_TOKEN || randomBytes(16).toString("hex");

function detectLanIp() {
  const nets = os.networkInterfaces();
  for (const ifaceList of Object.values(nets)) {
    for (const net of ifaceList ?? []) {
      if (net.family === "IPv4" && !net.internal) return net.address;
    }
  }
  return "127.0.0.1";
}

const app = createEvenTerminalApp({ token: TOKEN });

app.listen(PORT, "0.0.0.0", () => {
  const lanIp = detectLanIp();
  const url = `http://${lanIp}:${PORT}?token=${TOKEN}&defaultProvider=claude`;
  console.log(`copilot-glasses-link even-terminal adapter listening on http://0.0.0.0:${PORT}`);
  console.log(`Pair from the Even App -> Terminal Mode -> scan/enter:\n\n  ${url}\n`);
  if (!process.env.TERMINAL_TOKEN) {
    console.log("(Random token generated for this run — set TERMINAL_TOKEN in .env for a stable one across restarts.)");
  }
});
