// Thin client for the local copilot-glasses-relay server.
// Update RELAY_URL if your PC's LAN IP differs (must also match app.json's
// network permission whitelist entry).
export const RELAY_URL = 'http://192.168.0.49:4756'
const RELAY_TOKEN = '' // set if you later configure RELAY_TOKEN on the server

function headers(json = true): Record<string, string> {
  const h: Record<string, string> = {}
  if (json) h['Content-Type'] = 'application/json'
  if (RELAY_TOKEN) h['x-relay-token'] = RELAY_TOKEN
  return h
}

export interface SessionSummary {
  id: string
  title: string
  timestamp: string | null
  cwd: string
}

export interface RelayMessage {
  id: number
  type: 'status' | 'user_prompt' | 'assistant_message' | 'permission_request' | 'question' | 'error' | 'tool_start'
  [key: string]: any
}

export async function listSessions(limit = 8): Promise<SessionSummary[]> {
  const res = await fetch(`${RELAY_URL}/api/sessions?limit=${limit}`, { headers: headers(false) })
  const data = await res.json()
  return data.sessions ?? []
}

export async function sendPrompt(text: string, sessionId?: string): Promise<{ sessionId: string }> {
  const res = await fetch(`${RELAY_URL}/api/prompt`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ text, sessionId }),
  })
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`)
  return res.json()
}

export async function getMessages(sessionId: string, after: number): Promise<{ messages: RelayMessage[]; state: string }> {
  const res = await fetch(`${RELAY_URL}/api/messages?sessionId=${encodeURIComponent(sessionId)}&after=${after}`, {
    headers: headers(false),
  })
  return res.json()
}

export async function respondPermission(sessionId: string, requestId: string, decision: 'allow' | 'session' | 'deny') {
  await fetch(`${RELAY_URL}/api/permission-response`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ sessionId, requestId, decision }),
  })
}

export async function respondQuestion(sessionId: string, requestId: string, answer: string) {
  await fetch(`${RELAY_URL}/api/question-response`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ sessionId, requestId, answer }),
  })
}

export async function interrupt(sessionId: string) {
  await fetch(`${RELAY_URL}/api/interrupt`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ sessionId }),
  })
}

export async function getHistory(sessionId: string, limit = 6): Promise<{ role: 'user' | 'assistant'; text: string }[]> {
  const res = await fetch(`${RELAY_URL}/api/sessions/${encodeURIComponent(sessionId)}/history?limit=${limit}`, {
    headers: headers(false),
  })
  const data = await res.json()
  return data.history ?? []
}

export async function transcribe(pcm: Uint8Array, sampleRate = 16000): Promise<string> {
  const res = await fetch(`${RELAY_URL}/api/transcribe?sampleRate=${sampleRate}`, {
    method: 'POST',
    headers: RELAY_TOKEN ? { 'x-relay-token': RELAY_TOKEN } : {},
    body: pcm as unknown as BodyInit,
  })
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`)
  const data = await res.json()
  return data.text ?? ''
}
