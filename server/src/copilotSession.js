// Wraps @github/copilot-sdk and adapts it into a simple polling-friendly
// message-buffer API that the glasses app can consume over plain HTTP.
import { CopilotClient } from "@github/copilot-sdk";
import { pushMessage } from "./store.js";
import { markKnown, isKnown } from "./registry.js";

/** @typedef {"idle"|"busy"} SessionState */

// How long a session can sit with no phone/glasses activity (no polls, no
// prompts, no responses) before the relay releases its live connection back.
// A resumed session is a real second "driver" attached to the same
// conversation as whatever else has it open (e.g. a `copilot` CLI session
// running in a terminal) — the SDK/CLI only expects one active driver at a
// time, so holding the connection open indefinitely after you've stopped
// actively using it from the glasses/phone is what made it look like a
// session got permanently "taken away" from the terminal even long after you
// were done on the phone. Releasing it on idle hands control back; a later
// prompt/poll from the phone just transparently resumes it again.
const IDLE_RELEASE_MS = 90_000;
const IDLE_SWEEP_INTERVAL_MS = 15_000;

// Failsafe for a session that reports "busy" and then never reports back.
// We derive state purely from SDK events (session.idle / session.error), so
// this shouldn't normally get stuck the way even-terminal's file-tail-based
// busy/idle detection did (see eveng2-terminal-textinput's "stale busy"
// patch notes — it derived state from the last line of the session's .jsonl
// transcript, which broke once newer Claude Code versions appended
// timestamp-less metadata trailers after the real turn-end marker). Our
// failure mode would be different (a dropped/uncaught SDK event, a hung
// tool call, or the underlying CLI process dying without emitting
// session.error) but the symptom is the same: the phone/glasses UI would
// show "Thinking…" forever with no way to recover short of restarting the
// relay. This sweep force-clears it after a generous timeout so the UI
// always recovers on its own.
const STALE_BUSY_MS = 10 * 60_000;

class Bridge {
  constructor() {
    this.client = new CopilotClient(); // uses locally logged-in `copilot` CLI auth by default
    this.started = false;
    /** @type {Map<string, import("@github/copilot-sdk").CopilotSession>} */
    this.sessions = new Map();
    /** @type {Map<string, SessionState>} */
    this.state = new Map();
    /** @type {Map<string, number>} last time this session saw phone/glasses activity */
    this.lastActivity = new Map();
    /** @type {Map<string, number>} timestamp a session most recently entered "busy" state */
    this.busySince = new Map();
    /** @type {Map<string, (result: any) => void>} keyed by `${sessionId}:${requestId}` */
    this.pendingPermissions = new Map();
    /** @type {Map<string, (result: any) => void>} keyed by `${sessionId}:${requestId}` */
    this.pendingQuestions = new Map();
    this._requestSeq = 0;
    this._idleSweepTimer = setInterval(() => {
      void this.sweepIdleSessions();
      this.sweepStaleBusy();
    }, IDLE_SWEEP_INTERVAL_MS);
    this._idleSweepTimer.unref?.();
  }

  async ensureStarted() {
    if (this.started) return;
    await this.client.start();
    this.started = true;
  }

  /** Record that a session just saw real phone/glasses activity (poll, prompt, or response). */
  touch(sessionId) {
    if (sessionId) this.lastActivity.set(sessionId, Date.now());
  }

  /** Release any resumed/created session we're holding open that's gone idle. Never yanks a busy (mid-turn) session. */
  async sweepIdleSessions() {
    const now = Date.now();
    for (const [sessionId, session] of [...this.sessions]) {
      if (this.getState(sessionId) === "busy") continue;
      const last = this.lastActivity.get(sessionId) ?? 0;
      if (now - last < IDLE_RELEASE_MS) continue;
      this.sessions.delete(sessionId);
      this.lastActivity.delete(sessionId);
      try {
        await session.disconnect();
      } catch {
        // best-effort release — nothing to do if it's already gone
      }
    }
  }

  /**
   * Force-clear any session that's been "busy" for longer than
   * STALE_BUSY_MS. This should be rare — it means either the SDK dropped an
   * event, a tool call is genuinely hung, or the underlying `copilot`
   * process died without emitting session.error — but without a failsafe
   * the phone/glasses UI would show "Thinking…" indefinitely with no way to
   * recover. Emits an error message so the client surfaces what happened
   * instead of just silently flipping back to idle.
   */
  sweepStaleBusy() {
    const now = Date.now();
    for (const [sessionId, since] of [...this.busySince]) {
      if (this.getState(sessionId) !== "busy") {
        this.busySince.delete(sessionId);
        continue;
      }
      if (now - since < STALE_BUSY_MS) continue;
      this.emit(sessionId, {
        type: "error",
        message: `No response for ${Math.round(STALE_BUSY_MS / 60_000)}+ minutes — marking idle. The task may still be running; check the terminal if this recurs.`,
      });
      this.setState(sessionId, "idle");
    }
  }

  emit(sessionId, msg) {
    pushMessage(sessionId, msg);
  }

  setState(sessionId, state) {
    this.state.set(sessionId, state);
    if (state === "busy") {
      if (!this.busySince.has(sessionId)) this.busySince.set(sessionId, Date.now());
    } else {
      this.busySince.delete(sessionId);
    }
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
    this.touch(session.sessionId);
    this.wireEvents(session);
    return session;
  }

  /**
   * Attach to an existing session by ID — whether it was created by this
   * relay, by `copilot` in a terminal, or by any other Copilot CLI surface.
   * Safe to call on a session that is currently idle. If another live
   * process is actively mid-turn on the same session, sends may race —
   * treat "one active driver at a time" as the current assumption. The
   * connection is released automatically after IDLE_RELEASE_MS of no
   * phone/glasses activity (see sweepIdleSessions), so briefly picking up
   * someone else's session doesn't hold onto it forever afterward.
   *
   * KNOWN LIMITATION (not fixed by the idle-release mitigation above):
   * typing a prompt from the phone/glasses into a session that is *still
   * actively open in an interactive terminal at that exact moment* can fork
   * that session's history — two writers racing on the same turn, not just
   * a lingering held-open connection. eveng2-terminal-textinput documents
   * the identical risk for even-terminal and recommends the same practical
   * rule we follow here: treat a session as read-only (peek via
   * getSessionHistory, don't prompt into it) while it's known to be open
   * elsewhere, and prefer prompting from a session this relay itself
   * created or one you know is idle everywhere else.
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
    this.touch(session.sessionId);
    markKnown(session.sessionId);
    this.wireEvents(session);
    return session;
  }

  /** Read-only history for a session, for showing context before you start typing. */
  async getSessionHistory(sessionId, limit = 10) {
    await this.ensureStarted();
    // resumeSession/getEvents have no timeout of their own in the SDK — bound
    // both here so a stalled call fails fast (returning an empty history)
    // instead of leaving the client's fetch hanging indefinitely. This is
    // a best-effort context peek; an empty result on timeout is harmless.
    const withTimeout = (promise, ms) =>
      Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), ms))]);
    const session = this.sessions.get(sessionId) ?? (await withTimeout(this.client.resumeSession(sessionId, {}), 5000));
    const events = await withTimeout(session.getEvents(), 5000);
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
    this.touch(session.sessionId);
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
    this.touch(sessionId);
    const kind = decision === "deny" ? "reject" : decision === "session" ? "approve-for-session" : "approve-once";
    resolve({ kind });
    return true;
  }

  respondQuestion(sessionId, requestId, answer) {
    const key = `${sessionId}:${requestId}`;
    const resolve = this.pendingQuestions.get(key);
    if (!resolve) return false;
    this.pendingQuestions.delete(key);
    this.touch(sessionId);
    resolve({ answer, wasFreeform: true });
    return true;
  }

  interrupt(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    this.touch(sessionId);
    session.abort().catch(() => {});
    return true;
  }

  /**
   * Release our live connection to a session right away (e.g. the phone/
   * glasses navigated back to the session list) instead of waiting for the
   * idle sweep. Never yanks a session that's currently mid-turn — the
   * caller can retry once it's idle, or just let the idle sweep pick it up.
   */
  async release(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return true;
    if (this.getState(sessionId) === "busy") return false;
    this.sessions.delete(sessionId);
    this.lastActivity.delete(sessionId);
    try {
      await session.disconnect();
    } catch {
      // best-effort — nothing to do if it's already gone
    }
    return true;
  }

  /**
   * @param {number} limit
   * @param {{ all?: boolean }} [opts] `all: true` bypasses the known-session
   *   scope and returns every local Copilot CLI session system-wide — the
   *   old (pre-scoping) behavior, still useful when you deliberately want
   *   to pick up an arbitrary session (e.g. one currently open in a
   *   terminal). Default is scoped to sessions this relay created or that
   *   were previously opened via this "all" view (see registry.js).
   */
  async listSessions(limit = 10, opts = {}) {
    await this.ensureStarted();
    const sessions = await this.client.listSessions();
    const scoped = opts.all ? sessions : sessions.filter((s) => isKnown(s.sessionId));
    return scoped.slice(0, limit).map((s) => {
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
