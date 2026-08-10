import { requireUser, rest, select } from './_lib/db.js';

// Final submit: locks the stakeholder's votes (admin can unlock).
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const user = await requireUser(req, res, 'stakeholder');
  if (!user) return;
  if (user.signed_off_at) return res.json({ ok: true, signed_off_at: user.signed_off_at });

  const now = new Date().toISOString();
  await rest(`users?id=eq.${user.id}`, {
    method: 'PATCH',
    body: { signed_off_at: now },
    headers: { Prefer: 'return=minimal' },
  });

  const votes = await select(
    'stakeholder_votes',
    `select=vote&user_id=eq.${user.id}&vote=not.is.null`
  );
  res.json({ ok: true, signed_off_at: now, votes_cast: votes.length });
}
