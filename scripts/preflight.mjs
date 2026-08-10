// Pre-flight ingestion analysis for the Document Revision & Stakeholder Voting Portal.
//
// Reports, BEFORE any portal launch:
//   1. Conflict items: overlapping non-identical edits from two+ reviewers —
//      these become A/B/Reject-Both voting cards in the portal (docx untouched).
//   2. Agreed duplicates: identical overlapping edits, auto-merged at ingestion.
//   3. Orphan deletions: invisible to stakeholders under the "no deletions" rule.
//   4. Exact count of affected (reviewable) paragraphs.
//   5. Comments attached to paragraphs with no reviewable change (also invisible).
//
// Document files and reports live OUTSIDE this public repo (default: repo parent).
//
// Usage: node scripts/preflight.mjs [--dir <folder>] [--out <folder>]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyze, snippet } from './lib/analyze.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
function argValue(name, fallback) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}
const docDir = path.resolve(argValue('--dir', path.join(repoRoot, '..')));
const outDir = path.resolve(argValue('--out', path.join(docDir, 'preflight')));

fs.mkdirSync(outDir, { recursive: true });

const {
  source, editors, editorStats, hardConflicts, softConflicts, coEdited,
  agreedDuplicates, affected, invisibleComments, invisibleCommentParas, sourceFile,
} = analyze(docDir, { log: console.log });

const report = {
  generated: new Date().toISOString(),
  files: {
    source: path.basename(sourceFile),
    editors: editors.map((e) => ({ file: e.file, reviewer: e.reviewer })),
  },
  summary: {
    source_paragraphs: source.paragraphs.length,
    affected_paragraphs: affected,
    conflict_items: hardConflicts.length,
    agreed_duplicate_edits: agreedDuplicates.length,
    soft_conflicts: softConflicts.length,
    co_edited_paragraphs: coEdited.length,
    orphan_deletions_total: editorStats.reduce((s, e) => s + e.orphan_deletions, 0),
    invisible_comments: invisibleComments,
    invisible_comment_paragraphs: invisibleCommentParas,
  },
  per_editor: editorStats.map(({ orphan_list, ...rest }) => rest),
  conflict_items: hardConflicts,
  agreed_duplicates: agreedDuplicates,
  soft_conflicts: softConflicts,
  co_edited_paragraphs: coEdited,
  orphan_deletions: Object.fromEntries(
    editorStats.map((e) => [
      e.editor,
      e.orphan_list.map((o) => ({ sourceParagraph: o.sourceParagraph, text: snippet(o.text, 120) })),
    ])
  ),
};

const jsonPath = path.join(outDir, 'preflight-report.json');
fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2), 'utf8');

const md = [];
md.push(`# Pre-flight Report`, ``, `Generated: ${report.generated}`, ``);
md.push(`## Summary`, ``);
md.push(`| Metric | Value |`, `|---|---|`);
md.push(`| Source paragraphs | ${report.summary.source_paragraphs} |`);
md.push(`| **Affected (reviewable) paragraphs** | **${affected}** |`);
md.push(`| 🗳️ Conflict items (portal vote: A / B / Reject Both) | ${hardConflicts.length} |`);
md.push(`| 🤝 Agreed duplicate edits (auto-merged) | ${agreedDuplicates.length} |`);
md.push(`| 🟡 Soft conflicts (same insertion point) | ${softConflicts.length} |`);
md.push(`| Co-edited paragraphs (no overlap) | ${coEdited.length} |`);
md.push(`| Orphan deletions (invisible to stakeholders) | ${report.summary.orphan_deletions_total} |`);
md.push(`| Comments on unchanged paragraphs (invisible) | ${invisibleComments} (${invisibleCommentParas} paragraphs) |`);
md.push(``);
md.push(`## Per-editor breakdown`, ``);
md.push(
  `| Editor | Reviewer | Section (¶ range) | Insertions | Replacements | Deletions | Orphans | Likely moves | New ¶ | Merged ¶ marks | Comments | Unaligned ¶ |`
);
md.push(`|---|---|---|---|---|---|---|---|---|---|---|---|`);
for (const s of editorStats) {
  md.push(
    `| ${s.editor} | ${s.reviewer} | ${s.min_paragraph ?? '—'}–${s.max_paragraph ?? '—'} | ${s.insertions} | ${s.replacements} | ${s.deletions_total} | ${s.orphan_deletions} | ${s.likely_moves} | ${s.new_paragraphs} | ${s.merged_paragraph_marks} | ${s.comments} | ${s.unmatched_paragraphs} |`
  );
}
md.push(``);
if (hardConflicts.length) {
  md.push(`## 🗳️ Conflict items (${hardConflicts.length})`, ``);
  md.push(
    `Overlapping, non-identical edits from two or more reviewers. Per owner decision (2026-08-10), these are NOT fixed in Word — each becomes a one-off conflict card in the portal where stakeholders vote **A / B / Reject Both** (+ notes). Variants listed per editor below.`,
    ``
  );
  for (const c of hardConflicts) {
    md.push(`### Source ¶ ${c.sourceParagraph}`);
    md.push(`> ${c.sourceText}`, ``);
    const letters = ['A', 'B', 'C'];
    Object.entries(c.variants).forEach(([ed, changes], i) => {
      md.push(`**Option ${letters[i]} (${ed}):**`);
      for (const ch of changes) {
        const del = ch.delText ? ` removes "${ch.delText}"` : '';
        const ins = ch.insText ? ` adds "${ch.insText}"` : '';
        md.push(`- ${ch.type}:${del}${ins}`);
      }
    });
    md.push(``);
  }
}
if (agreedDuplicates.length) {
  md.push(`## 🤝 Agreed duplicate edits (${agreedDuplicates.length})`, ``);
  md.push(`Identical edits made independently by two reviewers — auto-merged into a single change at ingestion (attributed to both).`, ``);
  for (const a of agreedDuplicates) {
    md.push(
      `- Source ¶ ${a.sourceParagraph} (${a.editors.join(' + ')}): ${a.type} "${a.delText}" → "${a.insText}"`
    );
  }
  md.push(``);
}
if (softConflicts.length) {
  md.push(`## 🟡 Soft conflicts (${softConflicts.length})`, ``);
  md.push(`Two reviewers inserted at the same point (no shared text modified). Review recommended, not strictly blocking.`, ``);
  for (const c of softConflicts) {
    md.push(`- Source ¶ ${c.sourceParagraph}: ${c.editors.join(' + ')} — ${c.sourceText}`);
  }
  md.push(``);
}
md.push(`## Orphan deletions by editor`, ``);
md.push(`Deleted text with no replacement or move — invisible to stakeholders under current rules.`, ``);
for (const s of editorStats) {
  md.push(`### ${s.editor} (${s.reviewer}) — ${s.orphan_deletions} orphan deletions`, ``);
  for (const o of s.orphan_list.slice(0, 50)) {
    md.push(`- ¶ ${o.sourceParagraph}: "${snippet(o.text, 100)}"`);
  }
  if (s.orphan_list.length > 50) md.push(`- …and ${s.orphan_list.length - 50} more (see JSON)`);
  md.push(``);
}

const mdPath = path.join(outDir, 'preflight-report.md');
fs.writeFileSync(mdPath, md.join('\n'), 'utf8');

console.log('');
console.log('=== PRE-FLIGHT SUMMARY ===');
console.log(`Affected (reviewable) paragraphs: ${affected}`);
console.log(`Conflict items (A/B/Reject Both vote): ${hardConflicts.length}`);
console.log(`Agreed duplicate edits (auto-merged): ${agreedDuplicates.length}`);
console.log(`Soft conflicts: ${softConflicts.length}`);
console.log(`Co-edited (non-overlapping): ${coEdited.length}`);
console.log(`Orphan deletions: ${report.summary.orphan_deletions_total}`);
console.log(`Invisible comments: ${invisibleComments}`);
console.log('');
console.log(`Reports written to:`);
console.log(`  ${jsonPath}`);
console.log(`  ${mdPath}`);
