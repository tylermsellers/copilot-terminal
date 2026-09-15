// Translates our Bridge's internal message shapes (copilotSession.js's
// emit() calls — assistant_message, user_prompt, status, error,
// permission_request, question, tool_start) into the even-terminal wire
// contract's EvenMessage variants (see WichardRiezebos/even-terminal-opencode
// src/types.ts, which mirrors the vendored MIT-licensed
// @evenrealities/even-terminal dist). One internal message can translate to
// zero or one wire message; return null to swallow it.

/**
 * @param {string} sessionId
 * @param {any} msg internal Bridge message (the same object passed to bridge.emit)
 * @returns {any | null} an EvenMessage, or null if this internal message has no wire equivalent
 */
export function translate(sessionId, msg) {
  switch (msg.type) {
    case "assistant_message":
      if (!msg.text) return null;
      return { type: "text_delta", text: msg.text };

    case "user_prompt":
      return { type: "user_prompt", text: msg.text };

    case "status":
      // Surface turn completion as a `result` too — Terminal Mode uses this
      // to close out a turn's UI state (spinner, running stats) distinctly
      // from a bare status ping.
      if (msg.state === "idle") {
        return { type: "status", state: "idle", sessionId };
      }
      return { type: "status", state: "busy", sessionId };

    case "error":
      return { type: "error", message: msg.message ?? "Unknown error" };

    case "permission_request": {
      const req = msg.request ?? {};
      const toolName = req.tool?.name ?? req.name ?? "tool";
      const detail = safeStringify(req.input ?? req.arguments ?? {});
      return {
        type: "permission_request",
        toolName,
        description: req.description ?? `Allow ${toolName}?`,
        detail,
        toolUseId: msg.requestId,
        options: [
          { text: "Allow", key: "allow" },
          { text: "Always Allow", key: "allowAlways" },
          { text: "Deny", key: "deny" },
        ],
      };
    }

    case "question": {
      const choices = Array.isArray(msg.choices) ? msg.choices : [];
      return {
        type: "user_question",
        toolUseId: msg.requestId,
        questions: [
          {
            question: msg.question ?? "",
            header: "",
            options: choices.map((c) => ({ label: String(c), description: "" })),
          },
        ],
      };
    }

    case "tool_start":
      if (!msg.name) return null;
      return { type: "tool_start", name: msg.name, toolId: `${msg.name}-${Date.now()}` };

    default:
      return null;
  }
}

function safeStringify(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
