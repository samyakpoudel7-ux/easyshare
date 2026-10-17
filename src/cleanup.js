import 'dotenv/config';
import cron from 'node-cron';
import { db } from './db.js';
import * as s3 from './storage.js';

export async function destroyShare(id, io) {
  const { rows: files } = await db.query('select s3_key, upload_id, status from files where share_id=$1', [id]);
  await Promise.all(files.filter((f) => f.status !== 'ready').map((f) => s3.abort(f.s3_key, f.upload_id)));
  await s3.remove(files.filter((f) => f.status === 'ready').map((f) => f.s3_key)); // throws -> row kept, retried next run
  await db.query('delete from shares where id=$1', [id]); // files rows cascade
  io?.to('s:' + id).emit('share:deleted');
}

let running = false;
export async function runCleanup(io) {
  if (running) return;
  running = true;
  try {
    const n = await db.query('delete from notes where expires_at <= now()');
    const { rows: shares } = await db.query('select id from shares where expires_at <= now() limit 200');
    for (const s of shares) {
      try { await destroyShare(s.id, io); } catch (e) { console.error('cleanup share failed', s.id, e.message); }
    }
    const { rows: stale } = await db.query(
      "select id, s3_key, upload_id from files where status='uploading' and created_at < now() - interval '24 hours'");
    for (const f of stale) {
      await s3.abort(f.s3_key, f.upload_id);
      await db.query('delete from files where id=$1', [f.id]);
    }
    if (n.rowCount || shares.length || stale.length)
      console.log(`cleanup: ${n.rowCount} notes, ${shares.length} shares, ${stale.length} stale uploads`);
  } catch (e) {
    console.error('cleanup failed', e);
  } finally {
    running = false;
  }
}

// Every minute: content becomes unreachable at its exact expiry (queries filter on expires_at),
// and is physically deleted within ~60s.
export const startCleanup = (io) => cron.schedule('* * * * *', () => runCleanup(io));

if (process.argv[1]?.endsWith('cleanup.js') && process.argv.includes('--once')) {
  await runCleanup();
  await db.end();
}
