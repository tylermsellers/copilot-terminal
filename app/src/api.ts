// Thin client for the local copilot-glasses-relay server.
//
// The relay URL/token are user-configurable from the phone-side settings
// screen (see main.ts's 'appMenu' launch-source branch) rather than baked
// into the build — persisted via the SDK's bridge.setLocalStorage, which
// survives app restarts (ordinary browser localStorage does not, inside the
// Even App's Flutter WebView).
import type { EvenAppBridge } from '@evenrealities/even_hub_sdk'

export const DEFAULT_RELAY_URL = 'http://192.168.0.49:4756'
const STORAGE_KEY_URL = 'copilotTerminal.relayUrl'
const STORAGE_KEY_TOKEN = 'copilotTerminal.relayToken'

let relayUrl = DEFAULT_RELAY_URL
let relayToken = ''

export function getRelayUrl(): string {
  return relayUrl
}

export function getRelayToken(): string {
  return relayToken
}

/** Read any previously-saved relay config from the Even App's persistent storage. */
export async function loadRelayConfig(bridge: EvenAppBridge): Promise<void> {
  const [savedUrl, savedToken] = await Promise.all([
    bridge.getLocalStorage(STORAGE_KEY_URL),
    bridge.getLocalStorage(STORAGE_KEY_TOKEN),
  ])
  if (savedUrl) relayUrl = savedUrl
  if (savedToken) relayToken = savedToken
}

/** Persist a new relay config and apply it immediately for subsequent calls. */
export async function saveRelayConfig(bridge: EvenAppBridge, url: string, token: string): Promise<void> {
  relayUrl = url.trim().replace(/\/+$/, '') || DEFAULT_RELAY_URL
  relayToken = token.trim()
  await Promise.all([
    bridge.setLocalStorage(STORAGE_KEY_URL, relayUrl),
    bridge.setLocalStorage(STORAGE_KEY_TOKEN, relayToken),
  ])
}

function headers(json = true): Record<string, string> {
  const h: Record<string, string> = {}
  if (json) h['Content-Type'] = 'application/json'
  if (relayToken) h['x-relay-token'] = relayToken
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
  const res = await fetch(`${relayUrl}/api/sessions?limit=${limit}`, { headers: headers(false) })
  const data = await res.json()
  return data.sessions ?? []
}

export async function sendPrompt(text: string, sessionId?: string): Promise<{ sessionId: string }> {
  const res = await fetch(`${relayUrl}/api/prompt`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ text, sessionId }),
  })
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`)
  return res.json()
}

export async function getMessages(sessionId: string, after: number): Promise<{ messages: RelayMessage[]; state: string }> {
  const res = await fetch(`${relayUrl}/api/messages?sessionId=${encodeURIComponent(sessionId)}&after=${after}`, {
    headers: headers(false),
  })
  return res.json()
}

export async function respondPermission(sessionId: string, requestId: string, decision: 'allow' | 'session' | 'deny') {
  await fetch(`${relayUrl}/api/permission-response`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ sessionId, requestId, decision }),
  })
}

export async function respondQuestion(sessionId: string, requestId: string, answer: string) {
  await fetch(`${relayUrl}/api/question-response`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ sessionId, requestId, answer }),
  })
}

export async function interrupt(sessionId: string) {
  await fetch(`${relayUrl}/api/interrupt`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ sessionId }),
  })
}

export async function getHistory(sessionId: string, limit = 6): Promise<{ role: 'user' | 'assistant'; text: string }[]> {
  const res = await fetch(`${relayUrl}/api/sessions/${encodeURIComponent(sessionId)}/history?limit=${limit}`, {
    headers: headers(false),
  })
  const data = await res.json()
  return data.history ?? []
}

export async function transcribe(pcm: Uint8Array, sampleRate = 16000): Promise<string> {
  const res = await fetch(`${relayUrl}/api/transcribe?sampleRate=${sampleRate}`, {
    method: 'POST',
    headers: relayToken ? { 'x-relay-token': relayToken } : {},
    body: pcm as unknown as BodyInit,
  })
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`)
  const data = await res.json()
  return data.text ?? ''
}

export async function checkHealth(): Promise<boolean> {
  try {
    const res = await fetch(`${relayUrl}/api/health`, { headers: headers(false) })
    if (!res.ok) return false
    const data = await res.json()
    return Boolean(data.ok)
  } catch {
    return false
  }
}
