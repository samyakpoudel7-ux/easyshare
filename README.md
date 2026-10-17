# EasyShare

Ad-free file, text and secret-note sharing. Everything is encrypted in the browser before upload.

- **Shares:** up to 100 files / 25 GB (configurable), deleted after exactly 7 days, live sync over WebSockets, link + QR code, per-file download or one streaming `.zip`.
- **Secret notes:** Markdown and code blocks, burn-on-read / countdown / calendar-date expiry, optional password, owner-only access, email alert when opened.
- **E2EE:** AES-256-GCM via WebCrypto. The key sits in the URL fragment (`#k=...`), which browsers never send to servers.

One Node process serves the API, the WebSocket server and the frontend from a single origin. Files go browser to S3-compatible storage directly through presigned multipart URLs, so your server never carries the 25 GB.

## Layout

```
src/server.js     API, auth, notes, shares, Socket.io, static files
src/storage.js    S3 multipart + presigned URLs
src/cleanup.js    cron: expired shares/notes, stale uploads (every minute)
src/mailer.js     read-receipt emails
src/schema.sql    Postgres tables (applied automatically on boot)
public/           index.html, js/app.js, js/crypto.js (Tailwind -> public/app.css)
```

## Run locally

```bash
npm install            # also generates package-lock.json: commit it
cp .env.example .env   # fill in JWT_SECRET, DATABASE_URL, S3_*
npm run build          # compiles Tailwind
npm run dev
```
Open http://localhost:3000. For local storage use MinIO (`S3_ENDPOINT=http://localhost:9000`, `S3_FORCE_PATH_STYLE=true`) and add `http://localhost:9000` to `S3_CONNECT_SRC`.

## Deploy

### 1. Storage (do this first): Cloudflare R2 recommended
S3 charges about $0.09/GB for downloads; R2 has no egress fees, which matters at this file size.

1. Create a bucket (e.g. `easyshare-files`) and an API token with Object Read & Write.
2. Fill `S3_BUCKET`, `S3_ENDPOINT` (`https://<accountid>.r2.cloudflarestorage.com`), `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_CONNECT_SRC=https://*.r2.cloudflarestorage.com`.
3. **CORS** on the bucket (replace the origin with your domain; browsers upload and download directly):
```json
[{ "AllowedOrigins": ["https://yourdomain.com"],
   "AllowedMethods": ["GET", "PUT"],
   "AllowedHeaders": ["*"],
   "ExposeHeaders": ["ETag"],
   "MaxAgeSeconds": 3600 }]
```
`ExposeHeaders: ETag` is required, or multipart uploads fail.
4. **Safety-net lifecycle rules** (in case the cron is down): expire objects under `b/` after 8 days, and abort incomplete multipart uploads after 1 day.

On AWS S3 instead: leave `S3_ENDPOINT` empty, set `S3_REGION`, use `S3_CONNECT_SRC=https://*.amazonaws.com`, and paste the same CORS rules (S3 console uses the JSON above).

### 2a. Render (simplest managed option)
1. Push the repo to GitHub.
2. New **PostgreSQL** on Render; copy the *Internal* connection string.
3. New **Web Service** from the repo: build `npm install && npm run build`, start `npm start`, health check path `/healthz`.
4. Add every variable from `.env.example` (set `NODE_ENV=production`, `APP_URL=https://yourdomain.com`, `PGSSL=true` if you use an external connection string).
5. Use a paid instance. Free instances sleep, which would also pause the expiry cron and drop WebSockets.

Railway works the same way (Postgres plugin + a service from the repo). Vercel and Netlify are **not** suitable for this backend: serverless functions cannot hold WebSocket connections. The frontend is served by the Node app, so you do not need them.

### 2b. Your own server (AWS EC2, Lightsail, any VPS) with Docker
```bash
git clone <your repo> && cd easyshare
cp .env.example .env     # set DOMAIN, APP_URL, JWT_SECRET, POSTGRES_PASSWORD, S3_*, SMTP_*
docker compose up -d --build
```
Caddy obtains and renews HTTPS certificates automatically. Open ports 80 and 443 in the firewall/security group.

### 3. Email read receipts
Set `SMTP_*` and `MAIL_FROM`. SendGrid: host `smtp.sendgrid.net`, port 587, user `apikey`, pass = API key. Verify your sending domain (SPF/DKIM) or alerts will land in spam.

## Domain linking
1. Buy a domain; add it in Render (Settings > Custom Domains) or point it at your server.
2. DNS: for a subdomain, create a `CNAME` to the host Render gives you; for the apex, use the `A` record shown (Render) or your server's IP (VPS). Cloudflare DNS: start with the proxy off (grey cloud) until HTTPS works.
3. Set `APP_URL=https://yourdomain.com` (used for the WebSocket CSP) and update the bucket CORS origin to match. Redeploy.
4. Check: open the site, create a share, open its link on your phone over mobile data.

## Ongoing management
- **Cleanup:** runs inside the server every minute. Manual run: `npm run cleanup`. Watch logs for `cleanup:` lines and `cleanup share failed`.
- **Backups:** only Postgres metadata matters (and it is encrypted/ephemeral by design). Enable your provider's daily snapshots.
- **Updates:** `npm update`, rebuild, redeploy. Run `npm audit` monthly.
- **Cost watch:** set a billing alert on the bucket. Storage is your main variable cost.
- **Scaling beyond one instance:** add the Socket.io Redis adapter so live-sync events reach every instance. The cron is idempotent and safe to run on several instances.

## Security model and honest limits
- **The server cannot read your content** (file names, text, notes). It sees sizes, timing, IPs and who is signed in.
- **Whoever has the full link has access.** Send the link through a channel you trust. The `w=` part of a share link grants edit rights; use "Copy read-only link" for viewers.
- **Burn-on-read** is atomic on the server. A wrong password never burns a note. Link-preview bots are harmless because the page load never reads the note; only the Open button does.
- **Password notes:** the link carries no key, so the recipient needs link and password. PBKDF2 (600k iterations) slows guessing, but weak passwords are still weak.
- **Large downloads:** Chrome and Edge stream decrypted files straight to disk at any size. Firefox and Safari must assemble the file in memory, so they are unreliable above ~1.5 GB. The `.zip` is built in the browser (the server cannot zip what it cannot read).
- **Folders:** dropping a folder is not supported yet; select its files instead.
- **Email alerts** need an account; add email verification before opening registration publicly.
- **Abuse:** anonymous 25 GB uploads can be abused. Rate limits are built in; set `REQUIRE_LOGIN_FOR_UPLOAD=true` or add a CAPTCHA (e.g. Cloudflare Turnstile) before going public.
- **Not tested end-to-end here:** this code was syntax-checked but not run against a live database and bucket. Test a full upload/download of a large file and a burn note on staging first.
