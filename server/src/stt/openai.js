// OpenAI's audio transcription API (Whisper). Credentials come only from
// the local PC environment (OPENAI_API_KEY) — never passed through from
// the glasses app.

import { pcmToWav } from "./wav.js";

export const configured = () => Boolean(process.env.OPENAI_API_KEY);

/**
 * Transcribe raw 16-bit PCM mono audio (or already-WAV audio) via OpenAI's
 * /v1/audio/transcriptions endpoint.
 * @param {Buffer} audioBuffer
 * @param {{sampleRate?: number, alreadyWav?: boolean, language?: string}} opts
 */
export async function transcribe(audioBuffer, opts = {}) {
  const { sampleRate = 16000, alreadyWav = false, language = "en" } = opts;
  const key = process.env.OPENAI_API_KEY;
  if (!key) {
    throw new Error("OpenAI not configured: set OPENAI_API_KEY env var");
  }
  const wav = alreadyWav ? audioBuffer : pcmToWav(audioBuffer, sampleRate);

  const form = new FormData();
  form.append("file", new Blob([wav], { type: "audio/wav" }), "audio.wav");
  form.append("model", process.env.OPENAI_STT_MODEL || "gpt-4o-mini-transcribe");
  if (language) form.append("language", language.split("-")[0]); // e.g. "en-US" -> "en"

  const resp = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}` },
    body: form,
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`OpenAI STT failed (${resp.status}): ${text}`);
  }
  const data = await resp.json();
  return data.text ?? "";
}
