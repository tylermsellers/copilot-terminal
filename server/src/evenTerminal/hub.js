// Per-session message ring buffer + SSE fan-out for the even-terminal wire
// contract's GET /api/events stream. Separate from ../store.js (which backs
// the original polling-based /api/messages route for our own app) — this
// hub exists purely so the even-terminal-compatible server can replay a
// backlog to a client that just (re)connected (?needReplay=true) and then
// push live updates to every subscriber of a session as they happen.

const MAX_MESSAGES_PER_SESSION = 500;
const HEARTBEAT_MS = 15_000;

export class MessageHub {
  constructor() {
    /** @type {Map<string, { id: number, msg: any }[]>} */
    this.buffers = new Map();
    /** @type {Map<string, Set<import('express').Response>>} */
    this.subscribers = new Map();
    /** @type {Map<string, number>} */
    this.nextId = new Map();
  }

  _buffer(sessionId) {
    let buf = this.buffers.get(sessionId);
    if (!buf) {
      buf = [];
      this.buffers.set(sessionId, buf);
    }
    return buf;
  }

  /** Push a translated even-terminal message onto a session's buffer and stream it to every live subscriber. */
  publish(sessionId, msg) {
    const id = (this.nextId.get(sessionId) ?? 0) + 1;
    this.nextId.set(sessionId, id);
    const buf = this._buffer(sessionId);
    buf.push({ id, msg });
    if (buf.length > MAX_MESSAGES_PER_SESSION) buf.shift();

    const subs = this.subscribers.get(sessionId);
    if (!subs || subs.size === 0) return id;
    const payload = `data: ${JSON.stringify(msg)}\n\n`;
    for (const res of subs) {
      try {
        res.write(payload);
      } catch {
        // dead connection — its own 'close' handler will clean it up
      }
    }
    return id;
  }

  /** Buffered messages with id > after, for the /api/messages polling fallback. */
  getMessages(sessionId, after = 0) {
    return this._buffer(sessionId)
      .filter((m) => m.id > after)
      .map((m) => m.msg);
  }

  /** Subscribe an SSE response to a session's live stream. Handles headers, optional backlog replay, heartbeats, and cleanup on disconnect. */
  subscribe(sessionId, res, { needReplay = false } = {}) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.write(": connected\n\n");

    if (needReplay) {
      for (const { msg } of this._buffer(sessionId)) {
        res.write(`data: ${JSON.stringify(msg)}\n\n`);
      }
    }

    let subs = this.subscribers.get(sessionId);
    if (!subs) {
      subs = new Set();
      this.subscribers.set(sessionId, subs);
    }
    subs.add(res);

    const heartbeat = setInterval(() => {
      try {
        res.write(": heartbeat\n\n");
      } catch {
        clearInterval(heartbeat);
      }
    }, HEARTBEAT_MS);
    heartbeat.unref?.();

    res.on("close", () => {
      clearInterval(heartbeat);
      subs?.delete(res);
    });
  }
}
