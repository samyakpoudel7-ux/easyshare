import * as C from './crypto.js';
import { downloadZip } from '/vendor/client-zip.js';

const $ = (s, r = document) => r.querySelector(s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n) => { const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0; while (n >= 1024 && i < 4) { n /= 1024; i++; } return `${n.toFixed(n < 10 && i ? 1 : 0)} ${u[i]}`; };
const rid = () => C.b64u.enc(crypto.getRandomValues(new Uint8Array(9)));

let cfg, me = null, room = null, socket = null, view = 'home', tab = 'share', onAuth = null;
let pending = [];

// ---------- helpers ----------
async function api(path, { method = 'GET', body, token } = {}) {
  const r = await fetch(path, {
    method, credentials: 'same-origin',
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { 'x-write-token': token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(d.error || r.statusText), { status: r.status, data: d });
  return d;
}
let toastTimer;
function toast(msg, err = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.toggle('bg-red-700', err); t.classList.toggle('bg-slate-900', !err);
  t.classList.remove('hidden');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.add('hidden'), 3500);
}
const copy = async (text, msg = 'Copied') => { try { await navigator.clipboard.writeText(text); toast(msg); } catch { toast('Copy failed. Select the text and copy it manually.', true); } };
function renderQR(el, text) {
  const q = qrcode(0, 'M'); q.addData(text); q.make();
  el.innerHTML = q.createSvgTag({ cellSize: 6, margin: 1, scalable: true });
}
function renderMd(text) {
  const d = document.createElement('div');
  d.innerHTML = DOMPurify.sanitize(marked.parse(text, { breaks: true, gfm: true }), { USE_PROFILES: { html: true } });
  d.querySelectorAll('a').forEach((a) => { a.target = '_blank'; a.rel = 'noopener noreferrer nofollow'; });
  return d.childNodes;
}
function setView(v) {
  view = v;
  for (const n of ['home', 'share', 'note']) $('#view-' + n).classList.toggle('hidden', n !== v);
}
function panel(label, total) {
  const p = $('#upload-panel'); let done = 0;
  $('#up-label').textContent = label; p.classList.remove('hidden');
  const bump = (n) => { done += n; $('#up-bar').style.width = (total ? Math.min(100, done / total * 100) : 100) + '%'; $('#up-text').textContent = `${fmt(Math.max(0, done))} of ${fmt(total)}`; };
  bump(0);
  return { bump, name: (n) => { $('#up-name').textContent = n; }, close: () => setTimeout(() => p.classList.add('hidden'), 800) };
}
const timeLeft = (iso) => { const ms = new Date(iso) - Date.now(); if (ms <= 0) return 'expired'; const d = Math.floor(ms / 864e5), h = Math.floor(ms % 864e5 / 36e5), m = Math.floor(ms % 36e5 / 6e4); return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`; };

// ---------- auth ----------
function renderAuth() {
  const a = $('#auth-area');
  a.innerHTML = me
    ? `<span class="hidden text-slate-500 sm:inline">${esc(me.email)}</span><button id="logout" class="btn btn-ghost !py-1">Sign out</button>`
    : '<button id="login" class="btn btn-ghost !py-1">Sign in</button>';
  $('#logout')?.addEventListener('click', async () => { await api('/api/auth/logout', { method: 'POST' }); me = null; renderAuth(); toast('Signed out'); });
  $('#login')?.addEventListener('click', () => openAuth());
}
let authMode = 'login';
function openAuth(cb) {
  onAuth = cb || null; setAuthMode('login'); $('#auth-err').classList.add('hidden'); $('#auth').showModal(); $('#auth-email').focus();
}
function setAuthMode(m) {
  authMode = m;
  $('#auth-title').textContent = m === 'login' ? 'Sign in' : 'Create an account';
  $('#auth-submit').textContent = m === 'login' ? 'Sign in' : 'Create account';
  $('#auth-switch').textContent = m === 'login' ? 'Create an account' : 'I already have an account';
  $('#auth-pw').autocomplete = m === 'login' ? 'current-password' : 'new-password';
}
async function submitAuth() {
  try {
    const d = await api('/api/auth/' + (authMode === 'login' ? 'login' : 'register'),
      { method: 'POST', body: { email: $('#auth-email').value, password: $('#auth-pw').value } });
    me = d.user; $('#auth').close(); $('#auth-pw').value = ''; renderAuth();
    const cb = onAuth; onAuth = null; cb?.();
  } catch (e) { const el = $('#auth-err'); el.textContent = e.message; el.classList.remove('hidden'); }
}

// ---------- home: pending files ----------
function addPending(files) {
  for (const f of files) pending.push(f);
  const total = pending.reduce((a, f) => a + f.size, 0);
  if (pending.length > cfg.maxFiles) { pending.length = cfg.maxFiles; toast(`Only ${cfg.maxFiles} files fit in one share`, true); }
  if (total > cfg.maxBytes) { toast(`A share can hold up to ${fmt(cfg.maxBytes)}`, true); pending = pending.slice(0, -files.length || undefined); }
  renderPending();
}
function renderPending() {
  $('#pending').innerHTML = pending.map((f, i) =>
    `<li class="flex items-center justify-between gap-3 py-2"><span class="truncate">${esc(f.name)}</span><span class="flex shrink-0 items-center gap-3 text-slate-500">${fmt(f.size)}<button class="text-red-600" data-rm="${i}" aria-label="Remove ${esc(f.name)}">Remove</button></span></li>`).join('');
  $('#pending-total').textContent = pending.length ? `${pending.length} file${pending.length > 1 ? 's' : ''}, ${fmt(pending.reduce((a, f) => a + f.size, 0))}` : '';
}
function showHome() {
  setView('home');
  $('#limits').textContent = `Up to ${cfg.maxFiles} files and ${fmt(cfg.maxBytes)} per share. Deleted after ${cfg.retentionDays} days.`;
}
function setTab(t) {
  tab = t;
  $('#tab-share').setAttribute('aria-selected', t === 'share'); $('#tab-note').setAttribute('aria-selected', t === 'note');
  $('#panel-share').classList.toggle('hidden', t !== 'share'); $('#panel-note').classList.toggle('hidden', t !== 'note');
}
async function startShare() {
  const text = $('#home-text').value.trim();
  if (!pending.length && !text) return toast('Add a file or some text first', true);
  if (cfg.requireLoginUpload && !me) return openAuth(startShare);
  $('#start-share').disabled = true;
  try {
    const s = await api('/api/shares', { method: 'POST' });
    const k = C.b64u.enc(C.randomKey());
    const files = pending; pending = []; renderPending(); $('#home-text').value = '';
    history.pushState(null, '', `/s/${s.id}#k=${k}&w=${s.writeToken}`);
    await showShare(s.id, new URLSearchParams(location.hash.slice(1)));
    if (text) await sendText(text);
    if (files.length) await uploadFiles(files);
  } catch (e) { toast(e.message, true); } finally { $('#start-share').disabled = false; }
}

// ---------- share room ----------
const roomLink = (withWrite) => `${location.origin}/s/${room.id}#k=${C.b64u.enc(room.k)}${withWrite && room.w ? '&w=' + room.w : ''}`;

async function showShare(id, params) {
  setView('share');
  const k = params.get('k');
  if (!k) { toast('This link is missing its decryption key. Ask for the full link.', true); return; }
  room = { id, k: C.b64u.dec(k), w: params.get('w'), manifest: { files: [], texts: [] }, version: -1 };
  $('#room-add').classList.toggle('hidden', !room.w);
  $('#room-ro').classList.toggle('hidden', !room.w);
  $('#room-delete').classList.toggle('hidden', !room.w);
  $('#room-qr').classList.add('hidden'); $('#room-qr-btn').textContent = 'Show QR code';
  try { await loadRoom(); } catch (e) { toast(e.status === 404 ? e.message : 'Could not open this share. The link may be incomplete.', true); return; }
  socket = io();
  socket.on('connect', () => { socket.emit('join', id); loadRoom().catch(() => {}); });
  socket.on('share:updated', () => loadRoom().catch(() => {}));
  socket.on('share:deleted', () => { toast('This share was deleted'); leaveRoom(); history.pushState(null, '', '/'); route(); });
}
function leaveRoom() { socket?.disconnect(); socket = null; room = null; }

async function loadRoom() {
  const d = await api(`/api/shares/${room.id}`);
  if (d.version <= room.version) return;
  const mk = await C.manifestKey(room.k);
  room.manifest = d.manifest ? await C.decryptJSON(mk, d.manifest) : { files: [], texts: [] };
  room.version = d.version; room.expiresAt = d.expiresAt;
  renderRoom();
}
function renderRoom() {
  const { files, texts } = room.manifest;
  $('#room-link').value = roomLink(true);
  $('#room-expiry').textContent = room.expiresAt ? `Deletes in ${timeLeft(room.expiresAt)}` : '';
  $('#file-count').textContent = files.length ? `(${files.length})` : '';
  $('#no-files').classList.toggle('hidden', files.length > 0);
  $('#zip-all').classList.toggle('hidden', files.length < 2);
  $('#room-files').innerHTML = files.map((f) =>
    `<li class="flex items-center justify-between gap-3 py-3"><div class="min-w-0"><p class="truncate text-sm font-medium">${esc(f.name)}</p><p class="text-xs text-slate-500">${fmt(f.size)}</p></div>
     <div class="flex shrink-0 gap-2"><button class="btn btn-ghost !py-1" data-dl="${esc(f.id)}">Download</button>${room.w ? `<button class="btn btn-danger !py-1" data-del="${esc(f.id)}">Delete</button>` : ''}</div></li>`).join('');
  $('#texts-card').classList.toggle('hidden', texts.length === 0);
  const ul = $('#room-texts'); ul.replaceChildren();
  for (const t of texts) {
    const li = document.createElement('li'); li.className = 'rounded-lg bg-slate-100 p-3 dark:bg-slate-800';
    const pre = document.createElement('pre'); pre.className = 'whitespace-pre-wrap break-words font-mono text-sm'; pre.textContent = t.text;
    const row = document.createElement('div'); row.className = 'mt-2 flex gap-2';
    const c = document.createElement('button'); c.className = 'btn btn-ghost !py-1'; c.textContent = 'Copy'; c.onclick = () => copy(t.text);
    row.append(c);
    if (room.w) { const x = document.createElement('button'); x.className = 'btn btn-danger !py-1'; x.textContent = 'Delete'; x.onclick = () => pushManifest((m) => { m.texts = m.texts.filter((y) => y.id !== t.id); }); row.append(x); }
    li.append(pre, row); ul.append(li);
  }
}
async function pushManifest(mutate) {
  const mk = await C.manifestKey(room.k);
  for (let i = 0; i < 6; i++) {
    const m = structuredClone(room.manifest); mutate(m);
    try {
      const r = await api(`/api/shares/${room.id}/manifest`, { method: 'PUT', token: room.w, body: { manifest: await C.encryptJSON(mk, m), baseVersion: room.version } });
      room.manifest = m; room.version = r.version; renderRoom(); return;
    } catch (e) {
      if (e.status !== 409) throw e;   // someone else edited first: take their version and re-apply our change
      room.manifest = e.data.manifest ? await C.decryptJSON(mk, e.data.manifest) : { files: [], texts: [] };
      room.version = e.data.version;
    }
  }
  throw new Error('Could not save changes. Try again.');
}
async function sendText(text) {
  if (text.length > 100000) return toast('Text is limited to 100,000 characters', true);
  await pushManifest((m) => { m.texts.unshift({ id: rid(), t: Date.now(), text }); });
}

// ---------- upload ----------
function put(url, blob, onBytes) {
  return new Promise((res, rej) => {
    const x = new XMLHttpRequest(); let last = 0;
    x.open('PUT', url);
    x.upload.onprogress = (e) => { onBytes(e.loaded - last); last = e.loaded; };
    x.onload = () => {
      if (x.status < 300) { const et = x.getResponseHeader('ETag'); return et ? res(et) : rej(new Error('Storage bucket CORS must expose the ETag header')); }
      onBytes(-last); rej(new Error('Upload failed (' + x.status + ')'));
    };
    x.onerror = () => { onBytes(-last); rej(new Error('Network error during upload')); };
    x.send(blob);
  });
}
async function uploadOne(file, bump) {
  const { fileId, parts, chunk } = await api(`/api/shares/${room.id}/files`, { method: 'POST', body: { size: file.size }, token: room.w });
  try {
    const key = await C.fileKey(room.k, fileId);
    const etags = new Array(parts), cache = new Map();
    const urlFor = async (n) => {
      const b = Math.floor((n - 1) / 10);
      if (!cache.has(b)) {
        const numbers = []; for (let i = b * 10 + 1; i <= Math.min(parts, b * 10 + 10); i++) numbers.push(i);
        cache.set(b, api(`/api/shares/${room.id}/files/${fileId}/parts`, { method: 'POST', body: { numbers }, token: room.w }));
      }
      return (await cache.get(b)).urls[n];
    };
    let next = 1;
    const worker = async () => {
      while (next <= parts) {
        const n = next++;
        const ct = await C.encryptChunk(key, fileId, n - 1, await file.slice((n - 1) * chunk, n * chunk).arrayBuffer());
        let err;
        for (let a = 0; a < 4; a++) {
          try { etags[n - 1] = await put(await urlFor(n), new Blob([ct]), bump); err = null; break; } catch (e) { err = e; await sleep(1000 * 2 ** a); }
        }
        if (err) throw err;
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    await api(`/api/shares/${room.id}/files/${fileId}/complete`, { method: 'POST', token: room.w, body: { parts: etags.map((ETag, i) => ({ PartNumber: i + 1, ETag })) } });
    return { id: fileId, name: file.name, size: file.size, type: file.type, t: Date.now() };
  } catch (e) {
    api(`/api/shares/${room.id}/files/${fileId}`, { method: 'DELETE', token: room.w }).catch(() => {});
    throw e;
  }
}
async function uploadFiles(files) {
  if (!room?.w) return;
  const total = files.reduce((a, f) => a + f.size, 0);
  const p = panel('Encrypting and uploading', total);
  try {
    for (const f of files) {
      p.name(f.name);
      const meta = await uploadOne(f, p.bump);
      await pushManifest((m) => { m.files.push(meta); });   // each file appears on every device as soon as it is done
    }
  } catch (e) { toast(e.message, true); } finally { p.close(); }
}

// ---------- download ----------
function fileStream(f, bump) {
  const parts = Math.max(1, Math.ceil(f.size / cfg.chunk)), enc = cfg.chunk + cfg.overhead;
  let url, urlAt = 0, key, i = 0;
  return new ReadableStream({
    async pull(ctrl) {
      if (!key) key = await C.fileKey(room.k, f.id);
      if (!url || Date.now() - urlAt > 45 * 60e3) { url = (await api(`/api/shares/${room.id}/files/${f.id}/url`, { method: 'POST' })).url; urlAt = Date.now(); }
      if (i >= parts) return ctrl.close();
      const start = i * enc, end = Math.min(start + enc, f.size + parts * cfg.overhead) - 1;
      let res;
      for (let a = 0; a < 4; a++) {
        res = await fetch(url, { headers: { Range: `bytes=${start}-${end}` } }).catch(() => null);
        if (res && (res.status === 206 || res.status === 200)) break;
        await sleep(1000 * 2 ** a);
      }
      if (!res || !(res.status === 206 || res.status === 200)) throw new Error('Download failed');
      const plain = await C.decryptChunk(key, f.id, i, new Uint8Array(await res.arrayBuffer()));
      i++; bump?.(plain.byteLength);
      ctrl.enqueue(new Uint8Array(plain));
    },
  });
}
async function saveStream(name, make) {
  let w;
  if (window.showSaveFilePicker) {        // Chrome/Edge: stream straight to disk, any size
    try { w = await (await showSaveFilePicker({ suggestedName: name })).createWritable(); }
    catch (e) { if (e.name === 'AbortError') return; throw e; }
  }
  const stream = make();
  if (w) return stream.pipeTo(w);
  const blob = await new Response(stream).blob();   // other browsers: assembled in memory
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
}
async function downloadFile(f) {
  if (!window.showSaveFilePicker && f.size > 1.5 * 1024 ** 3 && !confirm('This browser must hold the whole file in memory. For large files use Chrome or Edge. Continue?')) return;
  const p = panel('Downloading and decrypting', f.size); p.name(f.name);
  try { await saveStream(f.name, () => fileStream(f, p.bump)); } catch (e) { toast(e.message, true); } finally { p.close(); }
}
async function downloadAll() {
  const files = room.manifest.files, total = files.reduce((a, f) => a + f.size, 0);
  if (!window.showSaveFilePicker && total > 1.5 * 1024 ** 3 && !confirm('This browser must hold the whole archive in memory. For large batches use Chrome or Edge. Continue?')) return;
  const p = panel('Building .zip', total), seen = new Map();
  const uniq = (n) => { const c = seen.get(n) || 0; seen.set(n, c + 1); if (!c) return n; const dot = n.lastIndexOf('.'); return dot > 0 ? `${n.slice(0, dot)} (${c})${n.slice(dot)}` : `${n} (${c})`; };
  try {
    await saveStream('easyshare.zip', () => downloadZip(files.map((f) => {
      const name = uniq(f.name); p.name(name);
      return { name, lastModified: new Date(f.t), input: new Response(fileStream(f, p.bump)) };
    })).body);
  } catch (e) { toast(e.message, true); } finally { p.close(); }
}

// ---------- secret notes: create ----------
function wrapSel(before, after = before) {
  const t = $('#note-body'), a = t.selectionStart, b = t.selectionEnd;
  t.setRangeText(before + t.value.slice(a, b) + after, a, b, 'end'); t.focus();
}
async function createNote() {
  const text = $('#note-body').value;
  if (!text.trim()) return toast('Write something first', true);
  const mode = $('#note-mode').value, body = { mode, ownerOnly: $('#note-owner').checked, notify: $('#note-notify').checked };
  if ((body.ownerOnly || body.notify) && !me) return openAuth(createNote);
  if (mode === 'timer') body.ttlSeconds = Number($('#note-ttl').value);
  if (mode === 'date') {
    const d = new Date($('#note-date').value);
    if (isNaN(d) || d <= Date.now()) return toast('Pick a date and time in the future', true);
    body.expiresAt = d.toISOString();
  }
  const btn = $('#create-note'); btn.disabled = true;
  try {
    const raw = C.randomKey(), pw = $('#note-pw').value; let frag = '';
    body.ciphertext = await C.encryptJSON(await C.aesKey(raw), { text, v: 1 });
    if (pw) {
      const salt = crypto.getRandomValues(new Uint8Array(16));
      const { wrapKey, authToken } = await C.fromPassword(pw, salt);
      Object.assign(body, { salt: C.b64u.enc(salt), wrappedKey: await C.wrapRaw(wrapKey, raw), authToken });
    } else frag = '#k=' + C.b64u.enc(raw);
    const { id } = await api('/api/notes', { method: 'POST', body });
    const link = `${location.origin}/n/${id}${frag}`;
    $('#note-link').value = link; renderQR($('#note-qr'), link);
    $('#note-result-hint').textContent = pw ? 'Share the password separately. The link alone cannot open the note.' : 'Anyone with this exact link can open it. Send it only to the person it is for.';
    $('#note-result').classList.remove('hidden'); $('#note-body').value = ''; $('#note-pw').value = '';
  } catch (e) {
    if (e.status === 401) openAuth(createNote); else toast(e.message, true);
  } finally { btn.disabled = false; }
}

// ---------- secret notes: open ----------
async function showNote(id, params) {
  setView('note'); $('#note-content').classList.add('hidden');
  const gate = $('#note-gate'); gate.classList.remove('hidden');
  let meta;
  try { meta = await api(`/api/notes/${id}/meta`); }
  catch { gate.innerHTML = '<h1 class="text-lg font-semibold">This note is gone</h1><p class="mt-2 text-sm text-slate-600 dark:text-slate-400">It was already read, has expired, or never existed.</p>'; return; }
  const warn = { burn: 'This note destroys itself the moment you open it. Copy what you need.', timer: `This note expires in ${timeLeft(meta.expiresAt)}.`, date: `This note expires on ${new Date(meta.expiresAt).toLocaleString()}.` }[meta.mode];
  gate.innerHTML = `<h1 class="text-lg font-semibold">Someone sent you a secret note</h1><p class="mt-2 text-sm text-slate-600 dark:text-slate-400">${esc(warn)}</p>
    ${meta.ownerOnly ? '<p class="mt-2 text-sm">Only its owner can open this note.</p>' : ''}
    ${meta.needsPassword ? '<div class="mt-4"><label class="label" for="gate-pw">Password</label><input id="gate-pw" type="password" class="input" autocomplete="off"></div>' : ''}
    <button id="reveal" class="btn btn-primary mt-4 w-full">${meta.ownerOnly && !me ? 'Sign in to open' : 'Open note'}</button>`;
  $('#reveal').onclick = async () => {
    if (meta.ownerOnly && !me) return openAuth(() => showNote(id, params));
    const btn = $('#reveal'); btn.disabled = true;
    try {
      const req = {}; let wrapKey;
      if (meta.needsPassword) {
        const pw = $('#gate-pw').value; if (!pw) throw new Error('Enter the password');
        const r = await C.fromPassword(pw, C.b64u.dec(meta.salt)); req.authToken = r.authToken; wrapKey = r.wrapKey;
      } else if (!params.get('k')) throw new Error('This link is missing its key. Ask for the full link. The note has not been opened.');
      const d = await api(`/api/notes/${id}/read`, { method: 'POST', body: req });
      const raw = meta.needsPassword ? await C.unwrapRaw(wrapKey, d.wrappedKey) : C.b64u.dec(params.get('k'));
      const { text } = await C.decryptJSON(await C.aesKey(raw), d.ciphertext);
      gate.classList.add('hidden'); $('#note-content').classList.remove('hidden');
      $('#note-render').replaceChildren(...renderMd(text));
      $('#note-copy-text').onclick = () => copy(text);
      $('#note-status').textContent = d.mode === 'burn' ? 'This note has been destroyed. Copy it now; it cannot be opened again.' : `Expires ${new Date(d.expiresAt).toLocaleString()}`;
    } catch (e) {
      if (e.status === 401) openAuth(() => showNote(id, params)); else toast(e.message, true);
      btn.disabled = false;
    }
  };
}

// ---------- routing & wiring ----------
function route() {
  const m = location.pathname.match(/^\/(s|n)\/([\w-]+)$/), params = new URLSearchParams(location.hash.slice(1));
  leaveRoom();
  if (m?.[1] === 's') showShare(m[2], params); else if (m) showNote(m[2], params); else showHome();
}

function wire() {
  $('#logo').onclick = (e) => { e.preventDefault(); history.pushState(null, '', '/'); route(); };
  addEventListener('popstate', route); addEventListener('hashchange', () => { if (view !== 'home') route(); });
  $('#tab-share').onclick = () => setTab('share'); $('#tab-note').onclick = () => setTab('note');

  const dz = (el, onFiles) => {
    ['dragenter', 'dragover'].forEach((ev) => el.addEventListener(ev, (e) => { e.preventDefault(); el.classList.add('border-teal-600', 'bg-teal-50', 'dark:bg-teal-950'); }));
    ['dragleave', 'drop'].forEach((ev) => el.addEventListener(ev, (e) => { e.preventDefault(); el.classList.remove('border-teal-600', 'bg-teal-50', 'dark:bg-teal-950'); }));
    el.addEventListener('drop', (e) => onFiles([...e.dataTransfer.files]));
  };
  dz($('#dropzone'), addPending); dz($('#room-drop'), uploadFiles);
  $('#file-input').onchange = (e) => { addPending([...e.target.files]); e.target.value = ''; };
  $('#room-file').onchange = (e) => { uploadFiles([...e.target.files]); e.target.value = ''; };
  $('#pending').onclick = (e) => { const i = e.target.dataset.rm; if (i !== undefined) { pending.splice(+i, 1); renderPending(); } };
  $('#start-share').onclick = startShare;

  document.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files || [])];
    const inField = e.target.closest?.('input,textarea,select');
    if (files.length) {
      e.preventDefault();
      if (view === 'share' && room?.w) uploadFiles(files); else if (view === 'home' && tab === 'share') addPending(files);
      return;
    }
    if (inField) return;
    const text = e.clipboardData?.getData('text');
    if (!text) return;
    if (view === 'share' && room?.w) sendText(text);
    else if (view === 'home') { const t = tab === 'share' ? $('#home-text') : $('#note-body'); t.value += text; }
  });

  $('#md-toolbar').onclick = (e) => {
    const k = e.target.closest('[data-md]')?.dataset.md; if (!k) return;
    if (k === 'bold') wrapSel('**'); else if (k === 'italic') wrapSel('_'); else if (k === 'code') wrapSel('`');
    else if (k === 'block') wrapSel('\n```\n', '\n```\n'); else wrapSel('\n- ', '');
  };
  $('#note-preview-btn').onclick = () => {
    const p = $('#note-preview'), on = p.classList.toggle('hidden') === false;
    $('#note-body').classList.toggle('hidden', on); $('#note-preview-btn').textContent = on ? 'Edit' : 'Preview';
    if (on) p.replaceChildren(...renderMd($('#note-body').value || '*Nothing to preview yet*'));
  };
  $('#note-mode').onchange = (e) => { $('#ttl-wrap').classList.toggle('hidden', e.target.value !== 'timer'); $('#date-wrap').classList.toggle('hidden', e.target.value !== 'date'); };
  $('#create-note').onclick = createNote;
  $('#note-copy').onclick = () => copy($('#note-link').value, 'Link copied');

  $('#room-copy').onclick = () => copy(roomLink(true), 'Link copied');
  $('#room-ro').onclick = () => copy(roomLink(false), 'Read-only link copied');
  $('#room-qr-btn').onclick = () => {
    const q = $('#room-qr'), show = q.classList.toggle('hidden') === false;
    $('#room-qr-btn').textContent = show ? 'Hide QR code' : 'Show QR code'; if (show) renderQR(q, roomLink(true));
  };
  $('#room-delete').onclick = async () => {
    if (!confirm('Delete this share and every file in it for everyone?')) return;
    try { await api(`/api/shares/${room.id}`, { method: 'DELETE', token: room.w }); } catch (e) { toast(e.message, true); }
  };
  $('#room-send').onclick = async () => { const t = $('#room-text').value.trim(); if (!t) return; try { await sendText(t); $('#room-text').value = ''; } catch (e) { toast(e.message, true); } };
  $('#zip-all').onclick = downloadAll;
  $('#room-files').onclick = async (e) => {
    const dl = e.target.dataset.dl, del = e.target.dataset.del;
    if (dl) downloadFile(room.manifest.files.find((f) => f.id === dl));
    if (del && confirm('Delete this file for everyone?')) {
      try { await pushManifest((m) => { m.files = m.files.filter((f) => f.id !== del); }); await api(`/api/shares/${room.id}/files/${del}`, { method: 'DELETE', token: room.w }); }
      catch (err) { toast(err.message, true); }
    }
  };

  $('#auth-submit').onclick = submitAuth;
  $('#auth-cancel').onclick = () => $('#auth').close();
  $('#auth-switch').onclick = () => setAuthMode(authMode === 'login' ? 'register' : 'login');
  $('#auth-pw').onkeydown = (e) => { if (e.key === 'Enter') submitAuth(); };
  setInterval(() => { if (room?.expiresAt) $('#room-expiry').textContent = `Deletes in ${timeLeft(room.expiresAt)}`; }, 30000);
}

(async function init() {
  cfg = await api('/api/config');
  try { me = (await api('/api/auth/me')).user; } catch { /* anonymous */ }
  renderAuth(); wire(); route();
})();
