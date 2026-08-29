// Azure AI Speech short-audio REST API. Credentials come only from the
// local PC environment (AZURE_SPEECH_KEY / AZURE_SPEECH_REGION) — never
// passed through from the glasses app.

import { pcmToWav } from "./wav.js";

export const configured = () => Boolean(process.env.AZURE_SPEECH_KEY && process.env.AZURE_SPEECH_REGION);

/**
 * Transcribe raw 16-bit PCM mono audio (or already-WAV audio) via Azure Speech-to-Text.
 * @param {Buffer} audioBuffer
 * @param {{sampleRate?: number, alreadyWav?: boolean, language?: string}} opts
 */
export async function transcribe(audioBuffer, opts = {}) {
  const { sampleRate = 16000, alreadyWav = false, language = "en-US" } = opts;
  const key = process.env.AZURE_SPEECH_KEY;
  const region = process.env.AZURE_SPEECH_REGION;
  if (!key || !region) {
    throw new Error("Azure Speech not configured: set AZURE_SPEECH_KEY and AZURE_SPEECH_REGION env vars");
  }
  const wav = alreadyWav ? audioBuffer : pcmToWav(audioBuffer, sampleRate);
  const url = `https://${region}.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1?language=${encodeURIComponent(language)}`;
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Ocp-Apim-Subscription-Key": key,
      "Content-Type": `audio/wav; codecs=audio/pcm; samplerate=${sampleRate}`,
      Accept: "application/json",
    },
    body: wav,
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Azure Speech STT failed (${resp.status}): ${text}`);
  }
  const data = await resp.json();
  if (data.RecognitionStatus && data.RecognitionStatus !== "Success") {
    throw new Error(`Azure Speech STT status: ${data.RecognitionStatus}`);
  }
  return data.DisplayText ?? "";
}
