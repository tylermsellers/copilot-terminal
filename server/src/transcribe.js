// Dispatches speech-to-text to whichever provider is configured. Anthropic
// is intentionally not offered here — Claude's API does not currently
// accept audio input, so it can't do STT.
//
// Provider selection:
//   - STT_PROVIDER=azure|openai|gemini pins the provider explicitly.
//   - Otherwise, the first provider with credentials present is used
//     (checked in this order: azure, openai, gemini).

import * as azure from "./stt/azure.js";
import * as openai from "./stt/openai.js";
import * as gemini from "./stt/gemini.js";

const PROVIDERS = { azure, openai, gemini };
const ORDER = ["azure", "openai", "gemini"];

function pickProvider() {
  const forced = process.env.STT_PROVIDER?.toLowerCase();
  if (forced) {
    const mod = PROVIDERS[forced];
    if (!mod) throw new Error(`Unknown STT_PROVIDER "${forced}" (expected azure, openai, or gemini)`);
    return { name: forced, mod };
  }
  const name = ORDER.find((n) => PROVIDERS[n].configured());
  if (!name) return null;
  return { name, mod: PROVIDERS[name] };
}

export function activeProviderName() {
  return pickProvider()?.name ?? null;
}

export function anyProviderConfigured() {
  return ORDER.some((n) => PROVIDERS[n].configured());
}

/**
 * Transcribe raw 16-bit PCM mono audio (as delivered by the G2's AudioEventPayload,
 * or already-WAV audio) using whichever STT provider is configured.
 * @param {Buffer} audioBuffer
 * @param {{sampleRate?: number, alreadyWav?: boolean, language?: string}} opts
 */
export async function transcribePcm(audioBuffer, opts = {}) {
  const picked = pickProvider();
  if (!picked) {
    throw new Error(
      "No speech-to-text provider configured. Run `npm run setup` in server/, or set one of: " +
      "AZURE_SPEECH_KEY+AZURE_SPEECH_REGION, OPENAI_API_KEY, GEMINI_API_KEY."
    );
  }
  return picked.mod.transcribe(audioBuffer, opts);
}
