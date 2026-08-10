import { requireUser, rest, select } from '../_lib/db.js';

// Clears a stakeholder's sign-off so they can revise votes (per plan default:
// submit locks, admin can unlock).
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const user = await requireUser(req, res, 'admin');
  if (!user) return;

  const { name } = req.body ?? {};
  if (!name) return res.status(400).json({ error: 'name required' });

  const rows = await select(
    'users',
    `select=id,name,role&name=eq.${encodeURIComponent(name)}&role=eq.stakeholder&limit=1`
  );
  if (!rows[0]) return res.status(404).json({ error: 'No stakeholder with that name' });

  await rest(`users?id=eq.${rows[0].id}`, {
    method: 'PATCH',
    body: { signed_off_at: null },
    headers: { Prefer: 'return=minimal' },
  });
  res.json({ ok: true, unlocked: rows[0].name });
}
