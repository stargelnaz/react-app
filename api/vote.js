import { requireUser, select, rest } from './_lib/db.js';

const STANDARD_VOTES = new Set(['YES', 'NO']);
const CONFLICT_VOTES = new Set(['A', 'B', 'REJECT_BOTH']);
const MAX_NOTES = 10000;

// Auto-save endpoint: upserts the caller's vote/notes for one paragraph.
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const user = await requireUser(req, res, 'stakeholder');
  if (!user) return;
  if (user.signed_off_at) {
    return res
      .status(403)
      .json({ error: 'You have signed off. Ask the admin to unlock your votes to make changes.' });
  }

  const { paragraphId, vote = null, notes = '' } = req.body ?? {};
  if (!paragraphId) return res.status(400).json({ error: 'paragraphId required' });
  if (typeof notes !== 'string' || notes.length > MAX_NOTES) {
    return res.status(400).json({ error: `notes must be a string of at most ${MAX_NOTES} chars` });
  }

  const paras = await select(
    'paragraphs',
    `select=id,item_type&id=eq.${encodeURIComponent(paragraphId)}&limit=1`
  );
  const para = paras[0];
  if (!para) return res.status(404).json({ error: 'Unknown paragraph' });

  const allowed = para.item_type === 'conflict' ? CONFLICT_VOTES : STANDARD_VOTES;
  if (vote !== null && !allowed.has(vote)) {
    return res.status(400).json({ error: `vote must be one of ${[...allowed].join(', ')} or null` });
  }

  await rest('stakeholder_votes?on_conflict=paragraph_id,user_id', {
    method: 'POST',
    body: {
      paragraph_id: paragraphId,
      user_id: user.id,
      vote,
      notes,
      updated_at: new Date().toISOString(),
    },
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
  });

  res.json({ ok: true });
}
