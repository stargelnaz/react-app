import { requireUser, select } from '../_lib/db.js';

// Summary export: one row per paragraph with vote tallies, consensus, and
// attributed notes. ?format=csv (default) or json. Test users excluded.
export default async function handler(req, res) {
  const user = await requireUser(req, res, 'admin');
  if (!user) return;
  const format = (req.query?.format || 'csv').toLowerCase();

  const [paragraphs, votes] = await Promise.all([
    select(
      'paragraphs',
      'select=id,source_index,sort_order,item_type,change_count,section&order=sort_order.asc'
    ),
    select('stakeholder_votes', 'select=paragraph_id,vote,notes,users(name,is_test)'),
  ]);
  const real = votes.filter((v) => v.users && !v.users.is_test);

  const byPara = {};
  for (const v of real) (byPara[v.paragraph_id] ??= []).push(v);

  const rows = paragraphs.map((p) => {
    const pv = byPara[p.id] ?? [];
    const counts = { YES: 0, NO: 0, A: 0, B: 0, REJECT_BOTH: 0 };
    for (const v of pv) if (v.vote) counts[v.vote] += 1;
    let consensus;
    if (p.item_type === 'conflict') {
      const ranked = ['A', 'B', 'REJECT_BOTH'].sort((a, b) => counts[b] - counts[a]);
      consensus =
        counts[ranked[0]] === 0 ? 'PENDING' : counts[ranked[0]] === counts[ranked[1]] ? 'TIE' : ranked[0];
    } else {
      consensus =
        counts.YES === 0 && counts.NO === 0
          ? 'PENDING'
          : counts.YES > counts.NO
            ? 'ACCEPTED'
            : counts.NO > counts.YES
              ? 'REJECTED'
              : 'TIE';
    }
    const notes = pv
      .filter((v) => v.notes && v.notes.trim() !== '')
      .map((v) => `${v.users.name}: ${v.notes}`)
      .join(' | ');
    return {
      paragraph: p.source_index ?? `(new, order ${p.sort_order})`,
      section: p.section,
      type: p.item_type,
      changes: p.change_count,
      yes: counts.YES,
      no: counts.NO,
      option_a: counts.A,
      option_b: counts.B,
      reject_both: counts.REJECT_BOTH,
      consensus,
      notes,
    };
  });

  if (format === 'json') {
    res.setHeader('Content-Disposition', 'attachment; filename="voting-results.json"');
    return res.json(rows);
  }

  const cols = Object.keys(rows[0] ?? { paragraph: '' });
  const csvEscape = (v) => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = [
    cols.join(','),
    ...rows.map((r) => cols.map((c) => csvEscape(r[c])).join(',')),
  ].join('\n');

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="voting-results.csv"');
  // BOM so Excel opens the Chinese text as UTF-8
  res.send('﻿' + csv);
}
