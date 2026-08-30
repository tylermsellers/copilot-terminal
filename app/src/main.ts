import {
  waitForEvenAppBridge,
  TextContainerProperty,
  ListContainerProperty,
  ListItemContainerProperty,
  CreateStartUpPageContainer,
  RebuildPageContainer,
  AudioInputSource,
  OsEventTypeList,
  type EvenHubEvent,
  type LaunchSource,
} from '@evenrealities/even_hub_sdk'
import { measureTextWrap } from '@evenrealities/pretext'
import {
  listSessions,
  sendPrompt,
  getMessages,
  respondPermission,
  respondQuestion,
  interrupt,
  getHistory,
  transcribe,
  loadRelayConfig,
  isRelayConfigured,
  type SessionSummary,
} from './api'
import { renderPhoneApp } from './phoneApp'

// Visible-first-paint placeholder + crash safety net. Real hardware showed a
// permanently blank white phone screen with no diagnostic available (no
// console access on-device) — this guarantees *something* renders
// immediately, and any uncaught error/rejection replaces it with the error
// text instead of silently leaving a blank screen.
document.body.innerHTML =
  '<div style="font-family:sans-serif;padding:20px;color:#666">Loading Copilot Terminal…</div>'
function showFatalError(err: unknown) {
  const message = err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err)
  document.body.innerHTML = `<pre style="font-family:monospace;padding:20px;color:#b3261e;white-space:pre-wrap;">Copilot Terminal failed to start:\n\n${message}</pre>`
}
window.addEventListener('error', (e) => showFatalError(e.error ?? e.message))
window.addEventListener('unhandledrejection', (e) => showFatalError(e.reason))

// ── Container IDs (reused across mutually-exclusive layouts) ──────

const TRANSCRIPT_ID = 1 // chat layout: scrolling log
const FOOTER_ID = 2 // chat layout: status/hint line, isEventCapture
const HEADER_ID = 3 // choice-style layouts: header/question text
const LIST_ID = 4 // choice-style layouts: selectable list, isEventCapture
const DRAFT_ID = 5 // voice-compose layout: transcribed draft text
const SEND_LIST_ID = 6 // voice-compose layout: Send/Cancel list, isEventCapture

// ── Layout geometry (pixel-accurate via @evenrealities/pretext) ───

const PAD = 6
const BORDER = 1
const INSET = PAD + BORDER
const INNER_W = 576 - 2 * INSET
const FOOTER_H = 27 + 2 * INSET // exactly one line
const TRANSCRIPT_H = 288 - FOOTER_H
const TRANSCRIPT_MAX_LINES = Math.floor((TRANSCRIPT_H - 2 * INSET) / 27)

type Mode = 'picker' | 'chat' | 'choice' | 'interrupt_confirm' | 'voice_compose'
type PendingChoice =
  | { kind: 'permission'; requestId: string }
  | { kind: 'question'; requestId: string; choices: string[] }
  | null
type VoiceTarget = { kind: 'prompt' } | { kind: 'question'; requestId: string }
type TranscriptEntry = { text: string; kind: 'assistant' | 'user' | 'tool' | 'error' }

const state = {
  mode: 'picker' as Mode,
  sessionId: null as string | null,
  lastMessageId: 0,
  pendingChoice: null as PendingChoice,
  busy: false,
  busySince: 0,
  recording: false,
  audioChunks: [] as Uint8Array[],
  // Timestamp recording actually started (audioControl confirmed) — used to
  // debounce a spurious near-instant second tap event (see onFooterTap).
  recordingStartedAt: 0,
  pickerSessions: [] as SessionSummary[],
  // Set when the picker is showing a fallback (connection error / setup-
  // required) screen with a single "Retry"-style choice, so onPickerSelect
  // knows to re-check/retry instead of treating the tap as "+ New session".
  pickerFallback: null as null | 'error' | 'setup',
  currentChoices: [] as string[],
  transcript: [] as TranscriptEntry[],
  // Count of newest transcript entries hidden below the current view when
  // the user has scrolled back to read older messages. 0 = live/auto-follow
  // the tail (default terminal behavior).
  transcriptScrollOffset: 0,
  // Restore point for the choice screen we came from, so voice-compose Cancel
  // can put the user back exactly where they were.
  choiceHeader: '',
  voiceOrigin: 'chat' as 'chat' | 'choice',
  voiceTarget: { kind: 'prompt' } as VoiceTarget,
  voiceDraft: '',
  pollTimer: undefined as ReturnType<typeof setInterval> | undefined,
  tickTimer: undefined as ReturnType<typeof setInterval> | undefined,
}

let bridge: Awaited<ReturnType<typeof waitForEvenAppBridge>>
try {
  bridge = await waitForEvenAppBridge()
} catch (err) {
  showFatalError(err)
  throw err
}

// Register onLaunchSource immediately — it fires exactly once, so this must
// happen before anything else can race it.
//
// IMPORTANT: unlike an earlier version of this code, we do NOT discard the
// real event if it arrives after a fallback timeout fires. A blank white
// phone screen was reported on real hardware from exactly that bug: if the
// real 'appMenu' event arrived after the timeout had already provisionally
// assumed 'glassesMenu' (which only makes bridge calls targeting the
// glasses, touching nothing in the phone WebView's DOM), the phone screen
// stayed blank forever because the late event was silently ignored. Instead,
// every time the source becomes known (provisionally or for real) we call
// bootFromSource(), and it re-runs harmlessly if called twice with the same
// answer, or corrects course if the real event contradicts the guess.
let sourceHandled = false
bridge.onLaunchSource((source) => {
  sourceHandled = true
  void bootFromSource(source)
})
setTimeout(() => {
  if (!sourceHandled) {
    // Simulator never fires onLaunchSource at all; real hardware timing is
    // unconfirmed. Assume the more common case (glasses) so testing/normal
    // use isn't stuck waiting — but leave the listener active so a late
    // real event can still correct this (see bootFromSource).
    void bootFromSource('glassesMenu')
  }
}, 1500)

// ── Container layout builders ────────────────────────────────────

function chatContainers(transcriptText: string, footerText: string) {
  return new CreateStartUpPageContainer({
    containerTotalNum: 2,
    textObject: [
      new TextContainerProperty({
        xPosition: 0,
        yPosition: 0,
        width: 576,
        height: TRANSCRIPT_H,
        borderWidth: BORDER,
        borderColor: 8,
        paddingLength: PAD,
        containerID: TRANSCRIPT_ID,
        containerName: 'transcript',
        content: transcriptText,
        // Event capture lives here (not on the footer) so scroll gestures
        // (SCROLL_TOP_EVENT/SCROLL_BOTTOM_EVENT) target the transcript and
        // can page through history — only one container per page may
        // capture events, so tap-to-record is also routed through here.
        isEventCapture: 1,
      }),
      new TextContainerProperty({
        xPosition: 0,
        yPosition: TRANSCRIPT_H,
        width: 576,
        height: FOOTER_H,
        borderWidth: BORDER,
        borderColor: 8,
        paddingLength: PAD,
        containerID: FOOTER_ID,
        containerName: 'footer',
        content: footerText,
        isEventCapture: 0,
      }),
    ],
  })
}

function choiceContainers(header: string, choices: string[]) {
  return new CreateStartUpPageContainer({
    containerTotalNum: 2,
    textObject: [
      new TextContainerProperty({
        xPosition: 0,
        yPosition: 0,
        width: 576,
        height: 96,
        borderWidth: 0,
        paddingLength: 8,
        containerID: HEADER_ID,
        containerName: 'header',
        content: header,
        isEventCapture: 0,
      }),
    ],
    listObject: [
      new ListContainerProperty({
        xPosition: 0,
        yPosition: 96,
        width: 576,
        height: 192,
        borderWidth: 0,
        containerID: LIST_ID,
        containerName: 'choices',
        isEventCapture: 1,
        itemContainer: new ListItemContainerProperty({
          itemCount: choices.length,
          itemWidth: 0,
          isItemSelectBorderEn: 1,
          itemName: choices,
        }),
      }),
    ],
  })
}

function voiceComposeContainers(draft: string) {
  return new CreateStartUpPageContainer({
    containerTotalNum: 2,
    textObject: [
      new TextContainerProperty({
        xPosition: 0,
        yPosition: 0,
        width: 576,
        height: 188,
        borderWidth: BORDER,
        borderColor: 8,
        paddingLength: PAD,
        containerID: DRAFT_ID,
        containerName: 'draft',
        content: draft,
        isEventCapture: 0,
      }),
    ],
    listObject: [
      new ListContainerProperty({
        xPosition: 0,
        yPosition: 188,
        width: 576,
        height: 100,
        borderWidth: 0,
        containerID: SEND_LIST_ID,
        containerName: 'sendCancel',
        isEventCapture: 1,
        itemContainer: new ListItemContainerProperty({
          itemCount: 2,
          itemWidth: 0,
          isItemSelectBorderEn: 1,
          itemName: ['Send', 'Cancel'],
        }),
      }),
    ],
  })
}

let started = false
async function rebuild(payload: CreateStartUpPageContainer) {
  if (!started) {
    await bridge.createStartUpPageContainer(payload)
    started = true
  } else {
    await bridge.rebuildPageContainer(payload as unknown as RebuildPageContainer)
  }
}

// ── Chat rendering (transcript + ticking footer) ──────────────────

function entryDisplayText(e: TranscriptEntry): string {
  switch (e.kind) {
    case 'tool':
      return `> ${e.text}`
    case 'user':
      return `» ${e.text}`
    case 'error':
      return `! ${e.text}`
    default:
      return e.text
  }
}

// Keep only as many trailing transcript entries as fit TRANSCRIPT_MAX_LINES,
// using pixel-accurate wrapping so the log behaves like an auto-scrolling
// terminal (oldest lines fall off the top). `transcriptScrollOffset` hides
// that many of the newest entries first, so scrolling back pages through
// older history without disturbing what's currently on screen when new
// messages arrive while scrolled back.
function renderTranscriptText(): string {
  const visible =
    state.transcriptScrollOffset > 0
      ? state.transcript.slice(0, Math.max(0, state.transcript.length - state.transcriptScrollOffset))
      : state.transcript
  const kept: string[] = []
  let lines = 0
  for (let i = visible.length - 1; i >= 0; i--) {
    const display = entryDisplayText(visible[i])
    const wrapped = measureTextWrap(display, INNER_W).lineCount
    if (lines + wrapped > TRANSCRIPT_MAX_LINES && kept.length > 0) break
    kept.unshift(display)
    lines += wrapped
    if (lines >= TRANSCRIPT_MAX_LINES) break
  }
  return kept.join('\n')
}

function footerText(): string {
  if (state.busy) {
    const elapsed = Math.max(0, Math.floor((Date.now() - state.busySince) / 1000))
    return `Thinking… ${elapsed}s`
  }
  if (state.recording) return 'Recording… ● stop'
  if (state.transcriptScrollOffset > 0) return '▲ scrolled back — scroll down for latest'
  return '● record   ●● sessions   ▲▼ scroll'
}

async function renderChat(fullRebuild = false) {
  state.mode = 'chat'
  if (fullRebuild || !started) {
    await rebuild(chatContainers(renderTranscriptText(), footerText()))
  } else {
    await bridge.textContainerUpgrade({
      containerID: TRANSCRIPT_ID,
      content: renderTranscriptText(),
      contentOffset: 0,
      contentLength: 2000,
    } as any)
    await bridge.textContainerUpgrade({
      containerID: FOOTER_ID,
      content: footerText(),
      contentOffset: 0,
      contentLength: 2000,
    } as any)
  }
}

function startTicking() {
  stopTicking()
  state.tickTimer = setInterval(() => {
    if (state.mode === 'chat' && state.busy) void renderChat()
  }, 1000)
}

function stopTicking() {
  if (state.tickTimer) {
    clearInterval(state.tickTimer)
    state.tickTimer = undefined
  }
}

async function showChoices(header: string, choices: string[]) {
  state.mode = 'choice'
  state.currentChoices = choices
  state.choiceHeader = header
  await rebuild(choiceContainers(header, choices))
}

// ── Session picker ────────────────────────────────────────────────

async function showSessionPicker() {
  stopPolling()
  stopTicking()
  state.mode = 'picker'
  await rebuild(choiceContainers('Loading sessions…', ['Please wait…']))
  let sessions: SessionSummary[] = []
  try {
    sessions = await listSessions(8)
  } catch (err: any) {
    state.pickerFallback = 'error'
    await rebuild(choiceContainers(`Can't reach relay:\n${err.message}`, ['Retry']))
    state.mode = 'picker'
    return
  }
  state.pickerFallback = null
  state.pickerSessions = sessions
  state.pendingChoice = null
  const choices = ['+ New session', ...sessions.map((s) => s.title || '(untitled)')]
  await showChoices('Pick a session:\ntap = open   double-tap = exit', choices)
  state.mode = 'picker' // showChoices defaults to 'choice'; override since this is the session picker
}

// Shown on the glasses when no relay has ever been configured yet — rather
// than silently guessing an address, this is a hard gate: the user must
// open the app from the phone's Even Hub menu (not the glasses) to enter
// their relay URL first, since the G2/R1 touchpad has no keyboard input.
async function showSetupRequired() {
  stopPolling()
  stopTicking()
  state.mode = 'picker'
  state.pickerFallback = 'setup'
  await rebuild(
    choiceContainers('Setup required:\nOpen this app from your\nphone menu to connect', ['Retry'])
  )
  state.mode = 'picker'
}

async function onPickerSelect(index: number) {
  if (state.pickerFallback === 'setup') {
    if (isRelayConfigured()) {
      state.pickerFallback = null
      await showSessionPicker()
    } else {
      await showSetupRequired()
    }
    return
  }
  if (state.pickerFallback === 'error') {
    await showSessionPicker()
    return
  }
  if (index <= 0) {
    state.sessionId = null
    await startChat()
    return
  }
  const chosen = state.pickerSessions[index - 1]
  state.sessionId = chosen?.id ?? null
  await startChat()
}

// ── Chat ──────────────────────────────────────────────────────────

// Races a promise against a hard deadline so a stalled server call (e.g. an
// unresponsive resumeSession/getEvents round trip) can never leave the UI
// stuck — the picker "tap does nothing" bug traced to an un-timed-out
// getHistory() call for existing sessions (new sessions skip it entirely,
// which is why only *existing* sessions appeared to hang).
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error('timeout')), ms)),
  ])
}

async function startChat() {
  state.lastMessageId = 0
  state.transcript = []
  state.transcriptScrollOffset = 0
  state.busy = false
  // Render immediately so a tap always produces instant visual feedback,
  // even before the optional history fetch below resolves (or times out).
  await renderChat(true)
  if (state.sessionId) {
    try {
      const history = await withTimeout(getHistory(state.sessionId, 6), 4000)
      for (const turn of history) {
        state.transcript.push({ text: turn.text, kind: turn.role === 'user' ? 'user' : 'assistant' })
      }
      // Use the in-place text-update path (not another full rebuild) here —
      // the containers already exist from the render above, and issuing a
      // second full createStartUpPageContainer/rebuildPageContainer within
      // ~1-2s of the first appears to race on real hardware, leaving the
      // glasses stuck showing the first (empty) paint even though this
      // promise resolves. textContainerUpgrade is the lighter, serial-safe
      // update path the SDK provides for exactly this case.
      await renderChat(false)
    } catch {
      // best-effort context peek only; fine if it fails or times out
    }
  }
  startTicking()
  if (state.sessionId) startPolling()
}

function stopPolling() {
  if (state.pollTimer) {
    clearInterval(state.pollTimer)
    state.pollTimer = undefined
  }
}

function startPolling() {
  stopPolling()
  state.pollTimer = setInterval(() => {
    void pollOnce()
  }, 1500)
}

async function pollOnce() {
  if (!state.sessionId) return
  let data
  try {
    data = await getMessages(state.sessionId, state.lastMessageId)
  } catch {
    return // transient network hiccup, retry next tick
  }
  for (const msg of data.messages) {
    state.lastMessageId = msg.id
    await handleMessage(msg)
  }
}

async function handleMessage(msg: any) {
  switch (msg.type) {
    case 'status':
      state.busy = msg.state === 'busy'
      if (state.busy) state.busySince = Date.now()
      if (state.mode === 'chat') await renderChat()
      break
    case 'assistant_message':
      if (msg.text) {
        state.transcript.push({ text: msg.text, kind: 'assistant' })
        if (state.mode === 'chat') await renderChat()
      }
      break
    case 'tool_start':
      if (msg.name) {
        state.transcript.push({ text: `${msg.name}…`, kind: 'tool' })
        if (state.mode === 'chat') await renderChat()
      }
      break
    case 'error':
      state.transcript.push({ text: msg.message ?? 'Unknown error', kind: 'error' })
      if (state.mode === 'chat') await renderChat()
      break
    case 'permission_request': {
      const req = msg.request ?? {}
      const desc = req.intention || req.fullCommandText || `${req.kind ?? 'action'} request`
      state.pendingChoice = { kind: 'permission', requestId: msg.requestId }
      await showChoices(`Approve?\n${desc}`, ['Approve once', 'Approve for session', 'Deny'])
      break
    }
    case 'question': {
      const choices: string[] = Array.isArray(msg.choices) && msg.choices.length ? msg.choices : []
      state.pendingChoice = { kind: 'question', requestId: msg.requestId, choices }
      await showChoices(msg.question ?? 'Copilot is asking:', [...choices, 'Speak custom answer'])
      break
    }
    default:
      break // user_prompt handled locally already
  }
}

// ── Choice resolution (picker, permission, question) ──────────────

async function onChoiceSelect(index: number) {
  const label = state.currentChoices[index] ?? ''
  const pending = state.pendingChoice
  if (!pending || !state.sessionId) return

  if (pending.kind === 'permission') {
    const decision = label === 'Approve once' ? 'allow' : label === 'Approve for session' ? 'session' : 'deny'
    state.pendingChoice = null
    state.busy = true
    state.busySince = Date.now()
    await renderChat(true)
    startTicking()
    await respondPermission(state.sessionId, pending.requestId, decision as any)
    startPolling()
    return
  }

  if (label === 'Speak custom answer') {
    state.voiceOrigin = 'choice'
    state.voiceTarget = { kind: 'question', requestId: pending.requestId }
    await beginRecording()
    return
  }

  state.pendingChoice = null
  state.busy = true
  state.busySince = Date.now()
  await renderChat(true)
  startTicking()
  await respondQuestion(state.sessionId, pending.requestId, label)
  startPolling()
}

// ── Interrupt confirm ───────────────────────────────────────────

async function onFooterTap() {
  // Any tap on the chat screen returns the view to live (in case the user
  // was scrolled back reading history) before acting on the tap itself.
  state.transcriptScrollOffset = 0
  if (state.busy) {
    await showChoices('Stop agent response?', ['Yes', 'Cancel'])
    state.mode = 'interrupt_confirm'
    return
  }
  if (!state.recording) {
    state.voiceOrigin = 'chat'
    state.voiceTarget = { kind: 'prompt' }
    await beginRecording()
  } else {
    // Touch hardware can report a single physical tap as two raw events in
    // quick succession (press + release). Since a tap on this same
    // full-screen container both starts AND stops recording, a spurious
    // second event arriving within a moment of starting would immediately
    // stop recording again before any audio has streamed, always sending
    // zero bytes. Ignore a "stop" this soon after "start" — real usage
    // always takes at least this long to actually say something.
    const MIN_RECORDING_MS = 600
    if (Date.now() - state.recordingStartedAt < MIN_RECORDING_MS) return
    await stopRecordingAndSend()
  }
}

async function onInterruptConfirmSelect(index: number) {
  const label = state.currentChoices[index] ?? ''
  if (label === 'Yes' && state.sessionId) {
    await interrupt(state.sessionId)
  }
  await renderChat(true)
  startPolling()
}

// ── Voice capture + compose/confirm ────────────────────────────────

async function beginRecording() {
  state.audioChunks = []
  state.recording = true
  state.recordingStartedAt = Date.now()
  await renderChat()
  const ok = await bridge.audioControl(true, AudioInputSource.Glasses)
  if (!ok) {
    // Mic genuinely failed to start (permission not granted, already in
    // use, etc.) — without this check the UI kept showing "Recording…"
    // while capturing zero audio, surfacing later as a confusing "missing
    // audio body" error on stop instead of a clear failure up front.
    state.recording = false
    state.transcript.push({
      text: 'Mic failed to start — check microphone permission for this app on your phone.',
      kind: 'error',
    })
    await renderChat(true)
  }
}

async function stopRecordingAndSend() {
  state.recording = false
  await bridge.audioControl(false)
  await renderChat()

  const total = state.audioChunks.reduce((n, c) => n + c.length, 0)
  const combined = new Uint8Array(total)
  let offset = 0
  for (const c of state.audioChunks) {
    combined.set(c, offset)
    offset += c.length
  }
  state.audioChunks = []

  if (total === 0) {
    // Fail fast client-side instead of round-tripping an empty body to the
    // relay, which only reports the generic "Missing audio body" — this is
    // almost always a mic-permission/start failure, not a network issue.
    // Include the recording duration so a persistent failure here points
    // at an actual streaming problem (e.g. firmware not delivering
    // audioEvent at all) rather than a too-quick stop.
    const heldMs = Date.now() - state.recordingStartedAt
    state.transcript.push({
      text: `No audio captured (held ${heldMs}ms, 0 chunks) — check mic permission, or the glasses may not be streaming audio.`,
      kind: 'error',
    })
    await renderChat(true)
    return
  }

  let text = ''
  try {
    text = await transcribe(combined, 16000)
  } catch (err: any) {
    state.transcript.push({ text: `Transcription failed: ${err.message}`, kind: 'error' })
    await renderChat(true)
    return
  }
  if (!text.trim()) {
    state.transcript.push({ text: '(heard nothing) — ● to try again', kind: 'error' })
    await renderChat(true)
    return
  }

  state.voiceDraft = text
  state.mode = 'voice_compose'
  await rebuild(voiceComposeContainers(text))
}

async function onVoiceComposeSelect(index: number) {
  const label = index === 0 ? 'Send' : 'Cancel'
  if (label === 'Cancel') {
    if (state.voiceOrigin === 'choice' && state.pendingChoice) {
      await showChoices(state.choiceHeader, state.currentChoices)
    } else {
      await renderChat(true)
      startPolling()
    }
    return
  }

  const text = state.voiceDraft
  if (state.voiceTarget.kind === 'question' && state.pendingChoice && state.sessionId) {
    state.pendingChoice = null
    state.busy = true
    state.busySince = Date.now()
    await renderChat(true)
    startTicking()
    await respondQuestion(state.sessionId, state.voiceTarget.requestId, text)
    startPolling()
    return
  }

  state.transcript.push({ text, kind: 'user' })
  // Show "Thinking…" immediately rather than waiting up to 1.5s for the
  // next poll tick to report a busy status from the server.
  state.busy = true
  state.busySince = Date.now()
  await renderChat(true)
  startTicking()
  try {
    const result = await sendPrompt(text, state.sessionId ?? undefined)
    state.sessionId = result.sessionId
    startPolling()
  } catch (err: any) {
    state.busy = false
    state.transcript.push({ text: `Send failed: ${err.message}`, kind: 'error' })
    await renderChat()
  }
}

// ── Event wiring ──────────────────────────────────────────────────

bridge.onEvenHubEvent((event: EvenHubEvent) => {
  void handleEvent(event)
})

async function handleEvent(event: EvenHubEvent) {
  const text = event.textEvent
  const list = event.listEvent
  const sys = event.sysEvent
  const audio = event.audioEvent

  if (audio && state.recording) {
    state.audioChunks.push(audio.audioPcm)
    return
  }

  // Double-tap (eventType 3) is a raw sysEvent regardless of which
  // container currently holds isEventCapture — confirmed against the Even
  // Hub simulator, since it fired identically while a list container (the
  // picker) was active. On the home/picker screen, double-tap uses the
  // SDK's standard exit-app flow (confirmation dialog) rather than any
  // app-specific navigation.
  const eventType = sys?.eventType ?? text?.eventType
  if (eventType === OsEventTypeList.DOUBLE_CLICK_EVENT) {
    if (state.mode === 'picker') {
      await bridge.shutDownPageContainer(1)
      return
    }
    if (state.mode === 'chat') {
      await showSessionPicker()
      return
    }
  }

  // A full-screen single text container reports taps as a raw sysEvent
  // (touchpad touch), not a textEvent — confirmed against the Even Hub
  // simulator. Missing eventType means a plain single tap, but this
  // container also receives scroll gestures (SCROLL_TOP_EVENT /
  // SCROLL_BOTTOM_EVENT) — page through transcript history on those
  // instead of treating them as a tap (which previously misfired as
  // toggling voice recording, seen as a spurious "missing audio body"
  // transcription failure when the untouched mic was immediately stopped).
  if (state.mode === 'chat' && (sys || text)) {
    if (eventType === OsEventTypeList.SCROLL_TOP_EVENT) {
      const maxOffset = Math.max(0, state.transcript.length - 1)
      state.transcriptScrollOffset = Math.min(maxOffset, state.transcriptScrollOffset + 3)
      await renderChat(false)
      return
    }
    if (eventType === OsEventTypeList.SCROLL_BOTTOM_EVENT) {
      state.transcriptScrollOffset = Math.max(0, state.transcriptScrollOffset - 3)
      await renderChat(false)
      return
    }
    if (eventType === undefined || eventType === OsEventTypeList.CLICK_EVENT) {
      await onFooterTap()
      return
    }
    // Any other lifecycle sysEvent (foreground enter/exit, IMU, etc.) on
    // this container is not something the chat screen reacts to.
    return
  }

  if (list) {
    // Simulator (and possibly real hardware) omits currentSelectItemIndex
    // when the default/first item is clicked without any prior scroll —
    // treat that as index 0 rather than silently ignoring the click.
    const index = typeof list.currentSelectItemIndex === 'number' ? list.currentSelectItemIndex : 0
    if (list.containerID === LIST_ID) {
      if (state.mode === 'picker') await onPickerSelect(index)
      else if (state.mode === 'interrupt_confirm') await onInterruptConfirmSelect(index)
      else if (state.mode === 'choice') await onChoiceSelect(index)
    } else if (list.containerID === SEND_LIST_ID && state.mode === 'voice_compose') {
      await onVoiceComposeSelect(index)
    }
  }
}

// ── Boot ────────────────────────────────────────────────────────

// Called whenever the launch source becomes known — once provisionally (the
// 1500ms fallback timeout above) and, if that guess was wrong, again for
// real once the actual onLaunchSource event arrives. Idempotent against
// being called twice with the same answer.
let bootedAs: LaunchSource | null = null
async function bootFromSource(source: LaunchSource) {
  if (bootedAs === source) return
  bootedAs = source
  // Always reload any previously-saved relay config, regardless of launch
  // source, so a relay URL set from the phone settings screen applies to
  // the glasses UI too.
  await loadRelayConfig(bridge)
  if (source === 'appMenu') {
    // Opened from the Even App's own plugin menu (on the phone screen, not
    // the glasses) — render the full phone-side app (session list, chat
    // with keyboard input, settings) instead of the glasses' pixel-
    // container UI. This is also the only place a user can type free text,
    // since the G2/R1 touchpad has no keyboard input at all.
    await renderPhoneApp({ bridge })
  } else if (!isRelayConfigured()) {
    // Launched to the glasses but no relay URL has ever been saved — don't
    // silently guess an address (there is no safe universal default across
    // users/forks). Require the phone-side setup step first.
    await showSetupRequired()
  } else {
    await showSessionPicker()
  }
}

