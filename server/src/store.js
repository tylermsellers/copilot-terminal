// Per-session message ring buffer, polled by the glasses app via GET /api/messages?after=N
// Mirrors the pattern used by even-terminal's own event bus (routes/events.js),
// but this is entirely our own code — no dependency on their package at runtime.

const MAX_MESSAGES_PER_SESSION = 500;

/** @type {Map<string, { messages: {id:number, msg:any}[], nextId: number }>} */
const sessions = new Map();

function getBucket(sessionId) {
  let bucket = sessions.get(sessionId);
  if (!bucket) {
    bucket = { messages: [], nextId: 1 };
    sessions.set(sessionId, bucket);
  }
  return bucket;
}

/** Append a message to a session's buffer. Returns the assigned message id. */
export function pushMessage(sessionId, msg) {
  const bucket = getBucket(sessionId);
  const id = bucket.nextId++;
  // Stamped here (once, centrally) rather than at each emit() call site, so
  // every message type gets a clock for free. See
  // eveng2-terminal-textinput's "message timestamps" patch notes — its
  // SSE events carried no clock at all, so a replayed transcript couldn't
  // tell you when anything actually happened.
  bucket.messages.push({ id, ts: Date.now(), msg });
  if (bucket.messages.length > MAX_MESSAGES_PER_SESSION) {
    bucket.messages.shift();
  }
  return id;
}

/** Get all messages with id > after for a session. */
export function getMessages(sessionId, after = 0) {
  const bucket = sessions.get(sessionId);
  if (!bucket) return [];
  return bucket.messages.filter((m) => m.id > after).map((m) => ({ id: m.id, ts: m.ts, ...m.msg }));
}

export function clearSession(sessionId) {
  sessions.delete(sessionId);
}

/**
 * Highest message id currently buffered for a session, or 0 if none yet.
 * Used when a client (re)opens an existing session: seeding its poll
 * cursor with this value (instead of 0) skips whatever backlog has
 * accumulated in the buffer since the relay started, since that backlog is
 * already covered by the separate getSessionHistory() snapshot the client
 * fetches for its initial view. Without this, reopening a session that has
 * seen a lot of prior activity replayed the entire buffer (up to
 * MAX_MESSAGES_PER_SESSION) as if it were brand new, burying the actual
 * current tail under a wall of duplicate/old content.
 */
export function getLatestId(sessionId) {
  const bucket = sessions.get(sessionId);
  if (!bucket) return 0;
  return bucket.nextId - 1;
}
