// Dedoom service worker: turns a video post into a formatted transcript.
// 1. Ask the backend if it already has this post (shared cache, instant).
// 2. Otherwise download the post's audio from Instagram's CDN (from the user's
//    browser, so links tied to the viewer still work) and upload it.
// 3. If the provider can't decode the audio-only file, retry with the small mp4.
// The backend transcribes, formats with OpenAI, and caches.

const BACKEND = 'http://localhost:8787';
const MAX_CONCURRENT = 3;

const results = new Map(); // cacheId -> result (for this worker's lifetime)
const pending = new Map(); // cacheId -> Promise
const queue = [];
let running = 0;

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== 'transcribe' || !msg.post?.cacheId) return false;
  getTranscript(msg.post, !!msg.retry).then(sendResponse);
  return true; // respond asynchronously
});

function getTranscript(post, retry) {
  const id = post.cacheId;
  if (retry) results.delete(id);
  if (results.has(id)) return Promise.resolve(results.get(id));
  if (!pending.has(id)) {
    const p = new Promise((resolve) => {
      queue.push({ post, resolve });
      pump();
    }).then((r) => {
      pending.delete(id);
      if (r.ok) results.set(id, r);
      return r;
    });
    pending.set(id, p);
  }
  return pending.get(id);
}

function pump() {
  while (running < MAX_CONCURRENT && queue.length) {
    const { post, resolve } = queue.shift();
    running++;
    work(post)
      .catch((e) => ({ ok: false, error: e.message || String(e) }))
      .then((r) => {
        running--;
        resolve(r);
        pump();
      });
  }
}

async function work(post) {
  const id = encodeURIComponent(post.cacheId);
  // The caption helps the formatter spell names and brands right.
  const captionHeader = post.caption ? { 'X-Caption': encodeURIComponent(post.caption.slice(0, 500)) } : {};

  // 1. Shared cache
  let cached;
  try {
    cached = await fetch(`${BACKEND}/transcript/${id}`, { headers: captionHeader });
  } catch {
    return { ok: false, error: `Can't reach the Dedoom server at ${BACKEND}. Is it running?` };
  }
  if (cached.ok) return { ok: true, ...(await cached.json()) };

  if (!post.hasAudio) return { ok: true, text: '', noSpeech: true };

  // 2. Audio-only first (small), then the smallest video file.
  const sources = [];
  if (post.audioUrl) sources.push({ kind: 'audio', url: post.audioUrl });
  if (post.videoUrl) sources.push({ kind: 'video', url: post.videoUrl });
  // Grid items sometimes come without media links; opening the post loads them.
  if (!sources.length) return { ok: false, noMedia: true };

  let lastError = 'Unknown error';
  for (const src of sources) {
    let bytes;
    try {
      const media = await fetch(src.url, { credentials: 'omit' });
      if (!media.ok) {
        lastError = `Couldn't download the ${src.kind} (HTTP ${media.status}). The link may have expired; refresh the page.`;
        continue;
      }
      bytes = await media.arrayBuffer();
    } catch (e) {
      lastError = `Couldn't download the ${src.kind}: ${e.message}`;
      continue;
    }

    const res = await fetch(`${BACKEND}/transcribe/${id}?kind=${src.kind}`, {
      method: 'POST',
      headers: { 'Content-Type': src.kind === 'audio' ? 'audio/mp4' : 'video/mp4', ...captionHeader },
      body: bytes,
    });
    const body = await res.json().catch(() => ({}));
    if (res.ok) return { ok: true, ...body };
    lastError = body.message || `Server error ${res.status}`;
    if (body.error !== 'bad_media') break; // only fall back to video when the file itself was the problem
  }
  return { ok: false, error: lastError };
}
