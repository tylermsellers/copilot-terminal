// Wraps @github/copilot-sdk and adapts it into a simple polling-friendly
// message-buffer API that the glasses app can consume over plain HTTP.
import { CopilotClient } from "@github/copilot-sdk";
import { pushMessage } from "./store.js";

/** @typedef {"idle"|"busy"} SessionState */

class Bridge {
  constructor() {
    this.client = new CopilotClient(); // uses locally logged-in `copilot` CLI auth by default
    this.started = false;
    /** @type {Map<string, import("@github/copilot-sdk").CopilotSession>} */
    this.sessions = new Map();
    /** @type {Map<string, SessionState>} */
    this.state = new Map();
    /** @type {Map<string, (result: any) => void>} keyed by `${sessionId}:${requestId}` */
    this.pendingPermissions = new Map();
    /** @type {Map<string, (result: any) => void>} keyed by `${sessionId}:${requestId}` */
    this.pendingQuestions = new Map();
    this._requestSeq = 0;
  }

  async ensureStarted() {
    if (this.started) return;
    await this.client.start();
    this.started = true;
  }

  emit(sessionId, msg) {
    pushMessage(sessionId, msg);
  }

  setState(sessionId, state) {
    this.state.set(sessionId, state);
    this.emit(sessionId, { type: "status", state });
  }

  getState(sessionId) {
    return this.state.get(sessionId) ?? "idle";
  }

  nextRequestId() {
    return `req_${++this._requestSeq}`;
  }

  makeHandlers(sessionIdHint) {
    const onPermissionRequest = (request, invocation) =>
      new Promise((resolve) => {
        const requestId = this.nextRequestId();
        this.pendingPermissions.set(`${invocation.sessionId}:${requestId}`, resolve);
        this.emit(invocation.sessionId, {
          type: "permission_request",
          requestId,
          request,
        });
      });

    const onUserInput = (request, invocation) =>
      new Promise((resolve) => {
        const requestId = this.nextRequestId();
        this.pendingQuestions.set(`${invocation.sessionId}:${requestId}`, resolve);
        this.emit(invocation.sessionId, {
          type: "question",
          requestId,
          question: request.question,
          choices: request.choices ?? [],
        });
      });
    return { onPermissionRequest, onUserInput };
  }

  /** Create a brand new Copilot CLI session and wire up event -> message-buffer bridging. */
  async createSession(cwd) {
    await this.ensureStarted();
    const session = await this.client.createSession({
      model: "claude-sonnet-4.6",
      workingDirectory: cwd,
      ...this.makeHandlers(),
    });
    this.sessions.set(session.sessionId, session);
    this.setState(session.sessionId, "idle");
    this.wireEvents(session);
    return session;
  }

  /**
   * Attach to an existing session by ID — whether it was created by this
   * relay, by `copilot` in a terminal, or by any other Copilot CLI surface.
   * Safe to call on a session that is currently idle. If another live
   * process is actively mid-turn on the same session, sends may race —
   * treat "one active driver at a time" as the current assumption.
   */
  async resumeExisting(sessionId, cwd) {
    await this.ensureStarted();
    const existing = this.sessions.get(sessionId);
    if (existing) return existing;
    const session = await this.client.resumeSession(sessionId, {
      workingDirectory: cwd,
      ...this.makeHandlers(),
    });
    this.sessions.set(session.sessionId, session);
    this.setState(session.sessionId, "idle");
    this.wireEvents(session);
    return session;
  }

  /** Read-only history for a session, for showing context before you start typing. */
  async getSessionHistory(sessionId, limit = 10) {
    await this.ensureStarted();
    const session = this.sessions.get(sessionId) ?? (await this.client.resumeSession(sessionId, {}));
    const events = await session.getEvents();
    const turns = events
      .filter((e) => e.type === "assistant.message" || e.type === "user.message")
      .map((e) => ({ role: e.type === "assistant.message" ? "assistant" : "user", text: e.data?.content ?? "" }));
    if (!this.sessions.has(sessionId)) await session.disconnect(); // read-only peek, don't hold it open
    return turns.slice(-limit);
  }

  wireEvents(session) {
    const sessionId = session.sessionId;

    session.on("assistant.message", (event) => {
      this.emit(sessionId, { type: "assistant_message", text: event.data.content });
    });

    session.on("session.idle", () => {
      this.setState(sessionId, "idle");
    });

    session.on("session.error", (event) => {
      this.emit(sessionId, { type: "error", message: event.data?.message ?? "Unknown error" });
      this.setState(sessionId, "idle");
    });

    // Best-effort: surface tool activity as a lightweight status line, if the
    // runtime emits a tool-execution event under this name.
    session.on((event) => {
      if (event.type === "tool.execution.start" || event.type === "tool_execution.start") {
        this.emit(sessionId, { type: "tool_start", name: event.data?.name ?? event.data?.toolName });
      }
    });
  }

  async prompt(sessionId, text, cwd) {
    let session = sessionId ? this.sessions.get(sessionId) : null;
    if (!session && sessionId) {
      // Caller passed an existing session ID (e.g. resumed from /api/sessions) — attach to it
      // rather than silently starting a new one.
      session = await this.resumeExisting(sessionId, cwd);
    } else if (!session) {
      session = await this.createSession(cwd);
    }
    this.setState(session.sessionId, "busy");
    this.emit(session.sessionId, { type: "user_prompt", text });
    session.send(text).catch((err) => {
      this.emit(session.sessionId, { type: "error", message: err.message });
      this.setState(session.sessionId, "idle");
    });
    return { sessionId: session.sessionId };
  }

  respondPermission(sessionId, requestId, decision) {
    const key = `${sessionId}:${requestId}`;
    const resolve = this.pendingPermissions.get(key);
    if (!resolve) return false;
    this.pendingPermissions.delete(key);
    const kind = decision === "deny" ? "reject" : decision === "session" ? "approve-for-session" : "approve-once";
    resolve({ kind });
    return true;
  }

  respondQuestion(sessionId, requestId, answer) {
    const key = `${sessionId}:${requestId}`;
    const resolve = this.pendingQuestions.get(key);
    if (!resolve) return false;
    this.pendingQuestions.delete(key);
    resolve({ answer, wasFreeform: true });
    return true;
  }

  interrupt(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    session.abort().catch(() => {});
    return true;
  }

  async listSessions(limit = 10) {
    await this.ensureStarted();
    const sessions = await this.client.listSessions();
    return sessions.slice(0, limit).map((s) => {
      const timestamp = s.modifiedTime ?? s.startTime ?? null;
      const cwd = s.context?.workingDirectory ?? "";
      const rawTitle = (s.summary || "").trim();
      // Fall back to a readable date/time (and folder name, if known) so the
      // glasses picker never shows a blank list entry when a session has no
      // summary yet (e.g. it never got far enough for Copilot to name it).
      let title = rawTitle;
      if (!title) {
        const when = timestamp ? new Date(timestamp).toLocaleString() : s.sessionId.slice(0, 8);
        const folder = cwd ? cwd.split(/[\\/]/).filter(Boolean).pop() : "";
        title = folder ? `${folder} — ${when}` : when;
      }
      return {
        id: s.sessionId,
        title: title.slice(0, 64),
        timestamp,
        cwd,
      };
    });
  }

  async getInfo() {
    await this.ensureStarted();
    const [status, auth] = await Promise.all([
      this.client.getStatus().catch(() => null),
      this.client.getAuthStatus().catch(() => null),
    ]);
    return {
      version: status?.version ?? "Unknown",
      account: auth?.login ? { login: auth.login } : {},
    };
  }
}

export const bridge = new Bridge();
