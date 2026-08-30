// Thin client for the local copilot-glasses-relay server.
//
// IMPORTANT — this app is distributed as a self-pack build, not a single
// shared Even Hub store package. Even Hub's network permission whitelist
// only accepts exact origins (no wildcards, no bare hostnames — see
// https://hub.evenrealities.com/docs/build/networking), and every user's
// relay runs on their own LAN at a different address. That means one
// person's IP can never be baked into a build everyone installs — each
// user must set their OWN relay origin in app.json's whitelist (see
// scripts/configure-whitelist.mjs) and pack their own .ehpk. See README.md.
//
// The relay URL/token are user-configurable from the phone-side settings
// screen (see main.ts's 'appMenu' launch-source branch) rather than baked
// into the build — persisted via the SDK's bridge.setLocalStorage, which
// survives app restarts (ordinary browser localStorage does not, inside the
// Even App's Flutter WebView).
import type { EvenAppBridge } from '@evenrealities/even_hub_sdk'

// Deliberately NOT a real address — there is no safe universal default
// across users/forks. An empty string means "not configured yet"; the
// glasses-side boot flow gates on this and sends the user to the phone
// settings screen instead of silently guessing an address.
export const DEFAULT_RELAY_URL = ''
const STORAGE_KEY_URL = 'copilotTerminal.relayUrl'
const STORAGE_KEY_TOKEN = 'copilotTerminal.relayToken'

let relayUrl = DEFAULT_RELAY_URL
let relayToken = ''

export function getRelayUrl(): string {
  return relayUrl
}

/** True once the user has explicitly saved a relay URL (from the phone settings screen). */
export function isRelayConfigured(): boolean {
  return relayUrl.trim().length > 0
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

// Tell the relay to let go of its live connection to this session (e.g. when
// navigating back to the session list) instead of waiting out the idle
// timeout. Best-effort — a busy (mid-turn) session is never yanked, and a
// failed/offline call here just means the relay's own idle sweep will
// release it a little later instead.
export async function releaseSession(sessionId: string) {
  try {
    await fetch(`${relayUrl}/api/sessions/${encodeURIComponent(sessionId)}/release`, {
      method: 'POST',
      headers: headers(false),
    })
  } catch {
    // best-effort only
  }
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
    // fetch() does not set a Content-Type for a raw Uint8Array/ArrayBuffer
    // body on its own. Without one, the relay's express.raw() body parser
    // never matches the request and silently leaves req.body empty --
    // surfacing as "Missing audio body" even though real PCM bytes were
    // sent over the wire. Must be set explicitly.
    headers: {
      ...(relayToken ? { 'x-relay-token': relayToken } : {}),
      'Content-Type': 'application/octet-stream',
    },
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
