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
  bucket.messages.push({ id, msg });
  if (bucket.messages.length > MAX_MESSAGES_PER_SESSION) {
    bucket.messages.shift();
  }
  return id;
}

/** Get all messages with id > after for a session. */
export function getMessages(sessionId, after = 0) {
  const bucket = sessions.get(sessionId);
  if (!bucket) return [];
  return bucket.messages.filter((m) => m.id > after).map((m) => ({ id: m.id, ...m.msg }));
}

export function clearSession(sessionId) {
  sessions.delete(sessionId);
}
