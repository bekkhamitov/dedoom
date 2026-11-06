// Dedoom, extension side (isolated world). Keeps Instagram's UI and puts text
// where the video would be: every <video> Instagram shows (feed, Reels,
// Explore, profiles) gets a panel over it with the formatted transcript, and
// Explore/profile grid tiles for videos show the opening lines. Photos are
// left alone. Caption and comments open on demand, comments as threads.
(() => {
  const SOURCE = 'dedoom';
  const MODE_KEY = 'dedoom-mode';

  // ---------- State ----------
  const posts = new Map(); // key -> post (key = cacheId of the first copy we saw)
  const alias = new Map(); // pk or code -> key
  const results = new Map(); // key -> transcript result from background.js
  const requested = new Set(); // keys we've asked background.js about
  const panels = new Set();
  const videoPanels = new WeakMap(); // <video> -> panel
  const tilePanels = new WeakMap(); // <a> tile -> panel
  const revealed = new Set(); // keys the reader chose to watch as video
  let mode = readMode();

  function readMode() {
    try {
      return localStorage.getItem(MODE_KEY) === 'video' ? 'video' : 'text';
    } catch {
      return 'text';
    }
  }

  const keyOf = (id) => (id == null ? null : alias.get(String(id)) || null);

  // ---------- Posts from inject.js ----------
  window.addEventListener('message', (e) => {
    if (e.source !== window || e.data?.source !== SOURCE) return;
    if (e.data.type === 'posts') for (const p of e.data.posts) addPost(p);
    if (e.data.type === 'comments' || e.data.type === 'media') resolvePage(e.data);
  });

  // The same post can arrive several times (a stub, then the full object), so
  // copies are merged: empty fields get filled in.
  function addPost(p) {
    const key = keyOf(p.pk) || keyOf(p.cacheId);
    const existing = key && posts.get(key);
    if (existing) {
      for (const [k, v] of Object.entries(p)) {
        const empty = existing[k] === '' || existing[k] === null || existing[k] === undefined;
        if (empty && v !== '' && v !== null && v !== undefined) existing[k] = v;
      }
      if (p.pk) alias.set(p.pk, key);
      return;
    }
    const newKey = p.cacheId || p.pk;
    if (!newKey) return;
    posts.set(newKey, p);
    // Codes only identify standalone posts (carousel videos share their carousel's code).
    for (const id of [p.pk, p.cacheId]) if (id) alias.set(String(id), newKey);
  }

  // ---------- Transcripts (via background.js) ----------
  function requestTranscript(key, retry = false) {
    const post = posts.get(key);
    if (!post || (requested.has(key) && !retry)) return;
    requested.add(key);
    if (post.musicOnly && !retry) return setResult(key, { ok: true, music: true }); // lyrics aren't worth reading
    setResult(key, { loading: true });
    try {
      chrome.runtime.sendMessage({ type: 'transcribe', post, retry }, (res) => {
        if (chrome.runtime.lastError || !res) setResult(key, { ok: false, error: chrome.runtime.lastError?.message || 'No response from the extension.' });
        else if (res.noMedia && !post.mediaFetched) fetchMedia(key);
        else setResult(key, res);
      });
    } catch {
      setResult(key, { ok: false, error: 'Dedoom was updated. Refresh the page.' });
    }
  }

  // Grid items often come without video links. Ask Instagram for the full post
  // (inject.js does it in the page, like opening the post would), then retry.
  async function fetchMedia(key) {
    const post = posts.get(key);
    post.mediaFetched = true;
    const r = await askPage({ type: 'get-media', pk: post.pk, code: post.code });
    requested.delete(key);
    if (r.ok && (post.audioUrl || post.videoUrl)) requestTranscript(key);
    else setResult(key, { ok: false, noMedia: true });
  }

  function setResult(key, res) {
    results.set(key, res);
    for (const p of panels) if (p.key === key) renderPanel(p);
  }

  // ---------- Styles (one sheet shared by every panel) ----------
  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .panel { position: absolute; inset: 0; background: #0c0c0d; color: #f2f2f2; overflow-y: auto; overscroll-behavior: auto;
      font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; -webkit-font-smoothing: antialiased;
      scrollbar-width: thin; scrollbar-color: #3a3a3c transparent; text-align: left; cursor: auto; }
    .inner { padding: 16px 18px 20px; min-height: 100%; display: flex; flex-direction: column; }
    .top { display: flex; align-items: center; gap: 8px; color: #8e8e93; font-size: 12px; margin-bottom: 12px; }
    .top .spacer { flex: 1; }
    button { font: inherit; cursor: pointer; }
    .chip { border: 1px solid #3a3a3c; background: transparent; color: #f2f2f2; border-radius: 999px; padding: 4px 10px; font-size: 12px; font-weight: 600; }
    .chip:hover { background: #1c1c1e; }
    .title { font-size: 1.2em; font-weight: 700; line-height: 1.3; margin: 0 0 10px; letter-spacing: -0.01em; }
    .body p { margin: 0 0 0.8em; }
    .body ul { margin: 0 0 0.8em; padding-left: 1.2em; }
    .body li { margin: 0 0 0.3em; }
    .body strong { font-weight: 700; color: #fff; }
    .quiet { color: #a1a1a6; font-style: italic; margin: 0 0 6px; }
    .error { color: #ff6961; font-size: 14px; margin: 0 0 6px; }
    .link { border: 0; background: none; color: #4aa3ff; padding: 0; font-size: 14px; }
    .skel div { height: 11px; border-radius: 6px; background: #232326; margin-bottom: 10px; animation: pulse 1.2s ease-in-out infinite; }
    .skel div:nth-child(1) { width: 70%; height: 16px; margin-bottom: 14px; }
    .skel div:nth-child(2) { width: 95%; } .skel div:nth-child(3) { width: 88%; } .skel div:nth-child(4) { width: 60%; }
    @keyframes pulse { 50% { opacity: .45; } }
    .sections { margin-top: auto; padding-top: 10px; border-top: 1px solid #2c2c2e; }
    .expander { display: flex; width: 100%; align-items: center; gap: 6px; border: 0; background: none; color: #d1d1d6; padding: 9px 0; font-size: 14px; font-weight: 600; text-align: left; }
    .expander:hover { color: #fff; }
    .expander .chev { transition: transform .15s; display: inline-block; color: #8e8e93; }
    .expander[aria-expanded="true"] .chev { transform: rotate(90deg); }
    .expander .count { color: #8e8e93; font-weight: 400; }
    .caption { white-space: pre-wrap; word-wrap: break-word; color: #d1d1d6; font-size: 14px; padding: 0 0 10px; }
    .comments { padding: 2px 0 6px; }
    .c { display: flex; gap: 10px; padding: 8px 0; }
    .c .av { width: 28px; height: 28px; border-radius: 50%; background: #2c2c2e; flex: none; object-fit: cover; }
    .c .main { flex: 1; min-width: 0; }
    .c .who { font-size: 13px; font-weight: 700; }
    .c .who .meta { color: #8e8e93; font-weight: 400; }
    .c .text { font-size: 14px; white-space: pre-wrap; word-wrap: break-word; margin-top: 1px; }
    .c .actions { margin-top: 4px; display: flex; gap: 14px; font-size: 12px; color: #8e8e93; align-items: center; }
    .replies { margin-left: 13px; padding-left: 23px; border-left: 2px solid #2c2c2e; }
    .muted { color: #8e8e93; font-size: 13px; padding: 6px 0; }

    /* Grid tiles (Explore, profile reels) */
    .tile { position: absolute; inset: 0; background: #0c0c0d; color: #f2f2f2; padding: 10px 11px; overflow: hidden;
      font: 12px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; display: flex; flex-direction: column; gap: 5px; }
    .tile .t { font-size: 13px; font-weight: 700; line-height: 1.25; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; flex: none; }
    .tile .b { color: #c7c7cc; display: -webkit-box; -webkit-box-orient: vertical; overflow: hidden; }
    .tile .badge { margin-top: auto; color: #8e8e93; font-size: 11px; flex: none; }

    .mode { position: fixed; left: 16px; bottom: 16px; border: 1px solid #3a3a3c; border-radius: 999px; padding: 7px 13px;
      background: #0c0c0d; color: #f2f2f2; font: 600 13px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; box-shadow: 0 4px 14px rgba(0,0,0,.3); }
    .mode b { color: #4aa3ff; }
    .back { position: absolute; top: 10px; left: 10px; background: #0c0c0d; }
  `;
  let sheet;
  function adopt(root) {
    try {
      if (!sheet) {
        sheet = new CSSStyleSheet();
        sheet.replaceSync(CSS);
      }
      root.adoptedStyleSheets = [sheet];
    } catch {
      const s = document.createElement('style');
      s.textContent = CSS;
      root.appendChild(s);
    }
  }

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  const capFirst = (t) => (t ? t.charAt(0).toLocaleUpperCase() + t.slice(1) : t);
  const compact = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });
  function fmtDuration(s) {
    if (s == null) return '';
    const t = Math.round(s);
    return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
  }
  function timeAgo(sec) {
    if (!sec) return '';
    const d = Date.now() / 1000 - sec;
    if (d < 3600) return `${Math.max(1, Math.round(d / 60))}m`;
    if (d < 86400) return `${Math.round(d / 3600)}h`;
    if (d < 86400 * 7) return `${Math.round(d / 86400)}d`;
    return `${Math.round(d / (86400 * 7))}w`;
  }

  // Minimal Markdown: paragraphs, "- " bullets, **bold**. Built with DOM nodes, never innerHTML.
  function inline(parent, text) {
    for (const part of text.split(/(\*\*[^*]+\*\*)/)) {
      if (!part) continue;
      if (/^\*\*[^*]+\*\*$/.test(part)) parent.append(el('strong', null, part.slice(2, -2)));
      else parent.append(document.createTextNode(part));
    }
  }
  function renderMarkdown(container, md) {
    for (const block of md.split(/\n\s*\n/)) {
      let list = null;
      let para = [];
      const flush = () => {
        if (!para.length) return;
        const p = el('p');
        inline(p, para.join(' '));
        container.append(p);
        para = [];
      };
      for (const raw of block.split('\n')) {
        const line = raw.trim();
        if (!line) continue;
        const bullet = /^([-*•]|\d+[.)])\s+(.*)$/.exec(line);
        if (bullet) {
          flush();
          if (!list) container.append((list = el('ul')));
          const li = el('li');
          inline(li, bullet[2]);
          list.append(li);
        } else {
          list = null;
          para.push(line.replace(/^#{1,4}\s+/, ''));
        }
      }
      flush();
    }
  }

  // ---------- Panels ----------
  // The panel covers the topmost element that has exactly the video's size, so
  // Instagram's own UI around the video (author, likes, buttons) stays visible.
  function mediaBox(v) {
    const r = v.getBoundingClientRect();
    if (r.width < 40 || r.height < 40) return null;
    let box = v.parentElement;
    for (let n = v.parentElement; n && n !== document.body; n = n.parentElement) {
      const q = n.getBoundingClientRect();
      if (Math.abs(q.width - r.width) < 2 && Math.abs(q.height - r.height) < 2) box = n;
      else break;
    }
    return box;
  }

  function mount(box, z) {
    const host = document.createElement('dedoom-panel');
    host.style.cssText = `position:absolute;inset:0;z-index:${z};display:block;`;
    if (getComputedStyle(box).position === 'static') box.style.position = 'relative';
    const root = host.attachShadow({ mode: 'open' });
    adopt(root);
    box.appendChild(host);
    return { host, root };
  }

  function createVideoPanel(video, key, box) {
    const { host, root } = mount(box, 30);
    // Keep clicks inside the panel from reaching Instagram (pause, mute, double-tap like, open post).
    for (const t of ['click', 'dblclick', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'touchstart', 'touchend', 'keydown']) {
      host.addEventListener(t, (e) => e.stopPropagation());
    }
    const p = { kind: 'video', key, anchor: video, box, host, root, open: { caption: false, comments: false }, comments: null };
    panels.add(p);
    videoPanels.set(video, p);
    renderPanel(p);
    return p;
  }

  function createTilePanel(a, key) {
    const { host, root } = mount(a, 10);
    host.style.pointerEvents = 'none'; // clicks go through to the tile's link
    const p = { kind: 'tile', key, anchor: a, box: a, host, root };
    panels.add(p);
    tilePanels.set(a, p);
    renderPanel(p);
    return p;
  }

  function removePanel(p) {
    p.host.remove();
    panels.delete(p);
    if (p.kind === 'video') videoPanels.delete(p.anchor);
    else tilePanels.delete(p.anchor);
  }

  function renderPanel(p) {
    const post = posts.get(p.key);
    const res = results.get(p.key);
    if (p.kind === 'tile') return renderTile(p, post, res);

    const scrollTop = p.root.querySelector('.panel')?.scrollTop || 0;
    const panel = el('div', 'panel');
    const inner = el('div', 'inner');
    panel.append(inner);

    const top = el('div', 'top');
    const label = [fmtDuration(post?.duration), post?.username ? `@${post.username}` : ''].filter(Boolean).join(' · ');
    top.append(el('span', null, label), el('span', 'spacer'));
    const play = el('button', 'chip', 'Play video');
    play.onclick = () => reveal(p);
    top.append(play);
    inner.append(top);

    const content = el('div', 'content');
    if (!res || res.loading) {
      const sk = el('div', 'skel');
      sk.append(el('div'), el('div'), el('div'), el('div'));
      content.append(sk);
    } else if (res.music) {
      const song = [post?.music?.title, post?.music?.artist].filter(Boolean).join(' · ');
      content.append(el('p', 'quiet', song ? `Music only: ♪ ${song}` : 'Music only'));
      const anyway = el('button', 'link', 'Transcribe anyway');
      anyway.onclick = () => requestTranscript(p.key, true);
      content.append(anyway);
    } else if (!res.ok && res.noMedia) {
      content.append(el('p', 'quiet', 'Open this video to read it.'));
    } else if (!res.ok) {
      content.append(el('p', 'error', res.error || 'Something went wrong.'));
      const retry = el('button', 'link', 'Retry');
      retry.onclick = () => requestTranscript(p.key, true);
      content.append(retry);
    } else if (res.noSpeech || !res.text) {
      content.append(el('p', 'quiet', 'No speech. Music or visuals only.'));
    } else if (res.formatted) {
      content.append(el('h2', 'title', capFirst(res.formatted.title)));
      const body = el('div', 'body');
      renderMarkdown(body, res.formatted.body);
      content.append(body);
    } else {
      const body = el('div', 'body');
      body.append(el('p', null, res.text));
      content.append(body);
    }
    inner.append(content);

    // Caption and comments stay closed until the reader opens them.
    const sections = el('div', 'sections');
    if (post?.caption) {
      const btn = expander('Caption', null, p.open.caption);
      const cap = el('div', 'caption', post.caption);
      cap.hidden = !p.open.caption;
      btn.onclick = () => {
        p.open.caption = !p.open.caption;
        btn.setAttribute('aria-expanded', String(p.open.caption));
        cap.hidden = !p.open.caption;
      };
      sections.append(btn, cap);
    }
    if (post?.commentsPk && post.comments !== 0) {
      const btn = expander('Comments', post.comments != null ? compact.format(post.comments) : null, p.open.comments);
      const box = el('div', 'comments');
      box.hidden = !p.open.comments;
      btn.onclick = () => {
        p.open.comments = !p.open.comments;
        btn.setAttribute('aria-expanded', String(p.open.comments));
        box.hidden = !p.open.comments;
        if (p.open.comments && !p.comments) loadComments(p, box);
      };
      if (p.open.comments) fillComments(p, box);
      p.commentsBox = box;
      sections.append(btn, box);
    }
    if (sections.childNodes.length) inner.append(sections);

    p.root.replaceChildren(panel);
    panel.scrollTop = scrollTop;
  }

  function expander(label, count, open) {
    const b = el('button', 'expander');
    b.setAttribute('aria-expanded', String(!!open));
    b.append(el('span', 'chev', '›'), el('span', null, label));
    if (count) b.append(el('span', 'count', count));
    return b;
  }

  function renderTile(p, post, res) {
    // Only cover the thumbnail once there's something to read.
    const readable = res?.ok && (res.formatted || res.text || res.music || res.noSpeech);
    p.host.style.display = readable ? 'block' : 'none';
    if (!readable) return;
    const tile = el('div', 'tile');
    if (res.music) {
      const song = [post?.music?.title, post?.music?.artist].filter(Boolean).join(' · ');
      tile.append(el('div', 't', song ? `♪ ${song}` : 'Music only'));
    } else if (res.noSpeech || !res.text) {
      tile.append(el('div', 't', 'No speech'));
      if (post?.caption) tile.append(el('div', 'b', post.caption));
    } else {
      tile.append(el('div', 't', capFirst(res.formatted?.title || res.text.split(/[.!?]/)[0])));
      const plain = (res.formatted?.body || res.text).replace(/\*\*/g, '').replace(/^\s*[-*•]\s+/gm, '');
      tile.append(el('div', 'b', plain));
    }
    tile.append(el('div', 'badge', ['Video', fmtDuration(post?.duration)].filter(Boolean).join(' · ')));
    p.root.replaceChildren(tile);
    // Fit as many body lines as the tile has room for.
    requestAnimationFrame(() => {
      const b = p.root.querySelector('.b');
      if (!b) return;
      const free = p.host.clientHeight - (p.root.querySelector('.t')?.offsetHeight || 0) - 50;
      b.style.webkitLineClamp = String(Math.max(1, Math.floor(free / 17)));
    });
  }

  // ---------- Comments (fetched by inject.js inside the page) ----------
  // Requests that inject.js runs inside the page (it has Instagram's session).
  const pendingPage = new Map();
  let reqSeq = 0;
  function askPage(msg) {
    return new Promise((resolve) => {
      const reqId = `r${++reqSeq}`;
      pendingPage.set(reqId, resolve);
      window.postMessage({ source: SOURCE, reqId, ...msg }, '*');
      setTimeout(() => {
        if (pendingPage.delete(reqId)) resolve({ ok: false, error: 'Instagram took too long to answer.' });
      }, 15000);
    });
  }
  function resolvePage(d) {
    const resolve = pendingPage.get(d.reqId);
    if (!resolve) return;
    pendingPage.delete(d.reqId);
    resolve(d);
  }
  const getComments = (pk, parentPk, cursor) => askPage({ type: 'get-comments', pk, parentPk, cursor });

  async function loadComments(p, box) {
    const post = posts.get(p.key);
    p.comments = { loading: true, items: [], next: null, error: null, replies: new Map() };
    fillComments(p, box);
    const r = await getComments(post.commentsPk);
    Object.assign(p.comments, { loading: false, items: r.ok ? r.comments : [], next: r.ok ? r.next : null, error: r.ok ? null : r.error });
    fillComments(p, p.commentsBox || box);
  }

  async function loadMore(p) {
    const post = posts.get(p.key);
    p.comments.loadingMore = true;
    fillComments(p, p.commentsBox);
    const r = await getComments(post.commentsPk, null, p.comments.next);
    p.comments.loadingMore = false;
    if (r.ok) {
      p.comments.items.push(...r.comments);
      p.comments.next = r.next;
    }
    fillComments(p, p.commentsBox);
  }

  async function loadReplies(p, c) {
    const post = posts.get(p.key);
    p.comments.replies.set(c.pk, { loading: true, items: [] });
    fillComments(p, p.commentsBox);
    const r = await getComments(post.commentsPk, c.pk);
    p.comments.replies.set(c.pk, { loading: false, items: r.ok ? r.comments : [], error: r.ok ? null : r.error });
    fillComments(p, p.commentsBox);
  }

  function commentRow(c) {
    const row = el('div', 'c');
    const av = el('img', 'av');
    av.alt = '';
    if (c.avatar) av.src = c.avatar;
    av.onerror = () => av.removeAttribute('src');
    const main = el('div', 'main');
    const who = el('div', 'who', c.username || 'unknown');
    const ago = timeAgo(c.createdAt);
    if (ago) who.append(el('span', 'meta', ` · ${ago}`));
    main.append(who);
    const text = el('div', 'text');
    inline(text, c.text);
    main.append(text);
    const actions = el('div', 'actions');
    if (c.likes) actions.append(el('span', null, `♥ ${compact.format(c.likes)}`));
    main.append(actions);
    row.append(av, main);
    return { row, actions };
  }

  function fillComments(p, box) {
    const st = p.comments;
    if (!box) return;
    box.replaceChildren();
    if (!st || st.loading) return box.append(el('div', 'muted', 'Loading comments…'));
    if (st.error) {
      box.append(el('div', 'error', st.error));
      const retry = el('button', 'link', 'Retry');
      retry.onclick = () => loadComments(p, box);
      return box.append(retry);
    }
    if (!st.items.length) return box.append(el('div', 'muted', 'No comments yet.'));
    for (const c of st.items) {
      const { row, actions } = commentRow(c);
      box.append(row);
      const rep = st.replies.get(c.pk);
      if (c.replies && !rep) {
        const more = el('button', 'link', `View ${c.replies === 1 ? '1 reply' : `${compact.format(c.replies)} replies`}`);
        more.style.fontSize = '12px';
        more.onclick = () => loadReplies(p, c);
        actions.append(more);
      }
      if (rep) {
        const thread = el('div', 'replies');
        if (rep.loading) thread.append(el('div', 'muted', 'Loading replies…'));
        else if (rep.error) thread.append(el('div', 'error', rep.error));
        else for (const r of rep.items) thread.append(commentRow(r).row);
        box.append(thread);
      }
    }
    if (st.next) {
      const more = el('button', 'link', st.loadingMore ? 'Loading…' : 'More comments');
      more.onclick = () => !st.loadingMore && loadMore(p);
      box.append(more);
    }
  }

  // ---------- Watching a video instead ----------
  function reveal(p) {
    revealed.add(p.key);
    const video = p.anchor;
    removePanel(p);
    video.muted = false;
    video.play().catch(() => {});
  }

  function addBackButton(video, key, box) {
    if (box.querySelector(':scope > dedoom-back')) return;
    const host = document.createElement('dedoom-back');
    host.style.cssText = 'position:absolute;top:0;left:0;z-index:30;display:block;';
    if (getComputedStyle(box).position === 'static') box.style.position = 'relative';
    const root = host.attachShadow({ mode: 'open' });
    adopt(root);
    const b = el('button', 'chip back', 'Read instead');
    b.onclick = () => {
      revealed.delete(key);
      host.remove();
      video.pause();
      scan();
    };
    for (const t of ['click', 'mousedown', 'pointerdown', 'dblclick']) host.addEventListener(t, (e) => e.stopPropagation());
    root.append(b);
    box.appendChild(host);
  }

  // ---------- Keep covered videos quiet ----------
  function silence(v) {
    v.muted = true;
    if (!v.paused) v.pause();
  }
  document.addEventListener(
    'play',
    (e) => {
      const v = e.target;
      if (!(v instanceof HTMLVideoElement) || mode !== 'text') return;
      const tile = tilePanels.get(v.closest('a'));
      if (videoPanels.has(v) || (tile && tile.host.style.display !== 'none')) silence(v);
    },
    true
  );

  // ---------- Main scan ----------
  const TILE_LINK = /\/(?:reel|reels|p)\/([A-Za-z0-9_-]{5,})/;

  function isNear(node, screens) {
    const r = node.getBoundingClientRect();
    return r.bottom > -innerHeight && r.top < innerHeight * screens && r.right > 0 && r.left < innerWidth;
  }

  function scan() {
    if (mode !== 'text') return;

    // Videos anywhere on the page
    for (const v of document.querySelectorAll('video')) {
      let p = videoPanels.get(v);
      const key = keyOf(v.dataset.dedoomId);
      if (!key || !posts.has(key)) {
        if (p) removePanel(p);
        continue;
      }
      const box = mediaBox(v);
      if (!box) continue;
      if (revealed.has(key)) {
        if (p) removePanel(p);
        addBackButton(v, key, box);
        continue;
      }
      if (p && (p.key !== key || p.box !== box || !p.host.isConnected)) {
        removePanel(p);
        p = null;
      }
      if (!p) p = createVideoPanel(v, key, box);
      silence(v);
      if (isNear(p.host, 2.5)) requestTranscript(key);
    }

    // Grid tiles (Explore, profile reels): links to a known video post that show a
    // thumbnail or a muted autoplay preview (previews have no player ID, so the
    // video pass above skips them).
    for (const a of document.querySelectorAll('a[href*="/reel/"], a[href*="/reels/"], a[href*="/p/"]')) {
      if (tilePanels.has(a)) continue;
      if ([...a.querySelectorAll('video')].some((v) => videoPanels.has(v))) continue; // a full player inside a link
      const code = TILE_LINK.exec(a.getAttribute('href') || '')?.[1];
      const key = code && keyOf(code);
      if (!key || !posts.has(key) || !a.querySelector('img, video')) continue;
      const r = a.getBoundingClientRect();
      if (r.width < 90 || r.height < 90 || r.width > 700) continue;
      createTilePanel(a, key);
    }
    for (const p of panels) {
      if (p.kind !== 'tile' || !p.anchor.isConnected) continue;
      if (isNear(p.anchor, 1.2)) requestTranscript(p.key);
      if (p.host.style.display !== 'none') p.anchor.querySelectorAll('video').forEach(silence); // previews under the text
    }

    // Drop panels whose video moved elsewhere or whose tile left the page
    for (const p of [...panels]) {
      if (!p.host.isConnected || (p.kind === 'video' && (!p.anchor.isConnected || !p.box.contains(p.anchor)))) removePanel(p);
    }
  }

  // ---------- Mode switch: reading / watching ----------
  let modeHost;
  function buildModeButton() {
    if (modeHost || !document.body) return;
    modeHost = document.createElement('dedoom-mode');
    modeHost.style.cssText = 'position:fixed;left:0;bottom:0;z-index:2147483647;display:block;';
    const root = modeHost.attachShadow({ mode: 'open' });
    adopt(root);
    const b = el('button', 'mode');
    const paint = () => {
      b.replaceChildren(document.createTextNode('Dedoom: '), el('b', null, mode === 'text' ? 'reading' : 'watching'));
      b.title = mode === 'text' ? 'Videos show as text. Click to watch videos instead.' : 'Click to read videos as text.';
    };
    b.onclick = () => {
      mode = mode === 'text' ? 'video' : 'text';
      try {
        localStorage.setItem(MODE_KEY, mode);
      } catch {}
      if (mode === 'video') {
        for (const p of [...panels]) removePanel(p);
        document.querySelectorAll('dedoom-back').forEach((n) => n.remove());
      } else scan();
      paint();
    };
    paint();
    root.append(b);
    document.body.appendChild(modeHost);
  }

  let lastPath = location.pathname;
  setInterval(() => {
    buildModeButton();
    if (location.pathname !== lastPath) {
      lastPath = location.pathname;
      window.postMessage({ source: SOURCE, type: 'rescan' }, '*');
    }
    scan();
  }, 400);
})();
