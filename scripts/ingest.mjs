// Ingests the analyzed documents into Supabase: one `paragraphs` row per
// affected (reviewable) paragraph, plus anonymized `docx_comments`.
//
// Rendering rules (per plan.md decisions):
//   - Only the final text state is rendered; deletions are applied silently
//     (deleted text simply absent, never shown, never badged).
//   - Insertions/replacements render as <mark> highlights with numbered badge
//     markers (1), (2), ... for reference in stakeholder notes.
//   - Agreed duplicates (identical edits by two reviewers) render once,
//     attributed to both.
//   - The conflict item (¶1118) becomes item_type='conflict' with per-reviewer
//     variants in JSON; stakeholders vote A / B / REJECT_BOTH on it.
//
// Safety: refuses to run if any votes exist, unless --force is passed
// (paragraph deletion cascades to votes).
//
// Usage: node scripts/ingest.mjs [--dir <folder>] [--force]

import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { analyze, REVIEWABLE } from './lib/analyze.mjs';
import { count, insert, remove } from './lib/db.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
function argValue(name, fallback) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}
const docDir = path.resolve(argValue('--dir', path.join(repoRoot, '..')));
const force = args.includes('--force');

const esc = (s) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Render a paragraph: base (original) text with all changes applied. Deletions
// vanish silently; insertions/replacements get <mark> + numbered badge.
function renderParagraph(baseText, changes) {
  const sorted = changes
    .filter((ch) => !ch.duplicateOf) // agreed duplicates render once
    .sort((a, b) => a.origStart - b.origStart || a.origEnd - b.origEnd);
  let html = '';
  let pos = 0;
  let badge = 0;
  for (const ch of sorted) {
    const start = Math.max(ch.origStart, pos);
    html += esc(baseText.slice(pos, start));
    pos = start;
    if (REVIEWABLE.has(ch.type)) {
      badge += 1;
      html += `<mark class="chg" data-marker="${badge}">${esc(ch.insText ?? '')}</mark><sup class="marker">(${badge})</sup>`;
      if (ch.type === 'replacement') pos = Math.max(pos, ch.origEnd);
    } else {
      // deletion / likely-move / move-out: text silently absent
      pos = Math.max(pos, ch.origEnd);
    }
  }
  html += esc(baseText.slice(pos));
  return { html, badge };
}

async function main() {
  const voteCount = await count('stakeholder_votes');
  if (voteCount > 0 && !force) {
    console.error(
      `ABORTING: ${voteCount} votes exist in the database. Re-ingesting deletes all ` +
        `paragraphs and their votes (cascade). Re-run with --force if you really mean it.`
    );
    process.exit(1);
  }

  const analysis = analyze(docDir, { log: console.log });
  const { source, editors, bySource, hardConflicts } = analysis;
  const reviewerOf = Object.fromEntries(editors.map((e) => [e.name, e.reviewer]));
  const conflictKeys = new Set(hardConflicts.map((c) => c.sourceParagraph));

  const paragraphRows = [];
  const commentRows = [];
  let newParaCounter = 0;

  for (const [key, b] of bySource) {
    const allChanges = [...b.perEditor.values()].flatMap(({ logical }) => logical);
    const hasReviewable = allChanges.some((ch) => REVIEWABLE.has(ch.type));
    if (!hasReviewable) continue; // invisible per no-deletions rule

    const id = crypto.randomUUID();
    const editorsHere = [...b.perEditor.keys()];
    const section = editorsHere.map((e) => reviewerOf[e]).join(' + ');

    let sourceIndex = null;
    let sortOrder;
    let baseText;
    if (typeof key === 'number') {
      sourceIndex = key;
      sortOrder = key * 10;
      baseText = source.paragraphs[key].originalText;
    } else {
      newParaCounter += 1;
      const anchor = b.anchorAfter ?? source.paragraphs.length;
      sortOrder = anchor * 10 + (key.startsWith('new:') ? 1 : 5) + newParaCounter % 4;
      baseText = b.editorOriginalText ?? '';
    }

    let itemType = 'standard';
    let variants = null;
    let renderedHtml;
    let changeCount;

    if (typeof key === 'number' && conflictKeys.has(key)) {
      itemType = 'conflict';
      const letters = ['A', 'B', 'C'];
      variants = [...b.perEditor.entries()].map(([edName, { logical }], i) => {
        const { html } = renderParagraph(baseText, logical);
        return {
          option: letters[i],
          editor: edName,
          reviewer: reviewerOf[edName],
          html,
        };
      });
      renderedHtml = esc(baseText); // original text as context above the A/B choice
      changeCount = variants.length;
    } else {
      const { html, badge } = renderParagraph(baseText, allChanges);
      renderedHtml = html;
      changeCount = badge;
    }

    paragraphRows.push({
      id,
      source_index: sourceIndex,
      sort_order: sortOrder,
      item_type: itemType,
      rendered_html: renderedHtml,
      change_count: changeCount,
      section,
      variants,
    });

    for (const c of b.comments) {
      commentRows.push({
        paragraph_id: id,
        comment_text: c.text, // already author-free (extracted text only)
        source_editor: reviewerOf[c.editor],
      });
    }
  }

  console.log('');
  console.log(`Prepared ${paragraphRows.length} paragraphs (${paragraphRows.filter((r) => r.item_type === 'conflict').length} conflict), ${commentRows.length} comments.`);

  console.log('Clearing existing paragraphs (cascades comments/votes)…');
  await remove('paragraphs', 'id=not.is.null');

  console.log('Inserting paragraphs…');
  const p = await insert('paragraphs', paragraphRows);
  console.log(`  inserted ${p}`);
  console.log('Inserting comments…');
  const c = await insert('docx_comments', commentRows);
  console.log(`  inserted ${c}`);

  const dbParas = await count('paragraphs');
  const dbComments = await count('docx_comments');
  console.log('');
  console.log(`=== INGEST COMPLETE ===`);
  console.log(`paragraphs in DB: ${dbParas} (expected ${paragraphRows.length})`);
  console.log(`docx_comments in DB: ${dbComments} (expected ${commentRows.length})`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
