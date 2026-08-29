// Phone-side settings screen — rendered inside the Even App's own Flutter
// WebView (not on the glasses) when the app is launched from the phone's
// plugin menu rather than from the glasses. This is the only place a user
// can type free text: the G2/R1 touchpad has no keyboard at all, so any
// setup that needs typing (the relay server's LAN URL, an optional auth
// token) has to happen here instead.
//
// Colors/spacing follow the Even Hub phone-side design tokens (see the
// design-guidelines skill) so this feels native inside Even Hub, distinct
// from the glasses' monochrome-green display.

import type { EvenAppBridge } from '@evenrealities/even_hub_sdk'

interface Deps {
  bridge: EvenAppBridge
  getRelayUrl: () => string
  getRelayToken: () => string
  saveRelayConfig: (bridge: EvenAppBridge, url: string, token: string) => Promise<void>
  checkHealth: () => Promise<boolean>
}

const STYLE = `
  :root {
    --color-text: #232323;
    --color-text-dim: #7B7B7B;
    --color-bg: #FFFFFF;
    --color-surface: #EEEEEE;
    --color-input-bg: rgba(35,35,35,0.08);
    --color-accent: #FEF991;
    --color-text-on-accent: #232323;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: var(--color-bg);
    color: var(--color-text);
    font-family: 'FK Grotesk Neue', system-ui, -apple-system, sans-serif;
    letter-spacing: -0.01em;
  }
  .screen { padding: 20px; max-width: 480px; margin: 0 auto; }
  h1 {
    font-size: 24px;
    font-weight: 600;
    letter-spacing: -0.02em;
    margin: 0 0 4px;
  }
  p.subtitle {
    font-size: 16px;
    color: var(--color-text-dim);
    margin: 0 0 24px;
  }
  label {
    display: block;
    font-size: 11px;
    font-weight: 500;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--color-text-dim);
    margin: 0 0 6px;
  }
  .field { margin-bottom: 16px; }
  input {
    width: 100%;
    padding: 12px;
    border-radius: 8px;
    border: none;
    background: var(--color-input-bg);
    color: var(--color-text);
    font-size: 16px;
    font-family: inherit;
  }
  input:focus { outline: 2px solid var(--color-accent); }
  .actions { display: flex; gap: 12px; margin-top: 24px; }
  button {
    flex: 1;
    padding: 12px 16px;
    border-radius: 8px;
    border: none;
    font-size: 16px;
    font-weight: 600;
    font-family: inherit;
    cursor: pointer;
  }
  button.primary { background: var(--color-accent); color: var(--color-text-on-accent); }
  button.secondary { background: var(--color-surface); color: var(--color-text); }
  button:disabled { opacity: 0.5; cursor: default; }
  .status {
    margin-top: 16px;
    padding: 12px 16px;
    border-radius: 8px;
    background: var(--color-surface);
    font-size: 13px;
    color: var(--color-text-dim);
    min-height: 1.4em;
  }
  .status.ok { color: #1a7a3a; }
  .status.err { color: #b3261e; }
  .note {
    margin-top: 24px;
    font-size: 13px;
    color: var(--color-text-dim);
    line-height: 1.5;
  }
`

export function renderPhoneSettings(deps: Deps) {
  const { bridge, getRelayUrl, getRelayToken, saveRelayConfig, checkHealth } = deps

  document.head.insertAdjacentHTML('beforeend', `<style>${STYLE}</style>`)
  document.body.innerHTML = `
    <div class="screen">
      <h1>Copilot Terminal</h1>
      <p class="subtitle">Connect the glasses app to your relay server.</p>

      <div class="field">
        <label for="relayUrl">Relay server URL</label>
        <input id="relayUrl" type="text" placeholder="http://192.168.1.42:4756" />
      </div>

      <div class="field">
        <label for="relayToken">Auth token (optional)</label>
        <input id="relayToken" type="text" placeholder="Only if RELAY_TOKEN is set on the server" />
      </div>

      <div class="actions">
        <button class="secondary" id="testBtn" type="button">Test connection</button>
        <button class="primary" id="saveBtn" type="button">Save</button>
      </div>

      <div class="status" id="status"></div>

      <p class="note">
        The relay must run on your PC and be reachable from your phone (same
        Wi-Fi, or a Tailscale/VPN address). It also needs to match an entry
        in this app's network permission — if you enter an address that
        wasn't included when this app was packaged, connections will be
        blocked even though it's saved here. Contact the developer to
        repack the app if your relay's address changes to a new network.
      </p>
    </div>
  `

  const urlInput = document.getElementById('relayUrl') as HTMLInputElement
  const tokenInput = document.getElementById('relayToken') as HTMLInputElement
  const statusEl = document.getElementById('status') as HTMLDivElement
  const saveBtn = document.getElementById('saveBtn') as HTMLButtonElement
  const testBtn = document.getElementById('testBtn') as HTMLButtonElement

  urlInput.value = getRelayUrl()
  tokenInput.value = getRelayToken()

  function setStatus(text: string, kind: '' | 'ok' | 'err' = '') {
    statusEl.textContent = text
    statusEl.className = `status ${kind}`.trim()
  }

  saveBtn.addEventListener('click', async () => {
    saveBtn.disabled = true
    try {
      await saveRelayConfig(bridge, urlInput.value, tokenInput.value)
      setStatus('Saved. The glasses app will use this on next launch.', 'ok')
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
      // Test against whatever is currently in the field, not just the last-saved value.
      await saveRelayConfig(bridge, urlInput.value, tokenInput.value)
      const ok = await checkHealth()
      setStatus(ok ? 'Relay reachable.' : 'Relay did not respond.', ok ? 'ok' : 'err')
    } catch (err) {
      setStatus(`Test failed: ${(err as Error).message}`, 'err')
    } finally {
      testBtn.disabled = false
    }
  })
}
