// Dedoom, page side. Runs in Instagram's own JavaScript context (MAIN world)
// before Instagram's code loads. It:
//  1. reads the JSON Instagram already downloads and passes every video post
//     it finds to content.js,
//  2. tags each <video> on the page with the ID of the post it plays
//     (data-dedoom-id), read from Instagram's video player props,
//  3. fetches comments when the reader opens them, using the reader's own
//     session, the same request Instagram's comment sheet makes.
(() => {
  if (window.__dedoomInjected) return;
  window.__dedoomInjected = true;

  const SOURCE = 'dedoom';
  const post = (msg) => window.postMessage({ source: SOURCE, ...msg }, '*');

  // ---------- 1. Find video posts in Instagram's JSON ----------
  // Match by shape, not by path: Instagram nests media differently per
  // endpoint and changes it often.
  function isVideoPost(o) {
    if (o.media_type === 8) return false; // carousel container; its children are checked separately
    const id = typeof o.code === 'string' || o.pk != null;
    const video = Array.isArray(o.video_versions) || typeof o.video_dash_manifest === 'string' || o.media_type === 2 || o.product_type === 'clips';
    return id && video;
  }

  function audioUrlFromDash(manifest) {
    if (typeof manifest !== 'string' || !manifest.includes('<MPD')) return null;
    try {
      const doc = new DOMParser().parseFromString(manifest, 'application/xml');
      let best = null;
      for (const rep of doc.querySelectorAll('Representation')) {
        const set = rep.parentElement;
        const mime = rep.getAttribute('mimeType') || set?.getAttribute('mimeType') || '';
        const type = set?.getAttribute('contentType') || '';
        if (!mime.startsWith('audio') && type !== 'audio') continue;
        const url = rep.querySelector('BaseURL')?.textContent?.trim();
        if (!url) continue;
        const bw = Number(rep.getAttribute('bandwidth') || 0);
        if (!best || bw < best.bw) best = { url, bw }; // lowest bitrate is plenty for speech
      }
      return best?.url || null;
    } catch {
      return null;
    }
  }

  // Reels on the web often lack video_duration; the DASH manifest has it as PT36.47S.
  function durationFromDash(manifest) {
    const m = typeof manifest === 'string' && /mediaPresentationDuration="PT(?:(\d+)H)?(?:(\d+)M)?([\d.]+)S"/.exec(manifest);
    return m ? Number(m[1] || 0) * 3600 + Number(m[2] || 0) * 60 + Number(m[3]) : null;
  }

  // Reels set to a licensed song carry clips_metadata.music_info; reels with
  // the creator's own audio carry original_sound_info instead.
  function musicFrom(o) {
    const mi = o.clips_metadata?.music_info;
    if (!mi || typeof mi !== 'object') return null;
    const a = mi.music_asset_info || mi;
    return { title: a.title || a.song_name || '', artist: a.display_artist || a.artist_name || a.ig_username || '' };
  }

  function toPost(o, parent) {
    const versions = Array.isArray(o.video_versions) ? o.video_versions : [];
    const smallest = [...versions].sort((a, b) => (a.width || 0) * (a.height || 0) - (b.width || 0) * (b.height || 0))[0];
    const src = parent || o; // carousel children take author/caption/counts from the carousel
    const user = src.user || src.owner || {};
    const caption =
      (src.caption && typeof src.caption === 'object' ? src.caption.text : null) ||
      src.edge_media_to_caption?.edges?.[0]?.node?.text ||
      '';
    const thumbs = o.image_versions2?.candidates || [];
    const thumb = [...thumbs].sort((a, b) => (a.width || 0) - (b.width || 0)).find((t) => (t.width || 0) >= 150) || thumbs[0];
    const pk = o.pk != null ? String(o.pk) : null;
    const code = o.code || parent?.code || null;
    const music = musicFrom(o);
    return {
      pk,
      code,
      // Key for the shared transcript cache. Videos inside a carousel share the
      // carousel's code, so they use their own numeric ID instead.
      cacheId: parent ? pk : code || pk,
      // pk of the post to load comments for (the carousel, for carousel videos)
      commentsPk: parent?.pk != null ? String(parent.pk) : pk,
      username: user.username || '',
      fullName: user.full_name || '',
      avatar: user.profile_pic_url || '',
      caption,
      duration: typeof o.video_duration === 'number' ? o.video_duration : durationFromDash(o.video_dash_manifest),
      likes: typeof src.like_count === 'number' ? src.like_count : null,
      comments: typeof src.comment_count === 'number' ? src.comment_count : null,
      thumbnail: thumb?.url || '',
      videoUrl: smallest?.url || '',
      audioUrl: audioUrlFromDash(o.video_dash_manifest),
      hasAudio: o.has_audio !== false,
      music,
      musicOnly: !!music && !o.clips_metadata?.original_sound_info,
    };
  }

  function collect(node, out, depth = 0, parent = null) {
    if (!node || typeof node !== 'object' || depth > 40) return;
    if (Array.isArray(node)) {
      for (const item of node) collect(item, out, depth + 1, parent);
      return;
    }
    if (isVideoPost(node)) {
      try {
        out.push(toPost(node, parent));
      } catch {}
    }
    for (const key in node) {
      const v = node[key];
      if (!v || typeof v !== 'object') continue;
      // Children of a carousel get the carousel as their parent.
      collect(v, out, depth + 1, key === 'carousel_media' ? node : key === 'user' || key === 'owner' ? null : parent);
    }
  }

  function parseLoose(text) {
    if (typeof text !== 'string' || text.length < 20) return [];
    const cleaned = text.replace(/^for \(;;\);/, '').trim();
    if (cleaned[0] !== '{' && cleaned[0] !== '[') return [];
    try {
      return [JSON.parse(cleaned)];
    } catch {
      const out = []; // some endpoints stream several JSON objects, one per line
      for (const line of cleaned.split('\n')) {
        try {
          out.push(JSON.parse(line));
        } catch {}
      }
      return out;
    }
  }

  function emit(payloads) {
    const posts = [];
    for (const p of payloads) collect(p, posts);
    if (posts.length) post({ type: 'posts', posts });
  }

  // Instagram's web app posts to /api/graphql (no trailing slash), /graphql/query and /api/v1/...
  const INTERESTING = /\/(api\/)?graphql|\/api\/v1\//;

  // Remember the headers Instagram sends so our comment requests look the same.
  const igHeaders = { 'x-ig-app-id': '936619743392459' };
  const KEEP_HEADERS = ['x-ig-app-id', 'x-asbd-id', 'x-ig-www-claim', 'x-web-session-id'];
  function noteHeader(name, value) {
    const n = String(name).toLowerCase();
    if (KEEP_HEADERS.includes(n) && value) igHeaders[n] = String(value);
  }

  const origFetch = window.fetch;
  window.fetch = function (...args) {
    const p = origFetch.apply(this, args);
    try {
      const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || String(args[0]);
      const h = args[1]?.headers;
      if (h) (h instanceof Headers ? [...h.entries()] : Object.entries(h)).forEach(([k, v]) => noteHeader(k, v));
      if (INTERESTING.test(url)) {
        p.then((res) => res.clone().text())
          .then((text) => emit(parseLoose(text)))
          .catch(() => {});
      }
    } catch {}
    return p;
  };

  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  const origSetHeader = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__dedoomUrl = String(url);
    return origOpen.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
    noteHeader(name, value);
    return origSetHeader.call(this, name, value);
  };
  XMLHttpRequest.prototype.send = function (...args) {
    if (INTERESTING.test(this.__dedoomUrl || '')) {
      this.addEventListener('load', () => {
        try {
          if (this.responseType === '' || this.responseType === 'text') emit(parseLoose(this.responseText));
          else if (this.responseType === 'json') emit([this.response]);
        } catch {}
      });
    }
    return origSend.apply(this, args);
  };

  // The first posts are server-rendered into <script type="application/json"> tags.
  function scanEmbedded() {
    const payloads = [];
    for (const s of document.querySelectorAll('script[type="application/json"]')) {
      if (s.__dedoomScanned) continue;
      s.__dedoomScanned = true;
      const t = s.textContent;
      if (t && (t.includes('video_versions') || t.includes('video_dash_manifest') || t.includes('"clips"'))) payloads.push(...parseLoose(t));
    }
    emit(payloads);
  }
  document.addEventListener('DOMContentLoaded', scanEmbedded);
  window.addEventListener('load', scanEmbedded);

  // ---------- 2. Tag each <video> with the post it plays ----------
  // Instagram's player component gets coreVideoPlayerMetaData.videoFBID (the
  // post's numeric ID) as a prop, in the feed, Reels and Explore alike. React
  // keeps props on the DOM node's fiber, so walk up from the <video> to find it.
  function fiberOf(el) {
    for (const k in el) if (k.startsWith('__reactFiber')) return el[k];
    return null;
  }
  function videoIdOf(v) {
    let f = fiberOf(v);
    for (let i = 0; f && i < 40; i++, f = f.return) {
      const p = f.memoizedProps;
      const id = p?.coreVideoPlayerMetaData?.videoFBID ?? p?.coreVideoPlayerProps?.coreVideoPlayerMetaData?.videoFBID ?? p?.videoFBID;
      if (id != null) return String(id);
    }
    return null;
  }
  function tagVideos() {
    for (const v of document.querySelectorAll('video')) {
      const id = videoIdOf(v);
      // Video elements get reused for other posts, so re-tag every time.
      if (id && v.dataset.dedoomId !== id) v.dataset.dedoomId = id;
    }
  }
  setInterval(tagVideos, 400);

  // ---------- 3. Comments ----------
  function csrf() {
    return /(?:^|;\s*)csrftoken=([^;]+)/.exec(document.cookie)?.[1] || '';
  }
  function toComment(c) {
    return {
      pk: String(c.pk ?? c.id),
      text: c.text || '',
      username: c.user?.username || '',
      avatar: c.user?.profile_pic_url || '',
      verified: !!c.user?.is_verified,
      likes: c.comment_like_count ?? c.like_count ?? 0,
      replies: c.child_comment_count ?? 0,
      createdAt: c.created_at || c.created_at_utc || null,
    };
  }
  async function fetchComments(pk, parentPk, cursor) {
    const base = parentPk
      ? `/api/v1/media/${pk}/comments/${parentPk}/child_comments/`
      : `/api/v1/media/${pk}/comments/?can_support_threading=true&permalink_enabled=false`;
    const url = cursor ? `${base}${base.includes('?') ? '&' : '?'}${parentPk ? 'max_id' : 'min_id'}=${encodeURIComponent(cursor)}` : base;
    const res = await origFetch(url, {
      credentials: 'include',
      headers: { ...igHeaders, 'x-csrftoken': csrf(), 'x-requested-with': 'XMLHttpRequest' },
    });
    if (!res.ok) throw new Error(res.status === 401 || res.status === 403 ? 'Log in to Instagram to see comments.' : `Instagram returned ${res.status}`);
    const j = await res.json();
    const list = parentPk ? j.child_comments : j.comments;
    if (!Array.isArray(list)) throw new Error('Unexpected comments response');
    return {
      comments: list.map(toComment),
      next: parentPk ? (j.has_more_head_child_comments || j.has_more_tail_child_comments ? j.next_max_child_cursor : null) : j.has_more_comments ? j.next_min_id : null,
    };
  }

  // ---------- 4. Full post info (for grid items that arrive without video links) ----------
  const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  function codeToPk(code) {
    let n = 0n;
    for (const ch of code.slice(0, 11)) n = n * 64n + BigInt(B64.indexOf(ch));
    return n.toString();
  }
  async function fetchMediaInfo(pk, code) {
    const id = pk || codeToPk(code);
    const res = await origFetch(`/api/v1/media/${id}/info/`, {
      credentials: 'include',
      headers: { ...igHeaders, 'x-csrftoken': csrf(), 'x-requested-with': 'XMLHttpRequest' },
    });
    if (!res.ok || !(res.headers.get('content-type') || '').includes('json')) throw new Error(`Instagram returned ${res.status}`);
    const j = await res.json();
    emit([j]);
    return Array.isArray(j.items) && j.items.length > 0;
  }

  window.addEventListener('message', async (e) => {
    if (e.source !== window || e.data?.source !== SOURCE) return;
    const d = e.data;
    if (d.type === 'rescan') scanEmbedded();
    if (d.type === 'get-media') {
      try {
        post({ type: 'media', reqId: d.reqId, ok: await fetchMediaInfo(d.pk, d.code) });
      } catch (err) {
        post({ type: 'media', reqId: d.reqId, ok: false, error: err.message });
      }
    }
    if (d.type === 'get-comments') {
      try {
        const r = await fetchComments(d.pk, d.parentPk, d.cursor);
        post({ type: 'comments', reqId: d.reqId, ok: true, ...r });
      } catch (err) {
        post({ type: 'comments', reqId: d.reqId, ok: false, error: err.message });
      }
    }
  });
})();
