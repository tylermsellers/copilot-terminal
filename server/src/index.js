import "dotenv/config";
import express from "express";
import cors from "cors";
import { bridge } from "./copilotSession.js";
import { getMessages } from "./store.js";
import { transcribePcm, activeProviderName, anyProviderConfigured } from "./transcribe.js";

const app = express();
app.use(cors()); // LAN-only tool; wildcard is fine for now
app.use(express.json());

const PORT = process.env.PORT ? Number(process.env.PORT) : 4756;
const TOKEN = process.env.RELAY_TOKEN || null;

// Simple shared-secret auth (same pattern as the earlier g2-imessage relay).
// Set RELAY_TOKEN env var to require it; omit for local-dev convenience.
app.use((req, res, next) => {
  if (!TOKEN) return next();
  const supplied = req.header("x-relay-token") || req.query.token;
  if (supplied !== TOKEN) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
});

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, started: bridge.started });
});

app.get("/api/info", async (_req, res) => {
  try {
    res.json(await bridge.getInfo());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/sessions", async (req, res) => {
  try {
    const limit = Number(req.query.limit) || 10;
    const all = req.query.scope === "all";
    res.json({ sessions: await bridge.listSessions(limit, { all }) });
  } catch (err) {
    res.json({ sessions: [], error: err.message });
  }
});

// GET /api/sessions/:id/history — peek at recent turns before deciding to continue a session
app.get("/api/sessions/:id/history", async (req, res) => {
  try {
    const limit = Number(req.query.limit) || 6;
    const history = await bridge.getSessionHistory(req.params.id, limit);
    res.json({ history });
  } catch (err) {
    res.status(500).json({ history: [], error: err.message });
  }
});

// POST /api/prompt { text, sessionId?, cwd? } -> { sessionId }
app.post("/api/prompt", async (req, res) => {
  const { text, sessionId, cwd } = req.body ?? {};
  if (!text || typeof text !== "string") {
    res.status(400).json({ error: "Missing 'text' field" });
    return;
  }
  try {
    const result = await bridge.prompt(sessionId, text, cwd);
    res.status(202).json({ ok: true, sessionId: result.sessionId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/messages", (req, res) => {
  const sessionId = req.query.sessionId;
  const after = parseInt(req.query.after, 10) || 0;
  if (!sessionId) {
    res.status(400).json({ error: "Missing 'sessionId'" });
    return;
  }
  bridge.touch(sessionId); // an actively-polled (open) chat screen counts as activity, not just sends
  res.json({
    messages: getMessages(sessionId, after),
    state: bridge.getState(sessionId),
    sessionId,
  });
});

app.get("/api/status", (req, res) => {
  const sessionId = req.query.sessionId;
  if (!sessionId) {
    res.status(400).json({ error: "Missing 'sessionId'" });
    return;
  }
  res.json({ sessionId, state: bridge.getState(sessionId) });
});

app.post("/api/permission-response", (req, res) => {
  const { sessionId, requestId, decision } = req.body ?? {};
  if (!sessionId || !requestId) {
    res.status(400).json({ error: "Missing 'sessionId' or 'requestId'" });
    return;
  }
  const ok = bridge.respondPermission(sessionId, requestId, decision || "deny");
  res.json({ ok });
});

app.post("/api/question-response", (req, res) => {
  const { sessionId, requestId, answer } = req.body ?? {};
  if (!sessionId || !requestId) {
    res.status(400).json({ error: "Missing 'sessionId' or 'requestId'" });
    return;
  }
  const ok = bridge.respondQuestion(sessionId, requestId, answer || "");
  res.json({ ok });
});

app.post("/api/interrupt", (req, res) => {
  const { sessionId } = req.body ?? {};
  if (!sessionId) {
    res.status(400).json({ error: "Missing 'sessionId'" });
    return;
  }
  res.json({ ok: bridge.interrupt(sessionId) });
});

// POST /api/sessions/:id/release — let go of our live connection to a
// session now (called when the phone/glasses navigates back to the session
// list) instead of waiting out the idle timeout. Best-effort; never yanks a
// session that's currently mid-turn.
app.post("/api/sessions/:id/release", async (req, res) => {
  try {
    res.json({ ok: await bridge.release(req.params.id) });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/transcribe?sampleRate=16000 — body is raw PCM16 mono bytes (or WAV if ?format=wav).
// `type: () => true` always parses the body as a raw Buffer regardless of
// (or missing) Content-Type -- some clients (e.g. fetch() with a
// Uint8Array/ArrayBuffer body) don't set one, and express.raw()'s default
// type matcher would then silently skip parsing, leaving req.body empty and
// producing a false "Missing audio body" error even though real bytes were
// sent over the wire.
app.post("/api/transcribe", express.raw({ type: () => true, limit: "10mb" }), async (req, res) => {
  if (!req.body || !req.body.length) {
    res.status(400).json({ error: "Missing audio body" });
    return;
  }
  try {
    const sampleRate = Number(req.query.sampleRate) || 16000;
    const alreadyWav = req.query.format === "wav";
    const text = await transcribePcm(req.body, { sampleRate, alreadyWav });
    res.json({ text });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`copilot-glasses-relay listening on http://0.0.0.0:${PORT} (LAN only)`);
  if (TOKEN) console.log("Auth: RELAY_TOKEN required via x-relay-token header or ?token=");
  else console.log("Auth: DISABLED (no RELAY_TOKEN set) — fine for local dev only");
  if (!anyProviderConfigured()) {
    console.warn(
      "No speech-to-text provider is configured — voice transcription will fail.\n" +
      "Run `npm run setup` in server/ to enter a key (Azure Speech, OpenAI, or Gemini),\n" +
      "saved to server/.env (gitignored), or set the matching env vars yourself."
    );
  } else {
    console.log(`Speech-to-text provider: ${activeProviderName()}`);
  }
});
