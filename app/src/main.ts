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
  saveRelayConfig,
  getRelayUrl,
  getRelayToken,
  checkHealth,
  type SessionSummary,
} from './api'
import { renderPhoneSettings } from './phoneSettings'

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
  pickerSessions: [] as SessionSummary[],
  currentChoices: [] as string[],
  transcript: [] as TranscriptEntry[],
  // Restore point for the choice screen we came from, so voice-compose Cancel
  // can put the user back exactly where they were.
  choiceHeader: '',
  voiceOrigin: 'chat' as 'chat' | 'choice',
  voiceTarget: { kind: 'prompt' } as VoiceTarget,
  voiceDraft: '',
  pollTimer: undefined as ReturnType<typeof setInterval> | undefined,
  tickTimer: undefined as ReturnType<typeof setInterval> | undefined,
}

const bridge = await waitForEvenAppBridge()

// Register onLaunchSource immediately — it fires exactly once, so this must
// happen before anything else can race it. Wrapped in a promise (with a
// short timeout fallback to 'glassesMenu') so boot logic below can await it.
const launchSourcePromise = new Promise<LaunchSource>((resolve) => {
  const unsub = bridge.onLaunchSource((source) => {
    unsub()
    resolve(source)
  })
  setTimeout(() => resolve('glassesMenu'), 1500)
})

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
        isEventCapture: 0,
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
        isEventCapture: 1,
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
// terminal (oldest lines fall off the top).
function renderTranscriptText(): string {
  const kept: string[] = []
  let lines = 0
  for (let i = state.transcript.length - 1; i >= 0; i--) {
    const display = entryDisplayText(state.transcript[i])
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
  return '● record   ●● sessions'
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
    await rebuild(choiceContainers(`Can't reach relay:\n${err.message}`, ['Retry']))
    state.mode = 'picker'
    return
  }
  state.pickerSessions = sessions
  state.pendingChoice = null
  const choices = ['+ New session', ...sessions.map((s) => s.title || '(untitled)')]
  await showChoices('Pick a session (or start new):', choices)
  state.mode = 'picker' // showChoices defaults to 'choice'; override since this is the session picker
}

async function onPickerSelect(index: number) {
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

async function startChat() {
  state.lastMessageId = 0
  state.transcript = []
  state.busy = false
  if (state.sessionId) {
    try {
      const history = await getHistory(state.sessionId, 6)
      for (const turn of history) {
        state.transcript.push({ text: turn.text, kind: turn.role === 'user' ? 'user' : 'assistant' })
      }
    } catch {
      // best-effort context peek only; fine if it fails
    }
  }
  await renderChat(true)
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
    await respondPermission(state.sessionId, pending.requestId, decision as any)
    state.pendingChoice = null
    await renderChat(true)
    startPolling()
    return
  }

  if (label === 'Speak custom answer') {
    state.voiceOrigin = 'choice'
    state.voiceTarget = { kind: 'question', requestId: pending.requestId }
    await beginRecording()
    return
  }

  await respondQuestion(state.sessionId, pending.requestId, label)
  state.pendingChoice = null
  await renderChat(true)
  startPolling()
}

// ── Interrupt confirm ───────────────────────────────────────────

async function onFooterTap() {
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
  await renderChat()
  await bridge.audioControl(true, AudioInputSource.Glasses)
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
    await respondQuestion(state.sessionId, state.voiceTarget.requestId, text)
    state.pendingChoice = null
    await renderChat(true)
    startPolling()
    return
  }

  state.transcript.push({ text, kind: 'user' })
  await renderChat(true)
  try {
    const result = await sendPrompt(text, state.sessionId ?? undefined)
    state.sessionId = result.sessionId
    startPolling()
  } catch (err: any) {
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
  // simulator. Missing eventType means a plain single tap.
  if (state.mode === 'chat' && (sys || text)) {
    await onFooterTap()
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

// Always load any previously-saved relay config first, regardless of launch
// source, so a relay URL set from the phone settings screen applies to the
// glasses UI too.
await loadRelayConfig(bridge)

const launchSource = await launchSourcePromise
if (launchSource === 'appMenu') {
  // Opened from the Even App's own plugin menu (on the phone screen, not
  // the glasses) — render a normal HTML/CSS settings form instead of the
  // glasses' pixel-container UI. This is the only place a user can type
  // free text, since the G2/R1 touchpad has no keyboard input at all.
  renderPhoneSettings({
    bridge,
    getRelayUrl,
    getRelayToken,
    saveRelayConfig,
    checkHealth,
  })
} else {
  await showSessionPicker()
}

