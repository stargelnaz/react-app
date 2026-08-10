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
//   - Repeated identical replacements (same old text -> same new text, both
//     sides substantive, occurring minCount+ times) become one item_type='term'
//     card each, voted YES/NO once for the whole document. Their occurrences
//     render in paragraph cards as covered (highlighted, unbadged, not
//     votable); paragraphs left with no votable change are omitted entirely.
//     Tune/curate via scripts/terms.config.json { minCount, minLen, exclude }.
//
// Safety: refuses to run if any votes exist, unless --force is passed
// (paragraph deletion cascades to votes).
//
// Usage: node scripts/ingest.mjs [--dir <folder>] [--force]

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { analyze, isReviewable, normalize } from './lib/analyze.mjs';
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
// Changes covered by a document-wide term card are highlighted but unbadged —
// they are decided on the term card, not here.
function renderParagraph(baseText, changes, isCovered = () => false) {
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
    if (isReviewable(ch)) {
      if (isCovered(ch)) {
        html += `<mark class="chg chg-covered" title="Voted document-wide 全文詞彙投票項">${esc(ch.insText ?? '')}</mark>`;
      } else {
        badge += 1;
        html += `<mark class="chg" data-marker="${badge}">${esc(ch.insText ?? '')}</mark><sup class="marker">(${badge})</sup>`;
      }
      if (ch.type === 'replacement') pos = Math.max(pos, ch.origEnd);
    } else {
      // Silent changes: deletions vanish; punctuation-only insertions and
      // replacements are applied without highlight or badge.
      if (ch.insText) html += esc(ch.insText);
      pos = Math.max(pos, ch.origEnd);
    }
  }
  html += esc(baseText.slice(pos));
  return { html, badge };
}

// --- Document-wide term groups -------------------------------------------
// A term group is the same replacement (identical old and new text after
// whitespace normalization) made minCount+ times, with both sides at least
// minLen chars. Single-character grammar tweaks (的/之/地...) stay as
// individual paragraph votes because their correctness is context-dependent.

const termKeyOf = (ch) =>
  ch.type === 'replacement'
    ? `${normalize(ch.delText || '')}→${normalize(ch.insText || '')}`
    : null;

function loadTermsConfig() {
  const file = path.join(repoRoot, 'scripts', 'terms.config.json');
  const cfg = { minCount: 3, minLen: 2, exclude: [] };
  if (fs.existsSync(file)) Object.assign(cfg, JSON.parse(fs.readFileSync(file, 'utf8')));
  return cfg;
}

function detectTermGroups(source, bySource, conflictKeys, cfg) {
  const groups = new Map();
  for (const [key, b] of bySource) {
    if (typeof key === 'number' && conflictKeys.has(key)) continue;
    const baseText =
      typeof key === 'number'
        ? source.paragraphs[key].originalText
        : (b.editorOriginalText ?? '');
    for (const [edName, { logical }] of b.perEditor) {
      for (const ch of logical) {
        if (!isReviewable(ch) || ch.duplicateOf || ch.type !== 'replacement') continue;
        const del = normalize(ch.delText || '');
        const ins = normalize(ch.insText || '');
        if (del.length < cfg.minLen || ins.length < cfg.minLen) continue;
        const gk = `${del}→${ins}`;
        if (!groups.has(gk))
          groups.set(gk, {
            key: gk,
            del: ch.delText,
            ins: ch.insText,
            count: 0,
            editors: new Set(),
            occurrences: [],
          });
        const g = groups.get(gk);
        g.count += 1;
        g.editors.add(edName);
        if (ch.agreedWith) g.editors.add(ch.agreedWith);
        g.occurrences.push({ sourceKey: key, baseText, ch });
      }
    }
  }
  return [...groups.values()]
    .filter((g) => g.count >= cfg.minCount && !cfg.exclude.includes(`${g.del}→${g.ins}`))
    .sort((a, b) => b.count - a.count);
}

// Short in-context snippet for a term occurrence, final text with the new
// term highlighted (same no-deletions presentation as paragraph cards).
function termExample(baseText, ch) {
  const CTX = 36;
  const pre = baseText.slice(Math.max(0, ch.origStart - CTX), ch.origStart);
  const post = baseText.slice(ch.origEnd, ch.origEnd + CTX);
  const preEll = ch.origStart > CTX ? '…' : '';
  const postEll = ch.origEnd + CTX < baseText.length ? '…' : '';
  return `${preEll}${esc(pre)}<mark class="chg">${esc(ch.insText ?? '')}</mark>${esc(post)}${postEll}`;
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

  const termsCfg = loadTermsConfig();
  const termGroups = detectTermGroups(source, bySource, conflictKeys, termsCfg);
  const termKeys = new Set(termGroups.map((g) => g.key));
  const isCovered = (ch) => termKeys.has(termKeyOf(ch));

  console.log('');
  console.log(`Term groups (minCount=${termsCfg.minCount}, minLen=${termsCfg.minLen}, ${termsCfg.exclude.length} excluded):`);
  for (const g of termGroups) {
    console.log(`  x${String(g.count).padStart(3)}  "${g.del}" -> "${g.ins}"  [${[...g.editors].map((e) => reviewerOf[e]).join(', ')}]`);
  }

  const paragraphRows = [];
  const commentRows = [];
  let newParaCounter = 0;

  termGroups.forEach((g, i) => {
    const examples = [];
    const seenParas = new Set();
    for (const o of g.occurrences) {
      if (seenParas.has(o.sourceKey)) continue;
      seenParas.add(o.sourceKey);
      examples.push({
        para: typeof o.sourceKey === 'number' ? o.sourceKey : null,
        html: termExample(o.baseText, o.ch),
      });
      if (examples.length >= 5) break;
    }
    paragraphRows.push({
      id: crypto.randomUUID(),
      source_index: null,
      sort_order: -100000 + i * 10, // term cards come before every paragraph
      item_type: 'term',
      rendered_html: `<span class="term-old">${esc(g.del)}</span><span class="term-arrow">→</span><mark class="chg">${esc(g.ins)}</mark>`,
      change_count: g.count,
      section: [...g.editors].map((e) => reviewerOf[e]).join(' + '),
      variants: {
        del: g.del,
        ins: g.ins,
        count: g.count,
        reviewers: [...g.editors].map((e) => reviewerOf[e]),
        examples,
        paragraphs: [
          ...new Set(
            g.occurrences
              .map((o) => (typeof o.sourceKey === 'number' ? o.sourceKey : null))
              .filter((n) => n !== null)
          ),
        ],
      },
    });
  });

  let coveredOnlyParas = 0;
  let coveredOnlyComments = 0;

  for (const [key, b] of bySource) {
    const allChanges = [...b.perEditor.values()].flatMap(({ logical }) => logical);
    const hasReviewable = allChanges.some(isReviewable);
    if (!hasReviewable) continue; // invisible per no-deletions / punctuation-only rules

    // Paragraphs whose every votable change is decided on a term card carry
    // nothing left to vote on — omit them (conflict card is always kept).
    const isConflictPara = typeof key === 'number' && conflictKeys.has(key);
    if (!isConflictPara && !allChanges.some((ch) => isReviewable(ch) && !isCovered(ch))) {
      coveredOnlyParas += 1;
      coveredOnlyComments += b.comments.length;
      continue;
    }

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

    if (isConflictPara) {
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
      const { html, badge } = renderParagraph(baseText, allChanges, isCovered);
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
  console.log(
    `Prepared ${paragraphRows.length} items: ` +
      `${paragraphRows.filter((r) => r.item_type === 'standard').length} standard, ` +
      `${paragraphRows.filter((r) => r.item_type === 'conflict').length} conflict, ` +
      `${paragraphRows.filter((r) => r.item_type === 'term').length} term cards; ` +
      `${commentRows.length} comments.`
  );
  console.log(
    `Term coverage dropped ${coveredOnlyParas} paragraphs whose only changes are term-card ` +
      `occurrences (${coveredOnlyComments} Word comments on them become invisible).`
  );

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
