// Transcription server for the Dedoom extension.
// Zero dependencies (Node 20+). The extension uploads a reel's audio here; we
// send it to a Whisper API and cache the transcript by reel shortcode, so each
// reel is only ever transcribed once.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8787);
const CACHE_FILE = process.env.CACHE_FILE || path.join(__dirname, 'data', 'transcripts.json');
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024; // Whisper API file limit

// Providers, in order of preference. Groq is fast and cheap but its free tier
// allows only 20 requests a minute; when it says "slow down" we move to the
// next provider (OpenAI if a key is set) or wait out the cooldown.
// TRANSCRIBE_PROVIDER=mock gives fake text for trying the UI without a key.
function buildProviders() {
  const forced = process.env.TRANSCRIBE_PROVIDER;
  if (forced === 'mock') return [{ name: 'mock' }];
  const list = [];
  if (process.env.GROQ_API_KEY && forced !== 'openai') {
    list.push({
      name: 'groq',
      url: process.env.GROQ_URL || 'https://api.groq.com/openai/v1/audio/transcriptions',
      key: process.env.GROQ_API_KEY,
      model: process.env.GROQ_MODEL || 'whisper-large-v3-turbo',
      coolUntil: 0,
    });
  }
  if (process.env.OPENAI_API_KEY && forced !== 'groq') {
    list.push({
      name: 'openai',
      // TRANSCRIBE_URL lets you point at any OpenAI-compatible endpoint (e.g. a local whisper server).
      url: process.env.TRANSCRIBE_URL || 'https://api.openai.com/v1/audio/transcriptions',
      key: process.env.OPENAI_API_KEY,
      model: process.env.OPENAI_MODEL || 'whisper-1',
      coolUntil: 0,
    });
  }
  return list;
}
const providers = buildProviders();
const providerNames = providers.map((p) => p.name).join(' -> ') || 'none';

// ---- Cache (a JSON file; swap for Postgres/Supabase later) ----
let cache = {};
try {
  cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
} catch {
  cache = {};
}
let saveTimer = null;
function saveCacheSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    const tmp = CACHE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(cache));
    fs.renameSync(tmp, CACHE_FILE);
  }, 500);
}

// ---- Transcription ----
// Whisper invents text on music-only clips ("Thanks for watching!"). verbose_json
// gives a per-segment no_speech_prob, so we drop segments it thinks aren't speech,
// and treat a transcript that is nothing but a stock filler phrase as no speech.
const FILLER_WORDS = new Set([
  'thank', 'you', 'thanks', 'so', 'much', 'for', 'watching', 'see', 'next', 'time', 'bye', 'oh', 'music', 'applause',
  'please', 'subscribe', 'okay', 'ok', 'hmm', 'uh', 'um', 'ah', 'yeah', 'la', 'na', 'mm', 'and',
]);
// Subtitle credits Whisper picked up from its training data ("Altyazı M.K.", "Subtitles by the Amara.org community").
const CREDIT_RE = /altyaz|subtitles by|amara\.org|untertitel|sous-titres|transcribed by|captioned by/i;

// True when a transcript is only Whisper filler, not real speech. Works on any
// script: non-Latin words never match the filler list.
function isFiller(text) {
  if (CREDIT_RE.test(text) && text.length < 100) return true;
  const words = text.toLowerCase().replace(/[^\p{L}\s]/gu, ' ').split(/\s+/).filter(Boolean);
  return words.length === 0 || (words.length <= 6 && words.every((w) => FILLER_WORDS.has(w)));
}

function cleanSegments(json) {
  const text = Array.isArray(json.segments)
    ? json.segments
        .filter((s) => !(s.no_speech_prob > 0.8 || (s.no_speech_prob > 0.5 && s.avg_logprob < -0.8)))
        .map((s) => s.text.trim())
        .join(' ')
        .trim()
    : (json.text || '').trim();
  return isFiller(text) ? '' : text;
}

class MediaError extends Error {}
class RateLimited extends Error {}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// "Please try again in 3s" / "in 1m12.5s" / Retry-After header -> milliseconds
function retryAfterMs(res, body) {
  const header = Number(res.headers.get('retry-after'));
  if (header > 0) return header * 1000;
  const m = /try again in (?:(\d+)m)?([\d.]+)s/i.exec(body);
  if (m) return (Number(m[1] || 0) * 60 + Number(m[2])) * 1000;
  return 10_000;
}

async function callProvider(p, buffer, filename, contentType) {
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: contentType }), filename);
  form.append('model', p.model);
  form.append('response_format', 'verbose_json');
  const res = await fetch(p.url, { method: 'POST', headers: { Authorization: `Bearer ${p.key}` }, body: form });
  const body = await res.text();
  if (res.status === 429) {
    p.coolUntil = Date.now() + retryAfterMs(res, body) + 250;
    throw new RateLimited(`${p.name} rate limited for ${Math.round((p.coolUntil - Date.now()) / 1000)}s`);
  }
  // 400 from the API almost always means it couldn't decode the file.
  if (res.status === 400) throw new MediaError(`${p.name} rejected the media: ${body.slice(0, 300)}`);
  if (!res.ok) throw new Error(`${p.name} ${res.status}: ${body.slice(0, 300)}`);
  return cleanSegments(JSON.parse(body));
}

const MAX_WAIT_MS = 90_000;

// Returns { text, provider }.
async function transcribe(buffer, filename, contentType) {
  if (providers[0]?.name === 'mock') {
    await sleep(800);
    return { provider: 'mock', text: `[mock transcript, ${Math.round(buffer.length / 1024)} KB of media] Set GROQ_API_KEY or OPENAI_API_KEY in backend/.env for real transcripts.` };
  }
  if (!providers.length) {
    throw new Error('No API key. Set GROQ_API_KEY or OPENAI_API_KEY in backend/.env (or TRANSCRIBE_PROVIDER=mock).');
  }
  const deadline = Date.now() + MAX_WAIT_MS;
  let lastError;
  const failed = new Set(); // providers that errored (not rate limits) on this file
  while (Date.now() < deadline) {
    const usable = providers.filter((p) => !failed.has(p));
    if (!usable.length) break;
    const ready = usable.find((p) => p.coolUntil <= Date.now());
    if (!ready) {
      // Everyone is cooling down: wait for whoever is free first.
      const wait = Math.min(...usable.map((p) => p.coolUntil)) - Date.now();
      if (Date.now() + wait > deadline) break;
      await sleep(wait);
      continue;
    }
    try {
      return { provider: ready.name, text: await callProvider(ready, buffer, filename, contentType) };
    } catch (e) {
      lastError = e;
      if (e instanceof MediaError) throw e;
      if (!(e instanceof RateLimited)) failed.add(ready);
    }
  }
  throw lastError || new Error('Transcription timed out waiting for rate limits');
}

// ---- Formatting (OpenAI) ----
// Raw Whisper output is one run-on block. A small OpenAI model turns it into
// a hook line plus readable paragraphs, without changing what was said.
const FORMAT_MODEL = process.env.FORMAT_MODEL || 'gpt-4.1-mini';
const FORMAT_URL = process.env.FORMAT_URL || 'https://api.openai.com/v1/chat/completions';
const canFormat = providers[0]?.name === 'mock' || !!process.env.OPENAI_API_KEY;

const FORMAT_PROMPT = `You format raw speech-to-text transcripts of short social videos so they read well.
- Keep the speaker's words and meaning. Don't add facts, opinions or a summary.
- Fix punctuation, capitalization and obvious mishearings. Use the caption, if given, only to spell names and brands right.
- Remove filler words (um, uh, you know, like as filler) and false starts.
- Short paragraphs of 1-3 sentences, separated by a blank line.
- Use "- " bullets only when the speaker lists items or steps.
- Bold (**like this**) at most 2 key phrases.
- Keep the original language. Never translate.
title: a hook of at most 10 words in the same language. Capitalize it like a normal sentence (first word and proper nouns), no emoji, no trailing period.`;

const FORMAT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'body'],
  properties: { title: { type: 'string' }, body: { type: 'string' } },
};

async function formatTranscript(text, caption) {
  if (providers[0]?.name === 'mock') {
    await sleep(300);
    return {
      title: 'Mock transcript, formatted',
      body: `${text}\n\nThis is a **second paragraph** so you can see the layout.\n\n- First listed point\n- Second listed point`,
    };
  }
  const user = (caption ? `Caption: ${caption.slice(0, 500)}\n\n` : '') + `Transcript:\n${text}`;
  const res = await fetch(FORMAT_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: FORMAT_MODEL,
      messages: [
        { role: 'system', content: FORMAT_PROMPT },
        { role: 'user', content: user },
      ],
      response_format: { type: 'json_schema', json_schema: { name: 'formatted_transcript', strict: true, schema: FORMAT_SCHEMA } },
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`format ${res.status}: ${body.slice(0, 200)}`);
  const out = JSON.parse(JSON.parse(body).choices[0].message.content);
  if (typeof out.title !== 'string' || typeof out.body !== 'string' || !out.body.trim()) throw new Error('format: empty result');
  return { title: out.title.trim(), body: out.body.trim() };
}

const formatting = new Map(); // code -> Promise
// Adds `formatted` to an entry (once; cached). Formatting failures never fail
// the request: the extension falls back to the plain transcript.
async function ensureFormatted(entry, caption) {
  if (!canFormat || entry.noSpeech || !entry.text || entry.formatted) return entry;
  if (!formatting.has(entry.code)) {
    const started = Date.now();
    formatting.set(
      entry.code,
      formatTranscript(entry.text, caption)
        .then((formatted) => {
          entry.formatted = formatted;
          entry.formatModel = providers[0]?.name === 'mock' ? 'mock' : FORMAT_MODEL;
          if (cache[entry.code] === entry) saveCacheSoon();
          console.log(`[fmt] ${entry.code} in ${Date.now() - started}ms`);
        })
        .catch((e) => console.error(`[fmt-err] ${entry.code}: ${e.message}`))
        .finally(() => formatting.delete(entry.code))
    );
  }
  await formatting.get(entry.code);
  return entry;
}

function captionFrom(req) {
  try {
    return decodeURIComponent(req.headers['x-caption'] || '');
  } catch {
    return '';
  }
}

// ---- HTTP ----
const inflight = new Map(); // code -> Promise, so two tabs don't transcribe the same reel twice

function send(res, status, obj) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, X-Caption',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_UPLOAD_BYTES) {
        reject(Object.assign(new Error('File too large (25 MB max)'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const CODE_RE = /^[A-Za-z0-9_-]{5,64}$/;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const parts = url.pathname.split('/').filter(Boolean);

  if (req.method === 'OPTIONS') return send(res, 204, {});

  if (req.method === 'GET' && url.pathname === '/health') {
    return send(res, 200, { ok: true, providers: providerNames, cached: Object.keys(cache).length });
  }

  // GET /transcript/:code -> cached transcript or 404
  if (req.method === 'GET' && parts[0] === 'transcript' && parts.length === 2) {
    const entry = cache[parts[1]];
    if (!entry) console.log(`[miss] ${parts[1]}`);
    return entry ? send(res, 200, await ensureFormatted(entry, captionFrom(req))) : send(res, 404, { error: 'not_found' });
  }

  // POST /transcribe/:code?kind=audio|video  body = raw media bytes
  if (req.method === 'POST' && parts[0] === 'transcribe' && parts.length === 2) {
    const code = parts[1];
    if (!CODE_RE.test(code)) return send(res, 400, { error: 'bad_code' });
    const caption = captionFrom(req);
    if (cache[code]) return send(res, 200, await ensureFormatted(cache[code], caption));

    let body;
    try {
      body = await readBody(req);
    } catch (e) {
      return send(res, e.status || 400, { error: 'upload_failed', message: e.message });
    }
    if (!body.length) return send(res, 400, { error: 'empty_body' });

    const kind = url.searchParams.get('kind') === 'video' ? 'video' : 'audio';
    const filename = kind === 'video' ? 'reel.mp4' : 'reel.m4a';
    const contentType = kind === 'video' ? 'video/mp4' : 'audio/mp4';

    if (!inflight.has(code)) {
      const started = Date.now();
      const job = transcribe(body, filename, contentType)
        .then(({ text, provider }) => {
          const entry = { code, text, noSpeech: text.length === 0, provider, createdAt: new Date().toISOString() };
          if (provider !== 'mock') {
            cache[code] = entry;
            saveCacheSoon();
          }
          console.log(`[ok] ${code} ${kind} ${Math.round(body.length / 1024)}KB via ${provider} in ${Date.now() - started}ms -> ${text.length} chars`);
          return entry;
        })
        .finally(() => inflight.delete(code));
      inflight.set(code, job);
    }

    try {
      return send(res, 200, await ensureFormatted(await inflight.get(code), caption));
    } catch (e) {
      console.error(`[err] ${code}: ${e.message}`);
      return send(res, e instanceof MediaError ? 422 : 502, {
        error: e instanceof MediaError ? 'bad_media' : 'transcribe_failed',
        message: e.message,
      });
    }
  }

  send(res, 404, { error: 'not_found' });
});

// Entries cached before the filler filter existed: re-check them once at startup.
for (const e of Object.values(cache)) {
  if (e.text && isFiller(e.text)) Object.assign(e, { text: '', noSpeech: true });
}

server.listen(PORT, () => {
  console.log(`Dedoom backend on http://localhost:${PORT} (transcribe: ${providerNames}, format: ${canFormat ? FORMAT_MODEL : 'off (no OPENAI_API_KEY)'}, ${Object.keys(cache).length} cached)`);
  if (!providers.length) console.log('No API key set: requests will fail. Add one to backend/.env or set TRANSCRIBE_PROVIDER=mock.');
});
