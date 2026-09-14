"use strict";
/**
 * Text to speech through a local VieNeu-TTS server.
 *
 * VieNeu is bilingual Vietnamese/English in one voice, which the browser's own
 * speechSynthesis is not: a browser voice is pinned to one language, so a line
 * like "chạy npm test rồi commit" comes out either with mangled English or
 * mangled Vietnamese. VieNeu code-switches inside a sentence, so the answer
 * read back from a terminal — Vietnamese prose full of English identifiers —
 * stays intelligible.
 *
 * VieNeu listens on 127.0.0.1 next to the PTY host, never on the phone, so the
 * audio has to be proxied: the browser asks this server, this server asks
 * VieNeu. That also keeps the TTS port off the network.
 *
 * The upstream /stream endpoint streams a WAV whose header claims 100M frames
 * because the length is not known when the header goes out. Chrome copes;
 * iOS Safari refuses to play a chunked WAV of unknown length. So we buffer the
 * whole answer, rewrite the header with the real sizes and send it with a
 * Content-Length. The client asks for one sentence-sized chunk at a time, so
 * buffering costs a fraction of a second, not the whole utterance.
 */
const { config } = require("./config");

const WAV_HEADER_BYTES = 44;

/** Build a canonical 44-byte PCM WAV header for a known payload length. */
function wavHeader({ bytes, sampleRate = 24000, channels = 1, bitsPerSample = 16 }) {
  const header = Buffer.alloc(WAV_HEADER_BYTES);
  const byteRate = (sampleRate * channels * bitsPerSample) / 8;
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + bytes, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16); // PCM fmt chunk size
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE((channels * bitsPerSample) / 8, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(bytes, 40);
  return header;
}

/**
 * Find the PCM payload inside a WAV whose declared sizes cannot be trusted,
 * and re-wrap it in a header that states the real length.
 */
function repackWav(buf) {
  if (buf.length < 12 || buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("Upstream did not return WAV audio");
  }
  let sampleRate = 24000;
  let channels = 1;
  let bitsPerSample = 16;
  let offset = 12;
  while (offset + 8 <= buf.length) {
    const id = buf.toString("ascii", offset, offset + 4);
    const declared = buf.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === "fmt " && body + 16 <= buf.length) {
      channels = buf.readUInt16LE(body + 2) || 1;
      sampleRate = buf.readUInt32LE(body + 4) || 24000;
      bitsPerSample = buf.readUInt16LE(body + 14) || 16;
    }
    if (id === "data") {
      // Trust the bytes we actually received over the declared length.
      const pcm = buf.subarray(body, Math.min(buf.length, body + Math.max(declared, buf.length)));
      return Buffer.concat([wavHeader({ bytes: pcm.length, sampleRate, channels, bitsPerSample }), pcm]);
    }
    offset = body + declared + (declared % 2);
    if (declared <= 0) break;
  }
  throw new Error("WAV had no data chunk");
}

async function upstream(path, init = {}) {
  const url = `${config.ttsUrl.replace(/\/+$/, "")}${path}`;
  const res = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(config.ttsTimeoutMs),
  });
  if (!res.ok) throw new Error(`VieNeu ${res.status}`);
  return res;
}

/** The voices VieNeu currently has loaded, or [] when it is not running. */
async function listVoices() {
  const res = await upstream("/voices");
  const list = await res.json();
  if (!Array.isArray(list)) return [];
  return list
    .filter((v) => v && v.id && !String(v.id).startsWith("error"))
    .map((v) => ({ id: String(v.id), name: String(v.name || v.id) }));
}

/** Synthesise one chunk of text and return a complete, playable WAV. */
async function synth(text, voiceId) {
  const body = String(text || "").trim();
  if (!body) throw new Error("Nothing to speak");
  const res = await upstream("/stream", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: body.slice(0, config.ttsMaxChars), voice_id: voiceId || null }),
  });
  const raw = Buffer.from(await res.arrayBuffer());
  const wav = repackWav(raw);
  if (wav.length <= WAV_HEADER_BYTES) throw new Error("VieNeu returned no audio");
  return wav;
}

module.exports = { listVoices, synth, repackWav, wavHeader };
