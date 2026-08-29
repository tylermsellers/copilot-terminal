// Wraps Azure AI Speech's short-audio REST API for speech-to-text.
// Credentials come only from the local PC environment (AZURE_SPEECH_KEY /
// AZURE_SPEECH_REGION) — never passed through from the glasses app.

const REGION = process.env.AZURE_SPEECH_REGION;
const KEY = process.env.AZURE_SPEECH_KEY;

/** Wrap raw 16-bit PCM samples in a minimal WAV header (Azure STT REST API expects a WAV container). */
function pcmToWav(pcmBuffer, sampleRate = 16000, channels = 1, bitsPerSample = 16) {
  const byteRate = (sampleRate * channels * bitsPerSample) / 8;
  const blockAlign = (channels * bitsPerSample) / 8;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcmBuffer.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16); // PCM fmt chunk size
  header.writeUInt16LE(1, 20); // audio format = PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcmBuffer.length, 40);
  return Buffer.concat([header, pcmBuffer]);
}

/**
 * Transcribe raw 16-bit PCM mono audio (as delivered by the G2's AudioEventPayload,
 * or already-WAV audio) via Azure Speech-to-Text.
 * @param {Buffer} audioBuffer
 * @param {{sampleRate?: number, alreadyWav?: boolean, language?: string}} opts
 */
export async function transcribePcm(audioBuffer, opts = {}) {
  const { sampleRate = 16000, alreadyWav = false, language = "en-US" } = opts;
  if (!KEY || !REGION) {
    throw new Error("Azure Speech not configured: set AZURE_SPEECH_KEY and AZURE_SPEECH_REGION env vars");
  }
  const wav = alreadyWav ? audioBuffer : pcmToWav(audioBuffer, sampleRate);
  const url = `https://${REGION}.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1?language=${encodeURIComponent(language)}`;
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Ocp-Apim-Subscription-Key": KEY,
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
