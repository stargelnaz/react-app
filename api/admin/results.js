import { requireUser, select } from '../_lib/db.js';

// Live aggregation for the admin dashboard. Polled — returns votes only (no
// paragraph HTML; the dashboard fetches /api/paragraphs once for content).
// Test users are excluded from counts and listings.
export default async function handler(req, res) {
  const user = await requireUser(req, res, 'admin');
  if (!user) return;

  const [votes, stakeholders] = await Promise.all([
    select(
      'stakeholder_votes',
      'select=paragraph_id,vote,notes,updated_at,users(name,is_test,role)'
    ),
    select('users', 'select=name,is_test,signed_off_at&role=eq.stakeholder&order=name.asc'),
  ]);

  const real = votes.filter((v) => v.users && !v.users.is_test);
  const roster = stakeholders.filter((s) => !s.is_test);

  const byParagraph = {};
  for (const v of real) {
    const agg = (byParagraph[v.paragraph_id] ??= {
      counts: { YES: 0, NO: 0, A: 0, B: 0, REJECT_BOTH: 0 },
      voted: 0,
      notes: [],
    });
    if (v.vote) {
      agg.counts[v.vote] += 1;
      agg.voted += 1;
    }
    if (v.notes && v.notes.trim() !== '') {
      agg.notes.push({ name: v.users.name, text: v.notes, updated_at: v.updated_at });
    }
  }

  res.json({
    stakeholder_count: roster.length,
    stakeholders: roster.map((s) => ({ name: s.name, signed_off_at: s.signed_off_at })),
    by_paragraph: byParagraph,
  });
}
