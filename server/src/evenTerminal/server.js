// Even-terminal wire-contract HTTP server: implements the same /api routes
// + SSE stream the official Even App's built-in Terminal Mode expects from
// a real `even-terminal` instance (see WichardRiezebos/even-terminal-opencode
// src/server.ts, which reverse-engineered/vendored this contract under MIT).
// The Even app talks to this exactly as it would to Even's own CLI — no
// modification to Even's closed-source package, no Even Hub app packaging.
import express from "express";
import { MessageHub } from "./hub.js";
import { CopilotTerminalProvider } from "./provider.js";

const ACCEPTED_PROVIDER_NAMES = new Set(["claude", "claude-sync", "copilot"]);
const DECISIONS = new Set(["allow", "allowAlways", "deny"]);

export function createEvenTerminalApp({ token }) {
  const hub = new MessageHub();
  const provider = new CopilotTerminalProvider(hub);

  const app = express();
  app.use(express.json());

  app.use((req, res, next) => {
    const header = req.header("authorization");
    const provided = header?.startsWith("Bearer ") ? header.slice(7) : req.query.token;
    if (provided !== token) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const providerName = req.query.provider;
    if (providerName !== undefined && !ACCEPTED_PROVIDER_NAMES.has(providerName)) {
      res.status(400).json({
        error: `Unsupported provider "${providerName}". Supported providers: claude, claude-sync, copilot`,
      });
      return;
    }
    next();
  });

  app.get("/api/events", (req, res) => {
    const sessionId = req.query.sessionId;
    if (!sessionId) {
      res.status(400).json({ error: "Missing 'sessionId' query parameter" });
      return;
    }
    hub.subscribe(sessionId, res, { needReplay: req.query.needReplay === "true" });
  });

  app.get("/api/sessions", async (req, res) => {
    const requested = Number(req.query.limit) || 10;
    const limit = Math.min(Math.max(requested, 25), 50);
    const cwd = req.query.cwd || undefined;
    try {
      const sessions = await provider.listSessions(limit, cwd);
      await Promise.all(
        sessions.map(async (s) => {
          if (s.status) return;
          s.status = await provider.getSessionStatus(s.id);
        })
      );
      res.json({ sessions });
    } catch (err) {
      res.json({ sessions: [], error: err.message });
    }
  });

  app.get("/api/info", async (_req, res) => {
    try {
      res.json(await provider.getInfo());
    } catch (err) {
      res.json({ account: {}, model: "Unknown", version: "Unknown", error: err.message });
    }
  });

  app.get("/api/update-check", (_req, res) => {
    res.json({ version: "0.1.0", newestVersion: null, updateAvailable: false });
  });

  app.get("/api/sessions/:id/history", async (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 10, 10);
    try {
      res.json({ history: await provider.getHistory(req.params.id, limit) });
    } catch (err) {
      res.json({ history: [], error: err.message });
    }
  });

  app.get("/api/messages", (req, res) => {
    const sessionId = req.query.sessionId;
    if (!sessionId) {
      res.status(400).json({ error: "Missing 'sessionId'" });
      return;
    }
    const after = Number(req.query.after) || 0;
    const status = provider.getStatus(sessionId);
    res.json({
      messages: hub.getMessages(sessionId, after),
      state: status?.state ?? "idle",
      sessionId,
      provider: status?.provider ?? req.query.provider ?? null,
    });
  });

  app.get("/api/status", (req, res) => {
    const sessionId = req.query.sessionId;
    if (!sessionId) {
      res.status(400).json({ error: "Missing 'sessionId'" });
      return;
    }
    const status = provider.getStatus(sessionId);
    if (!status) {
      res.status(404).json({ error: "Session not found" });
      return;
    }
    res.json({ state: status.state, sessionId, provider: status.provider });
  });

  app.post("/api/prompt", async (req, res) => {
    const { text, sessionId, cwd } = req.body ?? {};
    if (!text || typeof text !== "string") {
      res.status(400).json({ error: "Missing 'text' field" });
      return;
    }
    try {
      const result = await provider.prompt(sessionId, text, cwd);
      res.status(202).json({ ok: true, sessionId: result.sessionId, provider: result.provider });
    } catch (err) {
      res.status(err.statusCode ?? 500).json({ error: err.message });
    }
  });

  app.post("/api/permission-response", (req, res) => {
    const { sessionId, decision } = req.body ?? {};
    if (!sessionId) {
      res.status(400).json({ error: "Missing 'sessionId'" });
      return;
    }
    if (!provider.getStatus(sessionId)) {
      res.status(404).json({ error: "Session not found" });
      return;
    }
    provider.respondPermission(sessionId, DECISIONS.has(decision) ? decision : "deny");
    res.json({ ok: true });
  });

  app.post("/api/question-response", (req, res) => {
    const { sessionId, answer } = req.body ?? {};
    if (!sessionId) {
      res.status(400).json({ error: "Missing 'sessionId'" });
      return;
    }
    if (!provider.getStatus(sessionId)) {
      res.status(404).json({ error: "Session not found" });
      return;
    }
    provider.respondQuestion(sessionId, answer || "skip");
    res.json({ ok: true });
  });

  app.post("/api/interrupt", (req, res) => {
    const { sessionId } = req.body ?? {};
    if (!sessionId) {
      res.status(400).json({ error: "Missing 'sessionId'" });
      return;
    }
    if (!provider.getStatus(sessionId)) {
      res.status(404).json({ error: "Session not found" });
      return;
    }
    provider.interrupt(sessionId);
    res.json({ ok: true });
  });

  app.get("/api/metrics", (_req, res) => {
    res.json({ codex: { subscribedSessions: [] } });
  });

  app.use((req, res) => {
    res.status(404).json({ error: `Not found: ${req.method} ${req.path}` });
  });

  return app;
}
