// Phone-side app — rendered inside the Even App's own Flutter WebView (not
// on the glasses) when Copilot Terminal is opened from the phone's plugin
// menu. Treats the phone as a first-class client, not just a settings form:
// it can start new sessions, browse and open existing ones, and converse
// with Copilot via the phone's own keyboard (the G2/R1 touchpad has no
// keyboard at all, so typed input and full transcript history are things
// only the phone side can offer).
//
// Three screens, single-page-app style (no router library needed):
//   sessions  — list of recent sessions + "New session"
//   chat      — transcript + text input, for one session (new or existing)
//   settings  — relay URL/token config; reached via the gear icon, not the
//               first thing shown, unless the relay has never been set up
//
// Visual language is a modern iOS system look (SF-style font stack, iOS
// system colors incl. dark mode, translucent nav/input bars, iMessage-style
// bubbles) since this now needs to feel like a real native screen, not just
// a one-off config form.

import type { EvenAppBridge } from '@evenrealities/even_hub_sdk'
import {
  listSessions,
  sendPrompt,
  getMessages,
  respondPermission,
  respondQuestion,
  interrupt,
  getHistory,
  checkHealth,
  getRelayUrl,
  getRelayToken,
  saveRelayConfig,
  isRelayConfigured,
  releaseSession,
  type SessionSummary,
  type RelayMessage,
} from './api'

export interface PhoneAppDeps {
  bridge: EvenAppBridge
}

// ── Design system ───────────────────────────────────────────────────

const STYLE = `
  :root {
    color-scheme: dark light;
    /* GitHub Copilot–style dark theme (primer dark palette + Copilot purple) */
    --bg: #0d1117;
    --bg-elevated: #161b22;
    --bar-bg: rgba(13,17,23,0.85);
    --label: #e6edf3;
    --label-secondary: #7d8590;
    --separator: #30363d;
    --fill-secondary: rgba(139,148,158,0.16);
    --accent: #a371f7;
    --accent-strong: #8957e5;
    --accent-contrast: #FFFFFF;
    --green: #3fb950;
    --red: #f85149;
    --bubble-user-text: #FFFFFF;
    --bubble-assistant: var(--bg-elevated);
    --bubble-assistant-text: var(--label);
  }
  @media (prefers-color-scheme: light) {
    :root {
      --bg: #ffffff;
      --bg-elevated: #f6f8fa;
      --bar-bg: rgba(255,255,255,0.85);
      --label: #1f2328;
      --label-secondary: #656d76;
      --separator: #d0d7de;
      --fill-secondary: rgba(175,184,193,0.24);
      --accent: #8250df;
      --accent-strong: #6639ba;
      --green: #1a7f37;
      --red: #cf222e;
      --bubble-assistant: var(--bg-elevated);
      --bubble-assistant-text: #1f2328;
    }
  }
  * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
  html, body { height: 100%; }
  body {
    margin: 0;
    background: var(--bg);
    color: var(--label);
    font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, sans-serif;
    overscroll-behavior: none;
  }
  #app {
    position: fixed;
    top: 0; left: 0; right: 0;
    height: 100%; /* fallback; overridden by JS to track window.visualViewport when the on-screen keyboard opens */
    display: flex;
    flex-direction: column;
  }

  .navbar {
    flex: 0 0 auto;
    display: grid;
    grid-template-columns: minmax(44px, auto) 1fr minmax(44px, auto);
    align-items: center;
    gap: 8px;
    padding: max(10px, env(safe-area-inset-top)) 8px 10px;
    background: var(--bar-bg);
    backdrop-filter: blur(20px);
    -webkit-backdrop-filter: blur(20px);
    border-bottom: 0.5px solid var(--separator);
    position: relative;
    z-index: 2;
  }
  .navbar-title {
    min-width: 0;
    text-align: center;
    font-size: 17px;
    font-weight: 700;
    pointer-events: none;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .navbar-title::before {
    content: '\\2726';
    color: var(--accent);
    margin-right: 5px;
  }
  .navbar-side { display: flex; align-items: center; min-width: 44px; }
  .navbar-side.right { justify-content: flex-end; }
  .nav-btn {
    background: none;
    border: none;
    color: var(--accent);
    font-size: 17px;
    padding: 6px 8px;
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: 4px;
    font-family: inherit;
  }
  .nav-btn:disabled { opacity: 0.4; }
  .nav-btn.icon { font-size: 20px; padding: 4px 8px; }

  .content { flex: 1 1 auto; overflow-y: auto; -webkit-overflow-scrolling: touch; }

  /* ── Sessions list ─────────────────────────────────────────── */
  .list-section { margin: 20px 16px; }
  .list-group {
    background: var(--bg-elevated);
    border: 1px solid var(--separator);
    border-radius: 12px;
    overflow: hidden;
  }
  .list-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 13px 16px;
    border-bottom: 0.5px solid var(--separator);
    cursor: pointer;
  }
  .list-row:last-child { border-bottom: none; }
  .list-row:active { background: var(--fill-secondary); }
  .list-row-text { min-width: 0; flex: 1; }
  .list-row-title {
    font-size: 16px;
    font-weight: 500;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .list-row-sub {
    font-size: 13px;
    color: var(--label-secondary);
    margin-top: 2px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .chevron { color: var(--separator); font-size: 15px; flex: 0 0 auto; }
  .empty-state {
    text-align: center;
    color: var(--label-secondary);
    font-size: 15px;
    padding: 40px 20px;
  }
  .new-session-btn {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 14px 16px;
    background: linear-gradient(135deg, var(--accent-strong), var(--accent));
    color: #fff;
    font-size: 16px;
    font-weight: 600;
    cursor: pointer;
  }
  .new-session-btn:active { filter: brightness(0.9); }
  .new-session-btn .plus-badge {
    width: 22px; height: 22px;
    border-radius: 6px;
    background: rgba(255,255,255,0.25);
    color: #fff;
    display: flex; align-items: center; justify-content: center;
    font-size: 15px; font-weight: 600;
  }
  .scope-toggle-row { text-align: center; margin: -8px 16px 20px; }
  .scope-toggle-btn {
    background: none;
    border: none;
    color: var(--accent);
    font-size: 13px;
    font-weight: 600;
    font-family: inherit;
    cursor: pointer;
    padding: 8px 12px;
  }

  /* ── Chat ──────────────────────────────────────────────────── */
  .chat-scroll { padding: 12px 12px 8px; display: flex; flex-direction: column; gap: 8px; }
  .bubble-row { display: flex; }
  .bubble-row.user { justify-content: flex-end; }
  .bubble-row.assistant { justify-content: flex-start; }
  .bubble {
    max-width: 78%;
    padding: 9px 14px;
    border-radius: 18px;
    font-size: 16px;
    line-height: 1.32;
    white-space: pre-wrap;
    word-wrap: break-word;
  }
  .bubble.user {
    background: linear-gradient(135deg, var(--accent-strong), var(--accent));
    color: var(--bubble-user-text);
    border-bottom-right-radius: 4px;
  }
  .bubble.assistant {
    background: var(--bubble-assistant);
    color: var(--bubble-assistant-text);
    border: 1px solid var(--separator);
    border-bottom-left-radius: 4px;
  }
  .pill-row { display: flex; justify-content: center; }
  .pill {
    font-size: 12px;
    color: var(--label-secondary);
    background: var(--fill-secondary);
    padding: 4px 12px;
    border-radius: 12px;
  }
  .pill.error { color: var(--red); }

  .action-card {
    background: var(--bg-elevated);
    border: 1px solid var(--separator);
    border-radius: 14px;
    padding: 12px 14px;
    max-width: 88%;
    align-self: center;
    width: 100%;
  }
  .action-card .prompt { font-size: 15px; margin-bottom: 10px; }
  .action-card .buttons { display: flex; flex-direction: column; gap: 8px; }
  .action-btn {
    padding: 10px 12px;
    border-radius: 10px;
    border: none;
    background: var(--fill-secondary);
    color: var(--label);
    font-size: 15px;
    font-weight: 500;
    cursor: pointer;
    font-family: inherit;
  }
  .action-btn.primary { background: linear-gradient(135deg, var(--accent-strong), var(--accent)); color: #fff; }
  .action-btn.danger { background: var(--red); color: #fff; }
  .action-btn:disabled { opacity: 0.45; }
  .action-card .resolved { font-size: 13px; color: var(--label-secondary); }
  .custom-answer { display: flex; gap: 8px; margin-top: 4px; }
  .custom-answer input {
    flex: 1;
    border: none;
    border-radius: 10px;
    background: var(--fill-secondary);
    color: var(--label);
    padding: 9px 10px;
    font-size: 15px;
    font-family: inherit;
  }

  .thinking-row {
    display: flex;
    align-items: center;
    gap: 6px;
    color: var(--label-secondary);
    font-size: 13px;
    padding: 2px 4px 6px;
  }
  .dot-flash { display: inline-flex; gap: 3px; }
  .dot-flash span {
    width: 5px; height: 5px; border-radius: 50%;
    background: var(--accent);
    animation: dotFlash 1s infinite ease-in-out both;
  }
  .dot-flash span:nth-child(2) { animation-delay: 0.15s; }
  .dot-flash span:nth-child(3) { animation-delay: 0.3s; }
  @keyframes dotFlash { 0%, 80%, 100% { opacity: 0.25; } 40% { opacity: 1; } }

  .input-bar {
    flex: 0 0 auto;
    display: flex;
    align-items: flex-end;
    gap: 8px;
    padding: 8px 10px max(8px, env(safe-area-inset-bottom));
    background: var(--bar-bg);
    backdrop-filter: blur(20px);
    -webkit-backdrop-filter: blur(20px);
    border-top: 0.5px solid var(--separator);
  }
  .input-bar textarea {
    flex: 1;
    resize: none;
    border: none;
    border-radius: 18px;
    background: var(--fill-secondary);
    color: var(--label);
    padding: 9px 14px;
    font-size: 16px;
    font-family: inherit;
    max-height: 120px;
    line-height: 1.3;
  }
  .input-bar textarea:focus { outline: none; }
  .send-btn {
    width: 32px; height: 32px;
    border-radius: 50%;
    border: none;
    background: linear-gradient(135deg, var(--accent-strong), var(--accent));
    color: #fff;
    font-size: 15px;
    display: flex; align-items: center; justify-content: center;
    cursor: pointer;
    flex: 0 0 auto;
  }
  .send-btn:disabled { background: var(--fill-secondary); color: var(--label-secondary); }

  /* ── Settings ──────────────────────────────────────────────── */
  .settings-screen { padding: 20px 16px; max-width: 480px; margin: 0 auto; }
  .settings-intro { font-size: 15px; color: var(--label-secondary); margin: 0 0 20px; line-height: 1.4; }
  .field { margin-bottom: 16px; }
  .field label {
    display: block;
    font-size: 12px;
    font-weight: 600;
    letter-spacing: 0.02em;
    text-transform: uppercase;
    color: var(--label-secondary);
    margin: 0 0 6px;
  }
  .field input {
    width: 100%;
    padding: 12px 14px;
    border-radius: 12px;
    border: 1px solid var(--separator);
    background: var(--fill-secondary);
    color: var(--label);
    font-size: 16px;
    font-family: inherit;
  }
  .field input:focus { outline: 2px solid var(--accent); }
  .settings-actions { display: flex; gap: 10px; margin-top: 22px; }
  .btn {
    flex: 1;
    padding: 13px 16px;
    border-radius: 12px;
    border: none;
    font-size: 16px;
    font-weight: 600;
    font-family: inherit;
    cursor: pointer;
  }
  .btn.primary { background: linear-gradient(135deg, var(--accent-strong), var(--accent)); color: #fff; }
  .btn.secondary { background: var(--fill-secondary); color: var(--label); }
  .btn:disabled { opacity: 0.5; }
  .status-box {
    margin-top: 16px;
    padding: 12px 14px;
    border-radius: 12px;
    background: var(--fill-secondary);
    font-size: 13px;
    color: var(--label-secondary);
    min-height: 1.4em;
  }
  .status-box.ok { color: var(--green); }
  .status-box.err { color: var(--red); }
  .note { margin-top: 22px; font-size: 13px; color: var(--label-secondary); line-height: 1.5; }
`

let styleInjected = false
function injectStyleOnce() {
  if (styleInjected) return
  styleInjected = true
  document.head.insertAdjacentHTML('beforeend', `<style>${STYLE}</style>`)
}

// ── State ───────────────────────────────────────────────────────────

type ChatEntry =
  | { kind: 'user' | 'assistant'; text: string }
  | { kind: 'tool'; text: string }
  | { kind: 'error'; text: string }
  | { kind: 'permission'; requestId: string; desc: string; resolved: string | null }
  | { kind: 'question'; requestId: string; question: string; choices: string[]; resolved: string | null }

const state = {
  screen: 'sessions' as 'sessions' | 'chat' | 'settings',
  sessions: [] as SessionSummary[],
  sessionsLoading: false,
  // 'known' = only sessions created/resumed via this relay (default, avoids
  // surfacing every local Copilot CLI session on the machine); 'all' is an
  // escape hatch to browse the full unscoped system-wide list.
  pickerScope: 'known' as 'known' | 'all',
  sessionId: null as string | null,
  sessionTitle: 'New session',
  entries: [] as ChatEntry[],
  lastMessageId: 0,
  busy: false,
  busySince: 0,
  pollTimer: undefined as ReturnType<typeof setInterval> | undefined,
  tickTimer: undefined as ReturnType<typeof setInterval> | undefined,
  settingsFirstRun: false,
}

let bridgeRef: EvenAppBridge

// Keeps #app's height/position pinned to the *visible* viewport (which
// shrinks when the on-screen keyboard opens) rather than the full window
// (which the WebView host does not resize behind the keyboard). Without
// this, the fixed input-bar/composer at the bottom of the chat screen sits
// underneath the keyboard instead of just above it. Layout viewport height
// (window.innerHeight) is left untouched — only this app root is resized,
// so nothing else needs to change.
let viewportHandlingInitialized = false
function setupKeyboardAvoidance() {
  if (viewportHandlingInitialized) return
  viewportHandlingInitialized = true
  const vv = window.visualViewport
  if (!vv) return // fall back to the CSS height:100% default on hosts without VisualViewport support
  const applyViewport = () => {
    const appEl = document.getElementById('app')
    if (!appEl) return
    appEl.style.height = `${vv.height}px`
    appEl.style.top = `${vv.offsetTop}px`
  }
  vv.addEventListener('resize', applyViewport)
  vv.addEventListener('scroll', applyViewport)
  applyViewport()
}

export async function renderPhoneApp(deps: PhoneAppDeps) {
  bridgeRef = deps.bridge
  injectStyleOnce()
  document.body.innerHTML = '<div id="app"></div>'
  setupKeyboardAvoidance()
  if (!isRelayConfigured()) {
    state.settingsFirstRun = true
    renderSettingsScreen()
    return
  }
  await showSessions()
}

function app(): HTMLElement {
  return document.getElementById('app')!
}

function stopTimers() {
  if (state.pollTimer) clearInterval(state.pollTimer)
  if (state.tickTimer) clearInterval(state.tickTimer)
  state.pollTimer = undefined
  state.tickTimer = undefined
}

// ── Sessions screen ───────────────────────────────────────────────

async function showSessions() {
  // Leaving a chat screen — let the relay release its live connection to
  // this session right away instead of waiting out its idle timeout, so we
  // don't keep holding a competing "driver" open against e.g. a terminal
  // session longer than we're actually looking at it from the phone.
  if (state.screen === 'chat' && state.sessionId) void releaseSession(state.sessionId)
  stopTimers()
  state.screen = 'sessions'
  state.sessionsLoading = true
  renderSessionsScreen()
  try {
    state.sessions = await listSessions(20, state.pickerScope)
  } catch {
    state.sessions = []
  }
  state.sessionsLoading = false
  renderSessionsScreen()
}

function relativeTime(iso: string | null): string {
  if (!iso) return ''
  const ms = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(ms / 60000)
  if (mins < 1) return 'Just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d ago`
  return new Date(iso).toLocaleDateString()
}

function renderSessionsScreen() {
  app().innerHTML = `
    <div class="navbar">
      <div class="navbar-side"></div>
      <div class="navbar-title">Copilot Terminal</div>
      <div class="navbar-side right">
        <button class="nav-btn icon" id="settingsBtn" title="Settings">⚙︎</button>
      </div>
    </div>
    <div class="content">
      <div class="list-section">
        <div class="list-group">
          <div class="new-session-btn" id="newSessionBtn">
            <span class="plus-badge">+</span>
            <span>New session</span>
          </div>
        </div>
      </div>
      <div class="list-section" id="sessionsSection"></div>
      <div class="scope-toggle-row">
        <button class="scope-toggle-btn" id="scopeToggleBtn">${
          state.pickerScope === 'known' ? 'Browse all sessions' : 'Show only my sessions'
        }</button>
      </div>
    </div>
  `
  document.getElementById('settingsBtn')!.addEventListener('click', () => {
    state.settingsFirstRun = false
    renderSettingsScreen()
  })
  document.getElementById('newSessionBtn')!.addEventListener('click', () => {
    void openSession(null, 'New session')
  })
  document.getElementById('scopeToggleBtn')!.addEventListener('click', () => {
    state.pickerScope = state.pickerScope === 'known' ? 'all' : 'known'
    void showSessions()
  })

  const section = document.getElementById('sessionsSection')!
  if (state.sessionsLoading) {
    section.innerHTML = `<div class="empty-state">Loading sessions…</div>`
    return
  }
  if (state.sessions.length === 0) {
    section.innerHTML = `<div class="empty-state">No sessions yet — start one above.</div>`
    return
  }
  section.innerHTML = `<div class="list-group">${state.sessions
    .map(
      (s, i) => `
        <div class="list-row" data-idx="${i}">
          <div class="list-row-text">
            <div class="list-row-title">${escapeHtml(s.title || '(untitled)')}</div>
            <div class="list-row-sub">${escapeHtml(relativeTime(s.timestamp))}</div>
          </div>
          <div class="chevron">›</div>
        </div>`
    )
    .join('')}</div>`
  section.querySelectorAll<HTMLElement>('.list-row').forEach((el) => {
    el.addEventListener('click', () => {
      const idx = Number(el.dataset.idx)
      const s = state.sessions[idx]
      if (s) void openSession(s.id, s.title || '(untitled)')
    })
  })
}

// ── Chat screen ───────────────────────────────────────────────────

async function openSession(sessionId: string | null, title: string) {
  stopTimers()
  state.screen = 'chat'
  state.sessionId = sessionId
  state.sessionTitle = title
  state.entries = []
  state.lastMessageId = 0
  state.busy = false
  renderChatScreen()
  if (sessionId) {
    try {
      const history = await getHistory(sessionId, 12)
      for (const turn of history) {
        state.entries.push({ kind: turn.role === 'user' ? 'user' : 'assistant', text: turn.text })
      }
      renderChatScreen()
    } catch {
      // best-effort context peek only
    }
    startPolling()
  }
  startTicking()
}

function startPolling() {
  if (state.pollTimer) clearInterval(state.pollTimer)
  state.pollTimer = setInterval(() => void pollOnce(), 1200)
}

function startTicking() {
  if (state.tickTimer) clearInterval(state.tickTimer)
  state.tickTimer = setInterval(() => {
    if (state.screen === 'chat' && state.busy) updateThinkingRow()
  }, 1000)
}

async function pollOnce() {
  if (!state.sessionId) return
  let data
  try {
    data = await getMessages(state.sessionId, state.lastMessageId)
  } catch {
    return
  }
  let changed = false
  for (const msg of data.messages) {
    state.lastMessageId = msg.id
    handleMessage(msg)
    changed = true
  }
  if (changed && state.screen === 'chat') renderChatScreen(true)
}

function handleMessage(msg: RelayMessage) {
  switch (msg.type) {
    case 'status':
      state.busy = msg.state === 'busy'
      if (state.busy) state.busySince = Date.now()
      break
    case 'assistant_message':
      if (msg.text) state.entries.push({ kind: 'assistant', text: msg.text })
      break
    case 'tool_start':
      if (msg.name) state.entries.push({ kind: 'tool', text: `${msg.name}…` })
      break
    case 'error':
      state.entries.push({ kind: 'error', text: msg.message ?? 'Unknown error' })
      break
    case 'permission_request': {
      const req = msg.request ?? {}
      const desc = req.intention || req.fullCommandText || `${req.kind ?? 'action'} request`
      state.entries.push({ kind: 'permission', requestId: msg.requestId, desc, resolved: null })
      break
    }
    case 'question':
      state.entries.push({
        kind: 'question',
        requestId: msg.requestId,
        question: msg.question ?? 'Question',
        choices: msg.choices ?? [],
        resolved: null,
      })
      break
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))
}

function entryHtml(e: ChatEntry, idx: number): string {
  switch (e.kind) {
    case 'user':
      return `<div class="bubble-row user"><div class="bubble user">${escapeHtml(e.text)}</div></div>`
    case 'assistant':
      return `<div class="bubble-row assistant"><div class="bubble assistant">${escapeHtml(e.text)}</div></div>`
    case 'tool':
      return `<div class="pill-row"><div class="pill">${escapeHtml(e.text)}</div></div>`
    case 'error':
      return `<div class="pill-row"><div class="pill error">${escapeHtml(e.text)}</div></div>`
    case 'permission':
      if (e.resolved) {
        return `<div class="action-card"><div class="prompt">${escapeHtml(e.desc)}</div><div class="resolved">${escapeHtml(e.resolved)}</div></div>`
      }
      return `
        <div class="action-card">
          <div class="prompt">Approve?\n${escapeHtml(e.desc)}</div>
          <div class="buttons">
            <button class="action-btn primary" data-perm="${idx}" data-decision="allow">Approve once</button>
            <button class="action-btn" data-perm="${idx}" data-decision="session">Approve for session</button>
            <button class="action-btn danger" data-perm="${idx}" data-decision="deny">Deny</button>
          </div>
        </div>`
    case 'question':
      if (e.resolved) {
        return `<div class="action-card"><div class="prompt">${escapeHtml(e.question)}</div><div class="resolved">${escapeHtml(e.resolved)}</div></div>`
      }
      return `
        <div class="action-card">
          <div class="prompt">${escapeHtml(e.question)}</div>
          <div class="buttons">
            ${e.choices.map((c) => `<button class="action-btn" data-question="${idx}" data-choice="${escapeHtml(c)}">${escapeHtml(c)}</button>`).join('')}
          </div>
          <div class="custom-answer">
            <input type="text" placeholder="Type your own answer…" data-custom-for="${idx}" />
            <button class="send-btn" data-custom-send="${idx}">↑</button>
          </div>
        </div>`
  }
}

function renderChatScreen(preserveScroll = false) {
  const prevScroll = preserveScroll ? document.querySelector('.content')?.scrollTop : undefined
  const prevScrollHeight = preserveScroll ? document.querySelector('.content')?.scrollHeight : undefined
  // Preserve whatever the user is mid-typing (value, cursor, focus) across a
  // rebuild — the 1.2s poll timer calls this whenever new messages arrive
  // (e.g. while Copilot is "thinking"), and without this the composer used
  // to get silently wiped/refocused-away every tick, making it look like
  // typed text wasn't showing up at all.
  const prevComposer = document.getElementById('composer') as HTMLTextAreaElement | null
  const hadFocus = !!prevComposer && document.activeElement === prevComposer
  const savedValue = prevComposer?.value ?? ''
  const savedSelStart = prevComposer?.selectionStart ?? null
  const savedSelEnd = prevComposer?.selectionEnd ?? null
  const savedHeight = prevComposer?.style.height
  app().innerHTML = `
    <div class="navbar">
      <div class="navbar-side">
        <button class="nav-btn" id="backBtn">‹ Sessions</button>
      </div>
      <div class="navbar-title">${escapeHtml(state.sessionTitle)}</div>
      <div class="navbar-side right">
        ${state.busy ? `<button class="nav-btn" id="stopBtn">Stop</button>` : ''}
      </div>
    </div>
    <div class="content">
      <div class="chat-scroll" id="chatScroll">
        ${state.entries.map((e, i) => entryHtml(e, i)).join('')}
      </div>
    </div>
    ${state.busy ? `<div class="thinking-row" id="thinkingRow" style="padding-left:16px">Copilot is thinking <span class="dot-flash"><span></span><span></span><span></span></span></div>` : ''}
    <div class="input-bar">
      <textarea id="composer" rows="1" placeholder="Message Copilot…"></textarea>
      <button class="send-btn" id="sendBtn">↑</button>
    </div>
  `
  document.getElementById('backBtn')!.addEventListener('click', () => {
    void showSessions()
  })
  const stopBtn = document.getElementById('stopBtn')
  stopBtn?.addEventListener('click', () => {
    if (state.sessionId) void interrupt(state.sessionId)
  })

  const composer = document.getElementById('composer') as HTMLTextAreaElement
  const sendBtn = document.getElementById('sendBtn') as HTMLButtonElement
  composer.value = savedValue
  if (savedHeight) composer.style.height = savedHeight
  if (hadFocus) {
    composer.focus()
    if (savedSelStart !== null && savedSelEnd !== null) composer.setSelectionRange(savedSelStart, savedSelEnd)
  }
  composer.addEventListener('input', () => {
    composer.style.height = 'auto'
    composer.style.height = `${Math.min(composer.scrollHeight, 120)}px`
  })
  // Defensive fallback alongside setupKeyboardAvoidance's visualViewport
  // handling: some Android WebViews fire the keyboard-open resize a beat
  // after focus, briefly leaving the composer under the keyboard. Scrolling
  // it into view on focus (once the keyboard has had a moment to animate
  // in) keeps it visible regardless of that timing.
  composer.addEventListener('focus', () => {
    setTimeout(() => composer.scrollIntoView({ block: 'end' }), 300)
  })
  composer.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && !ev.shiftKey) {
      ev.preventDefault()
      void sendMessage(composer.value)
    }
  })
  sendBtn.addEventListener('click', () => void sendMessage(composer.value))

  app()
    .querySelectorAll<HTMLButtonElement>('[data-perm]')
    .forEach((btn) => {
      btn.addEventListener('click', () => {
        void resolvePermission(Number(btn.dataset.perm), btn.dataset.decision as 'allow' | 'session' | 'deny')
      })
    })
  app()
    .querySelectorAll<HTMLButtonElement>('[data-question]')
    .forEach((btn) => {
      btn.addEventListener('click', () => {
        void resolveQuestion(Number(btn.dataset.question), btn.dataset.choice ?? '')
      })
    })
  app()
    .querySelectorAll<HTMLButtonElement>('[data-custom-send]')
    .forEach((btn) => {
      btn.addEventListener('click', () => {
        const idx = Number(btn.dataset.customSend)
        const input = app().querySelector<HTMLInputElement>(`[data-custom-for="${idx}"]`)
        if (input && input.value.trim()) void resolveQuestion(idx, input.value.trim())
      })
    })

  const scrollEl = document.getElementById('chatScroll')?.parentElement
  if (scrollEl) {
    if (preserveScroll && prevScroll !== undefined && prevScrollHeight !== undefined) {
      const wasNearBottom = prevScrollHeight - prevScroll - scrollEl.clientHeight < 80
      scrollEl.scrollTop = wasNearBottom ? scrollEl.scrollHeight : prevScroll
    } else {
      scrollEl.scrollTop = scrollEl.scrollHeight
    }
  }
}

function updateThinkingRow() {
  // Lightweight tick — the dot animation is pure CSS, so there is nothing to
  // update per-second right now, but this hook exists for a future elapsed-
  // time readout without re-rendering the whole transcript.
}

async function sendMessage(rawText: string) {
  const text = rawText.trim()
  if (!text) return
  const composer = document.getElementById('composer') as HTMLTextAreaElement | null
  if (composer) {
    composer.value = ''
    composer.style.height = 'auto'
  }
  state.entries.push({ kind: 'user', text })
  state.busy = true
  state.busySince = Date.now()
  renderChatScreen(true)
  try {
    const result = await sendPrompt(text, state.sessionId ?? undefined)
    if (state.sessionId !== result.sessionId) {
      state.sessionId = result.sessionId
      startPolling()
    }
  } catch (err: any) {
    state.busy = false
    state.entries.push({ kind: 'error', text: `Send failed: ${err.message}` })
    renderChatScreen(true)
  }
}

async function resolvePermission(idx: number, decision: 'allow' | 'session' | 'deny') {
  const e = state.entries[idx]
  if (!e || e.kind !== 'permission' || e.resolved || !state.sessionId) return
  e.resolved = decision === 'allow' ? 'Approved once' : decision === 'session' ? 'Approved for session' : 'Denied'
  renderChatScreen(true)
  await respondPermission(state.sessionId, e.requestId, decision)
}

async function resolveQuestion(idx: number, answer: string) {
  const e = state.entries[idx]
  if (!e || e.kind !== 'question' || e.resolved || !state.sessionId || !answer) return
  e.resolved = answer
  renderChatScreen(true)
  await respondQuestion(state.sessionId, e.requestId, answer)
}

// ── Settings screen ─────────────────────────────────────────────────

function renderSettingsScreen() {
  stopTimers()
  state.screen = 'settings'
  const firstRun = state.settingsFirstRun
  app().innerHTML = `
    <div class="navbar">
      <div class="navbar-side">
        ${firstRun ? '' : `<button class="nav-btn" id="settingsBackBtn">‹ Sessions</button>`}
      </div>
      <div class="navbar-title">Settings</div>
      <div class="navbar-side right"></div>
    </div>
    <div class="content">
      <div class="settings-screen">
        <p class="settings-intro">
          ${
            firstRun
              ? "Connect Copilot Terminal to the relay server running on your PC to get started."
              : 'Update the relay server connection.'
          }
        </p>
        <div class="field">
          <label for="relayUrl">Relay server URL</label>
          <input id="relayUrl" type="text" placeholder="http://192.168.1.42:4756" />
        </div>
        <div class="field">
          <label for="relayToken">Auth token (optional)</label>
          <input id="relayToken" type="text" placeholder="Only if RELAY_TOKEN is set on the server" />
        </div>
        <div class="settings-actions">
          <button class="btn secondary" id="testBtn" type="button">Test connection</button>
          <button class="btn primary" id="saveBtn" type="button">Save</button>
        </div>
        <div class="status-box" id="status"></div>
        <p class="note">
          The relay must run on your PC and be reachable from your phone (same
          Wi-Fi, or a Tailscale/VPN address). It also needs to match an entry
          in this app's network permission — if you enter an address that
          wasn't included when this app was packaged, connections will be
          blocked even though it's saved here.
        </p>
      </div>
    </div>
  `
  document.getElementById('settingsBackBtn')?.addEventListener('click', () => {
    void showSessions()
  })

  const urlInput = document.getElementById('relayUrl') as HTMLInputElement
  const tokenInput = document.getElementById('relayToken') as HTMLInputElement
  const statusEl = document.getElementById('status') as HTMLDivElement
  const saveBtn = document.getElementById('saveBtn') as HTMLButtonElement
  const testBtn = document.getElementById('testBtn') as HTMLButtonElement

  urlInput.value = getRelayUrl()
  tokenInput.value = getRelayToken()

  function setStatus(text: string, kind: '' | 'ok' | 'err' = '') {
    statusEl.textContent = text
    statusEl.className = `status-box ${kind}`.trim()
  }

  saveBtn.addEventListener('click', async () => {
    saveBtn.disabled = true
    try {
      await saveRelayConfig(bridgeRef, urlInput.value, tokenInput.value)
      setStatus('Saved.', 'ok')
      if (firstRun && isRelayConfigured()) {
        setTimeout(() => void showSessions(), 500)
      }
    } catch (err) {
      setStatus(`Failed to save: ${(err as Error).message}`, 'err')
    } finally {
      saveBtn.disabled = false
    }
  })

  testBtn.addEventListener('click', async () => {
    testBtn.disabled = true
    setStatus('Testing…')
    try {
      await saveRelayConfig(bridgeRef, urlInput.value, tokenInput.value)
      const ok = await checkHealth()
      setStatus(ok ? 'Relay reachable.' : 'Relay did not respond.', ok ? 'ok' : 'err')
      if (ok && firstRun) setTimeout(() => void showSessions(), 500)
    } catch (err) {
      setStatus(`Test failed: ${(err as Error).message}`, 'err')
    } finally {
      testBtn.disabled = false
    }
  })
}
