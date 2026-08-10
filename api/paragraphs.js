import { requireUser, select } from './_lib/db.js';

// Full review payload: paragraphs in display order, anonymized comments, and
// (for stakeholders) the caller's own votes. Fetched once at load; voting
// posts individually afterward.
export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;

  const [paragraphs, comments] = await Promise.all([
    select(
      'paragraphs',
      'select=id,source_index,sort_order,item_type,rendered_html,change_count,section,variants&order=sort_order.asc'
    ),
    // comment_text only — source_editor stays server-side (anonymization rule)
    select('docx_comments', 'select=paragraph_id,comment_text'),
  ]);

  let myVotes = [];
  if (user.role === 'stakeholder') {
    myVotes = await select(
      'stakeholder_votes',
      `select=paragraph_id,vote,notes&user_id=eq.${user.id}`
    );
  }

  const commentsByPara = {};
  for (const c of comments) {
    (commentsByPara[c.paragraph_id] ??= []).push(c.comment_text);
  }
  const voteByPara = Object.fromEntries(myVotes.map((v) => [v.paragraph_id, v]));

  // Anonymization: the `section` column and conflict `variants` carry reviewer
  // names. Stakeholders get no section concept at all — they review the whole
  // document as one sequence — and variants stripped of attribution. Admin
  // gets real names.
  let sectionLabel = (s) => s;
  let variantView = (v) => v;
  if (user.role === 'stakeholder') {
    sectionLabel = () => null;
    variantView = (v) => ({ option: v.option, html: v.html });
  }

  res.json({
    user: { name: user.name, role: user.role, signed_off_at: user.signed_off_at },
    paragraphs: paragraphs.map((p) => ({
      ...p,
      section: sectionLabel(p.section),
      variants: p.variants ? p.variants.map(variantView) : null,
      comments: commentsByPara[p.id] ?? [],
      myVote: voteByPara[p.id]?.vote ?? null,
      myNotes: voteByPara[p.id]?.notes ?? '',
    })),
  });
}
