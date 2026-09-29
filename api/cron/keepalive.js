import { select } from '../_lib/db.js';

// Vercel Cron hits this daily so the Supabase free-tier project sees regular
// activity and doesn't auto-pause (which previously took the whole portal
// down with 500s until someone manually restored it). Trivial, cheap query —
// just needs to touch the database.
export default async function handler(req, res) {
  try {
    await select('users', 'select=id&limit=1');
    res.status(200).json({ ok: true, checked_at: new Date().toISOString() });
  } catch (err) {
    console.error('Keepalive ping failed:', err);
    res.status(503).json({ ok: false, error: err.message });
  }
}
