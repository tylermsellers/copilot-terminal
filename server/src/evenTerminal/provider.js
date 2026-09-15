// Implements the even-terminal wire contract's 9-method provider interface
// (see WichardRiezebos/even-terminal-opencode src/types.ts EvenProvider),
// backed by our existing Bridge (copilotSession.js) rather than a real
// `claude`/`codex` CLI. The Even app only ever talks to this file's methods
// through evenTerminalServer.js's routes — it has no idea the actual work
// is done by @github/copilot-sdk.
//
// Presented "provider" name on the wire is always "claude" (cosmetic only —
// see even-terminal-opencode's README: the Even app's Terminal Mode UI
// filters its session list to recognized provider names, so an unknown
// name like "copilot" would simply not render).
import { bridge } from "../copilotSession.js";
import { translate } from "./translate.js";

const PRESENTED_PROVIDER = "claude";

export class CopilotTerminalProvider {
  constructor(hub) {
    this.hub = hub;
    /** @type {Map<string, string>} sessionId -> most recent pending permission requestId */
    this.pendingPermissionId = new Map();
    /** @type {Map<string, string>} sessionId -> most recent pending question requestId */
    this.pendingQuestionId = new Map();

    bridge.onMessage((sessionId, msg) => {
      if (msg.type === "permission_request") this.pendingPermissionId.set(sessionId, msg.requestId);
      if (msg.type === "question") this.pendingQuestionId.set(sessionId, msg.requestId);
      const wireMsg = translate(sessionId, msg);
      if (wireMsg) this.hub.publish(sessionId, wireMsg);
    });
  }

  async listSessions(limit, cwd) {
    // Unlike the original copilot-glasses-link app (which scopes to a
    // "known" registry to keep an unrelated old session out of the glasses
    // picker), Terminal Mode's whole purpose is showing whatever's
    // currently active — matching real even-terminal's own behavior for
    // Claude/Codex ("session listing remains unfiltered unless the client
    // explicitly supplies a cwd filter"). So this always asks for the full,
    // unscoped list.
    const sessions = await bridge.listSessions(limit, { all: true });
    const filtered = cwd ? sessions.filter((s) => s.cwd === cwd) : sessions;
    return filtered.map((s) => ({
      id: s.id,
      title: s.title,
      timestamp: s.timestamp ? new Date(s.timestamp).toISOString() : new Date().toISOString(),
      cwd: s.cwd ?? "",
      provider: PRESENTED_PROVIDER,
      status: null,
    }));
  }

  async getSessionStatus(id) {
    return bridge.getState(id);
  }

  async getInfo() {
    const info = await bridge.getInfo();
    return {
      account: info.account ?? {},
      model: "GitHub Copilot",
      version: info.version ?? "Unknown",
      provider: PRESENTED_PROVIDER,
    };
  }

  async getHistory(id, limit) {
    const turns = await bridge.getSessionHistory(id, limit);
    return turns.map((t) => ({ role: t.role, text: t.text }));
  }

  async prompt(sessionId, text, cwd) {
    const result = await bridge.prompt(sessionId || undefined, text, cwd);
    return { sessionId: result.sessionId, provider: PRESENTED_PROVIDER };
  }

  respondPermission(id, decision) {
    const requestId = this.pendingPermissionId.get(id);
    if (!requestId) return;
    this.pendingPermissionId.delete(id);
    const bridgeDecision = decision === "deny" ? "deny" : decision === "allowAlways" ? "session" : "once";
    bridge.respondPermission(id, requestId, bridgeDecision);
  }

  respondQuestion(id, answer) {
    const requestId = this.pendingQuestionId.get(id);
    if (!requestId) return;
    this.pendingQuestionId.delete(id);
    bridge.respondQuestion(id, requestId, answer);
  }

  interrupt(id) {
    bridge.interrupt(id);
  }

  getStatus(id) {
    const state = bridge.getState(id);
    if (!state) return null;
    return { state, provider: PRESENTED_PROVIDER };
  }
}
