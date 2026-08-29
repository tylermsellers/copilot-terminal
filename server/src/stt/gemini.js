// Google Gemini's multimodal audio input, used as a free-tier speech-to-text
// option (no dedicated STT product, but generateContent accepts inline audio
// and can be prompted to return only the transcript). Credentials come only
// from the local PC environment (GEMINI_API_KEY) — never passed through from
// the glasses app.

import { pcmToWav } from "./wav.js";

export const configured = () => Boolean(process.env.GEMINI_API_KEY);

const TRANSCRIBE_PROMPT =
  "Transcribe the attached audio exactly as spoken. Output ONLY the transcription " +
  "text, with no preamble, quotes, or commentary. If the audio is silent or " +
  "unintelligible, output an empty string.";

/**
 * Transcribe raw 16-bit PCM mono audio (or already-WAV audio) via Gemini's
 * generateContent endpoint with an inline audio part.
 * @param {Buffer} audioBuffer
 * @param {{sampleRate?: number, alreadyWav?: boolean}} opts
 */
export async function transcribe(audioBuffer, opts = {}) {
  const { sampleRate = 16000, alreadyWav = false } = opts;
  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    throw new Error("Gemini not configured: set GEMINI_API_KEY env var");
  }
  const wav = alreadyWav ? audioBuffer : pcmToWav(audioBuffer, sampleRate);
  const model = process.env.GEMINI_STT_MODEL || "gemini-2.0-flash";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`;

  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [
        {
          parts: [
            { inline_data: { mime_type: "audio/wav", data: wav.toString("base64") } },
            { text: TRANSCRIBE_PROMPT },
          ],
        },
      ],
    }),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Gemini STT failed (${resp.status}): ${text}`);
  }
  const data = await resp.json();
  const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
  return text.trim();
}
