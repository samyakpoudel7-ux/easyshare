import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import http from 'http';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import express from 'express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { Server } from 'socket.io';
import { db } from './db.js';
import * as s3 from './storage.js';
import { sendReadReceipt } from './mailer.js';
import { startCleanup, destroyShare } from './cleanup.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const prod = process.env.NODE_ENV === 'production';
const APP_URL = process.env.APP_URL || 'http://localhost:3000';
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET || JWT_SECRET.length < 32) { console.error('Set JWT_SECRET (32+ chars)'); process.exit(1); }

const CHUNK = 16 * 1024 * 1024;       // plaintext bytes per encrypted chunk == one S3 part
const OVERHEAD = 28;                  // 12-byte IV + 16-byte GCM tag per chunk
const MAX_FILES = Number(process.env.MAX_FILES) || 100;
const MAX_BYTES = (Number(process.env.MAX_SHARE_GB) || 25) * 1024 ** 3;
const RETENTION_MS = 7 * 24 * 3600 * 1000;
const REQUIRE_LOGIN_UPLOAD = process.env.REQUIRE_LOGIN_FOR_UPLOAD === 'true';

const newId = () => crypto.randomBytes(12).toString('base64url');
const sha = (x) => crypto.createHash('sha256').update(String(x)).digest('hex');
const bad = (res, msg, code = 400) => res.status(code).json({ error: msg });
const h = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

await db.query(fs.readFileSync(path.join(here, 'schema.sql'), 'utf8'));

const app = express();
app.set('trust proxy', 1);
const server = http.createServer(app);
const io = new Server(server);

const connectSrc = ["'self'", APP_URL.replace(/^http/, 'ws'), ...(process.env.S3_CONNECT_SRC || '').split(/\s+/).filter(Boolean)];
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'"],
      imgSrc: ["'self'", 'data:', 'blob:'],
      connectSrc,
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
      upgradeInsecureRequests: prod ? [] : null,
    },
  },
  referrerPolicy: { policy: 'no-referrer' },
  crossOriginEmbedderPolicy: false,
}));
app.use(express.json({ limit: '2mb' }));
app.use(cookieParser());
app.use('/api/', rateLimit({ windowMs: 60e3, limit: 300, standardHeaders: true, legacyHeaders: false }));

// ---------- auth ----------
app.use((req, _res, next) => {
  const t = req.cookies.sid;
  if (t) { try { req.user = jwt.verify(t, JWT_SECRET); } catch { /* ignore */ } }
  next();
});
const setLogin = (res, u) =>
  res.cookie('sid', jwt.sign({ id: u.id, email: u.email }, JWT_SECRET, { expiresIn: '7d' }),
    { httpOnly: true, secure: prod, sameSite: 'lax', maxAge: 7 * 24 * 3600e3 });
const authLimiter = rateLimit({ windowMs: 15 * 60e3, limit: 30, standardHeaders: true, legacyHeaders: false });

app.post('/api/auth/register', authLimiter, h(async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const pw = String(req.body.password || '');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || email.length > 254) return bad(res, 'Enter a valid email address');
  if (pw.length < 10 || pw.length > 200) return bad(res, 'Use a password of at least 10 characters');
  try {
    const { rows: [u] } = await db.query('insert into users(email, pass_hash) values($1,$2) returning id, email',
      [email, await bcrypt.hash(pw, 12)]);
    setLogin(res, u);
    res.json({ user: { email: u.email } });
  } catch (e) {
    if (e.code === '23505') return bad(res, 'An account with this email already exists', 409);
    throw e;
  }
}));
app.post('/api/auth/login', authLimiter, h(async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const { rows: [u] } = await db.query('select * from users where email=$1', [email]);
  const ok = u && await bcrypt.compare(String(req.body.password || ''), u.pass_hash);
  if (!ok) return bad(res, 'Email or password is incorrect', 401);
  setLogin(res, u);
  res.json({ user: { email: u.email } });
}));
app.post('/api/auth/logout', (_req, res) => { res.clearCookie('sid'); res.json({ ok: true }); });
app.get('/api/auth/me', (req, res) => res.json({ user: req.user ? { email: req.user.email } : null }));

app.get('/api/config', (_req, res) =>
  res.json({ chunk: CHUNK, overhead: OVERHEAD, maxFiles: MAX_FILES, maxBytes: MAX_BYTES, retentionDays: 7, requireLoginUpload: REQUIRE_LOGIN_UPLOAD }));
app.get('/healthz', (_req, res) => res.send('ok'));

// ---------- shares (file + text rooms) ----------
const createShareLimit = rateLimit({ windowMs: 3600e3, limit: 30, standardHeaders: true, legacyHeaders: false });

const loadShare = h(async (req, res, next) => {
  const { rows: [s] } = await db.query('select * from shares where id=$1 and expires_at > now()', [req.params.id]);
  if (!s) return bad(res, 'This share was not found or has expired', 404);
  req.share = s;
  next();
});
const canWrite = (req, res, next) => {
  const a = Buffer.from(sha(req.get('x-write-token') || ''));
  const b = Buffer.from(req.share.write_hash);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return bad(res, 'This link is read-only', 403);
  next();
};

app.post('/api/shares', createShareLimit, h(async (req, res) => {
  if (REQUIRE_LOGIN_UPLOAD && !req.user) return bad(res, 'Sign in to create shares', 401);
  const id = newId();
  const writeToken = crypto.randomBytes(24).toString('base64url');
  const expiresAt = new Date(Date.now() + RETENTION_MS);
  await db.query('insert into shares(id, write_hash, owner_id, expires_at) values($1,$2,$3,$4)',
    [id, sha(writeToken), req.user?.id || null, expiresAt]);
  res.json({ id, writeToken, expiresAt });
}));

app.get('/api/shares/:id', loadShare, (req, res) =>
  res.json({ manifest: req.share.manifest, version: req.share.version, expiresAt: req.share.expires_at }));

app.put('/api/shares/:id/manifest', loadShare, canWrite, h(async (req, res) => {
  const { manifest, baseVersion } = req.body;
  if (typeof manifest !== 'string' || manifest.length > 1_000_000 || !Number.isInteger(baseVersion)) return bad(res, 'Bad manifest');
  const { rows: [u] } = await db.query(
    'update shares set manifest=$1, version=version+1 where id=$2 and version=$3 returning version',
    [manifest, req.share.id, baseVersion]);
  if (!u) {
    const { rows: [cur] } = await db.query('select manifest, version from shares where id=$1', [req.share.id]);
    return res.status(409).json({ error: 'Out of date', manifest: cur.manifest, version: cur.version });
  }
  io.to('s:' + req.share.id).emit('share:updated', { version: u.version });
  res.json({ version: u.version });
}));

app.delete('/api/shares/:id', loadShare, canWrite, h(async (req, res) => {
  await destroyShare(req.share.id, io);
  res.json({ ok: true });
}));

app.post('/api/shares/:id/files', loadShare, canWrite, h(async (req, res) => {
  const size = Number(req.body.size);
  if (!Number.isSafeInteger(size) || size < 0) return bad(res, 'Bad file size');
  const { rows: [a] } = await db.query(
    'select count(*)::int as c, coalesce(sum(size),0)::bigint as s from files where share_id=$1', [req.share.id]);
  if (a.c >= MAX_FILES) return bad(res, `A share can hold up to ${MAX_FILES} files`);
  if (a.s + size > MAX_BYTES) return bad(res, `A share can hold up to ${MAX_BYTES / 1024 ** 3} GB`, 413);
  const fileId = newId();
  const key = `b/${req.share.id}/${fileId}`;
  const parts = Math.max(1, Math.ceil(size / CHUNK));
  const uploadId = await s3.create(key);
  await db.query('insert into files(id, share_id, s3_key, upload_id, size, parts) values($1,$2,$3,$4,$5,$6)',
    [fileId, req.share.id, key, uploadId, size, parts]);
  res.json({ fileId, parts, chunk: CHUNK });
}));

const loadFile = (status) => h(async (req, res, next) => {
  const { rows: [f] } = await db.query('select * from files where id=$1 and share_id=$2 and ($3::text is null or status=$3)',
    [req.params.fid, req.share.id, status]);
  if (!f) return bad(res, 'File not found', 404);
  req.file = f;
  next();
});

app.post('/api/shares/:id/files/:fid/parts', loadShare, canWrite, loadFile('uploading'), h(async (req, res) => {
  const nums = (req.body.numbers || []).map(Number);
  if (!nums.length || nums.length > 20 || nums.some((n) => !Number.isInteger(n) || n < 1 || n > req.file.parts))
    return bad(res, 'Bad part numbers');
  const urls = {};
  await Promise.all(nums.map(async (n) => { urls[n] = await s3.partUrl(req.file.s3_key, req.file.upload_id, n); }));
  res.json({ urls });
}));

app.post('/api/shares/:id/files/:fid/complete', loadShare, canWrite, loadFile('uploading'), h(async (req, res) => {
  const f = req.file;
  const parts = req.body.parts;
  if (!Array.isArray(parts) || parts.length !== f.parts ||
      parts.some((p, i) => p.PartNumber !== i + 1 || typeof p.ETag !== 'string')) return bad(res, 'Bad parts list');
  await s3.complete(f.s3_key, f.upload_id, parts.map(({ PartNumber, ETag }) => ({ PartNumber, ETag })));
  if ((await s3.size(f.s3_key)) !== f.size + f.parts * OVERHEAD) {   // enforce declared size
    await s3.remove([f.s3_key]);
    await db.query('delete from files where id=$1', [f.id]);
    return bad(res, 'Uploaded size did not match');
  }
  await db.query("update files set status='ready', upload_id=null where id=$1", [f.id]);
  res.json({ ok: true });
}));

app.post('/api/shares/:id/files/:fid/url', loadShare, loadFile('ready'), h(async (req, res) =>
  res.json({ url: await s3.getUrl(req.file.s3_key) })));

app.delete('/api/shares/:id/files/:fid', loadShare, canWrite, loadFile(null), h(async (req, res) => {
  const f = req.file;
  if (f.status === 'ready') await s3.remove([f.s3_key]); else await s3.abort(f.s3_key, f.upload_id);
  await db.query('delete from files where id=$1', [f.id]);
  res.json({ ok: true });
}));

// ---------- secret notes ----------
const noteCreateLimit = rateLimit({ windowMs: 3600e3, limit: 60, standardHeaders: true, legacyHeaders: false });
const noteReadLimit = rateLimit({ windowMs: 15 * 60e3, limit: 40, standardHeaders: true, legacyHeaders: false });

app.post('/api/notes', noteCreateLimit, h(async (req, res) => {
  const b = req.body;
  if (typeof b.ciphertext !== 'string' || b.ciphertext.length < 20 || b.ciphertext.length > 1_400_000) return bad(res, 'Note is empty or too large');
  const now = Date.now();
  let expires;
  if (b.mode === 'burn') expires = now + 30 * 86400e3;            // unread burn notes are removed after 30 days
  else if (b.mode === 'timer') {
    const ttl = Number(b.ttlSeconds);
    if (!(ttl >= 60 && ttl <= 30 * 86400)) return bad(res, 'Timer must be between 1 minute and 30 days');
    expires = now + ttl * 1000;
  } else if (b.mode === 'date') {
    expires = Date.parse(b.expiresAt);
    if (!(expires > now + 60e3 && expires < now + 365 * 86400e3)) return bad(res, 'Pick a date between 1 minute and 1 year from now');
  } else return bad(res, 'Unknown expiry mode');
  if ((b.ownerOnly || b.notify) && !req.user) return bad(res, 'Sign in to use owner-only access or email alerts', 401);
  const pw = b.authToken ? await bcrypt.hash(String(b.authToken), 10) : null;
  if (pw && (typeof b.salt !== 'string' || typeof b.wrappedKey !== 'string')) return bad(res, 'Bad password payload');
  const id = newId();
  await db.query(
    `insert into notes(id, ciphertext, wrapped_key, salt, pw_hash, mode, expires_at, owner_id, owner_only, notify)
     values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [id, b.ciphertext, pw ? b.wrappedKey : null, pw ? b.salt : null, pw, b.mode, new Date(expires),
      req.user?.id || null, !!b.ownerOnly, !!b.notify]);
  res.json({ id, expiresAt: new Date(expires) });
}));

// Metadata never burns a note, so link-preview bots and page loads are harmless.
app.get('/api/notes/:id/meta', h(async (req, res) => {
  const { rows: [n] } = await db.query('select mode, expires_at, pw_hash, salt, owner_only from notes where id=$1 and expires_at > now()', [req.params.id]);
  if (!n) return bad(res, 'This note is gone', 404);
  res.json({ mode: n.mode, expiresAt: n.expires_at, needsPassword: !!n.pw_hash, salt: n.salt, ownerOnly: n.owner_only });
}));

app.post('/api/notes/:id/read', noteReadLimit, h(async (req, res) => {
  const { rows: [n] } = await db.query('select * from notes where id=$1 and expires_at > now()', [req.params.id]);
  if (!n) return bad(res, 'This note is gone', 404);
  if (n.owner_only) {
    if (!req.user) return bad(res, 'Sign in to open this note', 401);
    if (req.user.id !== n.owner_id) return bad(res, 'This note is private to its owner', 403);
  }
  if (n.pw_hash) {   // checked BEFORE burning: a wrong password must not destroy the note
    const t = String(req.body.authToken || '');
    if (!t || !(await bcrypt.compare(t, n.pw_hash))) return bad(res, 'Wrong password', 403);
  }
  let note = n;
  if (n.mode === 'burn') {   // atomic: exactly one reader wins
    const { rows: [d] } = await db.query('delete from notes where id=$1 returning *', [n.id]);
    if (!d) return bad(res, 'This note is gone', 404);
    note = d;
  }
  if (n.notify && n.owner_id && req.user?.id !== n.owner_id) {
    db.query('select email from users where id=$1', [n.owner_id])
      .then(({ rows: [u] }) => u && sendReadReceipt(u.email, { noteId: n.id, at: new Date(), ip: req.ip, ua: req.get('user-agent') }))
      .catch((e) => console.error('read receipt failed', e.message));
  }
  res.json({ ciphertext: note.ciphertext, wrappedKey: note.wrapped_key, mode: note.mode, expiresAt: note.expires_at });
}));

// ---------- realtime ----------
io.on('connection', (socket) => {
  socket.on('join', async (id) => {
    if (typeof id !== 'string' || id.length > 40) return;
    const { rowCount } = await db.query('select 1 from shares where id=$1 and expires_at > now()', [id]);
    if (rowCount) socket.join('s:' + id);
  });
});

// ---------- static frontend ----------
const nm = (p) => path.join(root, 'node_modules', p);
const vendor = {
  'qrcode.js': 'qrcode-generator/qrcode.js',
  'purify.js': 'dompurify/dist/purify.min.js',
  'marked.js': 'marked/marked.min.js',
  'client-zip.js': 'client-zip/index.js',
};
app.get('/vendor/:f', (req, res) => vendor[req.params.f] ? res.sendFile(nm(vendor[req.params.f])) : res.sendStatus(404));
app.use(express.static(path.join(root, 'public'), { maxAge: '5m' }));
app.get(/^\/(s|n)\/[\w-]+$/, (_req, res) => res.sendFile(path.join(root, 'public/index.html')));

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on our side. Try again.' });
});

startCleanup(io);
server.listen(process.env.PORT || 3000, () => console.log('EasyShare listening on', process.env.PORT || 3000));
