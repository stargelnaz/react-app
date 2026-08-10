// Shared DOCX tracked-changes analysis for the Document Revision & Stakeholder
// Voting Portal. Used by both preflight.mjs (reports) and ingest.mjs (database
// load) so the two can never disagree about what the documents contain.
//
// Pipeline: unzip .docx -> parse word/document.xml (order-preserving) -> per
// paragraph, reconstruct original & final text with change events -> align
// editor paragraphs to the baseline source by original-text content (handles
// paragraph merges and splits) -> classify logical changes (insertion,
// replacement, deletion, moves) -> aggregate per source paragraph across the
// three editors -> detect conflicts and agreed duplicates.

import fs from 'node:fs';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { XMLParser } from 'fast-xml-parser';

const parser = new XMLParser({
  preserveOrder: true,
  ignoreAttributes: false,
  attributeNamePrefix: '',
  trimValues: false,
});

// ---------------------------------------------------------------------------
// OOXML helpers
// ---------------------------------------------------------------------------

function nodeName(node) {
  return Object.keys(node).find((k) => k !== ':@');
}
function children(node) {
  const name = nodeName(node);
  return Array.isArray(node[name]) ? node[name] : [];
}
function attrs(node) {
  return node[':@'] || {};
}

function loadXml(zip, entryName) {
  const entry = zip.getEntry(entryName);
  if (!entry) return null;
  return parser.parse(entry.getData().toString('utf8'));
}

// Collect every w:p in document order, recursing through tables, sdt blocks, etc.
function collectParagraphs(nodes, out = []) {
  for (const node of nodes) {
    const name = nodeName(node);
    if (!name || name === '#text') continue;
    if (name === 'w:p') out.push(node);
    else collectParagraphs(children(node), out);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Paragraph event extraction
// ---------------------------------------------------------------------------

const CONTAINER_TAGS = new Set([
  'w:hyperlink', 'w:smartTag', 'w:sdt', 'w:sdtContent', 'w:fldSimple',
  'w:bdo', 'w:dir', 'w:customXml',
]);

function extractParagraph(pNode) {
  const events = [];
  const commentIds = [];
  let paraMarkDeleted = false;

  function emit(kind, text, author) {
    if (kind === 'skip' || !text) return;
    const last = events[events.length - 1];
    if (last && last.kind === kind && (kind === 'text' || last.author === author)) {
      last.text += text;
    } else {
      events.push({ kind, text, author: author || null });
    }
  }

  function runText(runNode, kind, author) {
    for (const child of children(runNode)) {
      const name = nodeName(child);
      if (name === 'w:t') {
        const t = children(child).map((c) => c['#text'] ?? '').join('');
        emit(kind, t, author);
      } else if (name === 'w:delText') {
        const t = children(child).map((c) => c['#text'] ?? '').join('');
        emit(kind === 'ins' ? 'skip' : kind === 'text' ? 'del' : kind, t, author);
      } else if (name === 'w:tab') {
        emit(kind, '\t', author);
      } else if (name === 'w:br' || name === 'w:cr') {
        emit(kind, '\n', author);
      } else if (name === 'w:noBreakHyphen') {
        emit(kind, '-', author);
      }
    }
  }

  function walk(nodes, kind, author) {
    for (const node of nodes) {
      const name = nodeName(node);
      if (!name || name === '#text') continue;
      if (name === 'w:pPr') {
        for (const pc of children(node)) {
          if (nodeName(pc) === 'w:rPr') {
            for (const rc of children(pc)) {
              if (nodeName(rc) === 'w:del') paraMarkDeleted = true;
            }
          }
        }
      } else if (name === 'w:ins') {
        walk(children(node), kind === 'del' ? 'skip' : 'ins', attrs(node)['w:author']);
      } else if (name === 'w:del') {
        walk(children(node), kind === 'ins' ? 'skip' : 'del', attrs(node)['w:author']);
      } else if (name === 'w:moveFrom') {
        walk(children(node), 'moveFrom', attrs(node)['w:author']);
      } else if (name === 'w:moveTo') {
        walk(children(node), 'moveTo', attrs(node)['w:author']);
      } else if (name === 'w:r') {
        runText(node, kind, author);
      } else if (name === 'w:commentRangeStart') {
        commentIds.push(attrs(node)['w:id']);
      } else if (CONTAINER_TAGS.has(name)) {
        walk(children(node), kind, author);
      }
    }
  }

  walk(children(pNode), 'text', null);

  let originalText = '';
  let finalText = '';
  const changes = [];
  for (const ev of events) {
    const inOriginal = ev.kind === 'text' || ev.kind === 'del' || ev.kind === 'moveFrom';
    const inFinal = ev.kind === 'text' || ev.kind === 'ins' || ev.kind === 'moveTo';
    if (ev.kind !== 'text') {
      changes.push({
        kind: ev.kind,
        text: ev.text,
        author: ev.author,
        origStart: originalText.length,
        finalStart: finalText.length,
      });
    }
    if (inOriginal) originalText += ev.text;
    if (inFinal) finalText += ev.text;
  }

  return { events, changes, originalText, finalText, commentIds, paraMarkDeleted };
}

// ---------------------------------------------------------------------------
// Change classification
// ---------------------------------------------------------------------------

export const normalize = (s) => s.replace(/[\s ]+/g, '');
export const snippet = (s, n = 60) => (s.length > n ? `${s.slice(0, n)}…` : s);
export const REVIEWABLE = new Set(['insertion', 'replacement', 'move-in']);

// Owner decision 2026-08-10: changes touching ONLY punctuation/symbols/spacing
// are applied silently and never voted on. A change that includes any real
// wording stays reviewable.
const PUNCT_ONLY_RE = /^[\s\p{P}\p{S}]+$/u;
const isPunctText = (s) => s !== undefined && s !== '' && PUNCT_ONLY_RE.test(s);
export const isReviewable = (ch) => REVIEWABLE.has(ch.type) && !ch.punctOnly;

function classifyChanges(paragraph, docInsertedTexts) {
  const seq = [];
  let changeIdx = 0;
  for (const ev of paragraph.events) {
    if (ev.kind === 'text') {
      if (ev.text.trim() !== '' || ev.text.length > 2) seq.push({ separator: true });
    } else {
      seq.push({ separator: false, change: paragraph.changes[changeIdx++] });
    }
  }

  const logical = [];
  let i = 0;
  while (i < seq.length) {
    if (seq[i].separator) {
      i += 1;
      continue;
    }
    const cur = seq[i].change;
    const nextEntry = seq[i + 1];
    const next = nextEntry && !nextEntry.separator ? nextEntry.change : null;
    const isPair =
      next &&
      ((cur.kind === 'del' && next.kind === 'ins') ||
        (cur.kind === 'ins' && next.kind === 'del'));
    if (isPair) {
      const del = cur.kind === 'del' ? cur : next;
      const ins = cur.kind === 'ins' ? cur : next;
      logical.push({
        type: 'replacement',
        delText: del.text,
        insText: ins.text,
        author: ins.author || del.author,
        origStart: del.origStart,
        origEnd: del.origStart + del.text.length,
        finalStart: ins.finalStart,
      });
      i += 2;
      continue;
    }
    if (cur.kind === 'ins' || cur.kind === 'moveTo') {
      logical.push({
        type: cur.kind === 'moveTo' ? 'move-in' : 'insertion',
        insText: cur.text,
        author: cur.author,
        origStart: cur.origStart,
        origEnd: cur.origStart,
        finalStart: cur.finalStart,
      });
    } else {
      logical.push({
        type: cur.kind === 'moveFrom' ? 'move-out' : 'deletion',
        delText: cur.text,
        author: cur.author,
        origStart: cur.origStart,
        origEnd: cur.origStart + cur.text.length,
      });
    }
    i += 1;
  }

  for (const ch of logical) {
    if (ch.type === 'deletion') {
      const norm = normalize(ch.delText);
      if (norm.length >= 4 && docInsertedTexts.has(norm)) ch.type = 'likely-move';
    }
    const texts = [ch.insText, ch.delText].filter((t) => t !== undefined && t !== '');
    ch.punctOnly = texts.length > 0 && texts.every(isPunctText);
  }
  return logical;
}

// ---------------------------------------------------------------------------
// Comments
// ---------------------------------------------------------------------------

function extractComments(zip) {
  const doc = loadXml(zip, 'word/comments.xml');
  if (!doc) return new Map();
  const map = new Map();
  function findComments(nodes) {
    for (const node of nodes) {
      const name = nodeName(node);
      if (name === 'w:comment') {
        const id = attrs(node)['w:id'];
        const paras = collectParagraphs(children(node));
        const text = paras
          .map((p) => extractParagraph(p).finalText)
          .join('\n')
          .trim();
        map.set(id, { text, author: attrs(node)['w:author'] || null });
      } else if (name && name !== '#text') {
        findComments(children(node));
      }
    }
  }
  findComments(doc);
  return map;
}

// ---------------------------------------------------------------------------
// Document loading & alignment
// ---------------------------------------------------------------------------

export function loadDocument(filePath) {
  const zip = new AdmZip(filePath);
  const doc = loadXml(zip, 'word/document.xml');
  const paragraphs = collectParagraphs(doc).map(extractParagraph);
  const comments = extractComments(zip);
  return { paragraphs, comments };
}

function alignToSource(sourceParas, editorParas) {
  const sourceMap = new Map();
  sourceParas.forEach((p, idx) => {
    const key = p.originalText;
    if (!sourceMap.has(key)) sourceMap.set(key, []);
    sourceMap.get(key).push(idx);
  });

  const alignment = new Array(editorParas.length);
  const used = new Set();
  let cursor = 0;
  let unmatched = 0;
  const WINDOW = 400;

  let e = 0;
  while (e < editorParas.length) {
    const p = editorParas[e];
    if (p.originalText === '' && p.finalText === '') {
      alignment[e] = { sourceIndex: null, isNew: false, empty: true };
      e += 1;
      continue;
    }
    if (p.originalText === '' && p.finalText !== '') {
      alignment[e] = { sourceIndex: null, isNew: true, anchorAfter: cursor - 1 };
      e += 1;
      continue;
    }

    const candidates = sourceMap.get(p.originalText) || [];
    let pick = candidates.find((idx) => idx >= cursor && !used.has(idx));
    if (pick === undefined) pick = candidates.find((idx) => !used.has(idx));
    if (pick !== undefined) {
      used.add(pick);
      cursor = pick + 1;
      alignment[e] = { sourceIndex: pick, isNew: false };
      e += 1;
      continue;
    }

    let merged = null;
    for (let j = Math.max(0, cursor - 2); j < Math.min(sourceParas.length, cursor + WINDOW); j++) {
      if (used.has(j)) continue;
      if (!p.originalText.startsWith(sourceParas[j].originalText)) continue;
      let concat = sourceParas[j].originalText;
      let k = j;
      while (concat.length < p.originalText.length && k + 1 < sourceParas.length) {
        k += 1;
        concat += sourceParas[k].originalText;
        if (!p.originalText.startsWith(concat)) break;
      }
      if (concat === p.originalText && k > j) {
        merged = { from: j, to: k };
        break;
      }
    }
    if (merged) {
      for (let j = merged.from; j <= merged.to; j++) used.add(j);
      cursor = merged.to + 1;
      alignment[e] = { sourceIndex: merged.from, isNew: false, mergedThrough: merged.to };
      e += 1;
      continue;
    }

    let split = null;
    for (let j = Math.max(0, cursor - 2); j < Math.min(sourceParas.length, cursor + WINDOW); j++) {
      if (used.has(j)) continue;
      const target = sourceParas[j].originalText;
      if (target === '' || !target.startsWith(p.originalText)) continue;
      let concat = p.originalText;
      let k = e;
      while (concat.length < target.length && k + 1 < editorParas.length) {
        k += 1;
        concat += editorParas[k].originalText;
        if (!target.startsWith(concat)) break;
      }
      if (concat === target && k > e) {
        split = { sourceIndex: j, lastEditor: k };
        break;
      }
    }
    if (split) {
      used.add(split.sourceIndex);
      cursor = split.sourceIndex + 1;
      let splitOffset = 0;
      for (let k = e; k <= split.lastEditor; k++) {
        alignment[k] = {
          sourceIndex: split.sourceIndex,
          isNew: false,
          splitPart: k - e,
          sourceOffset: splitOffset,
        };
        splitOffset += editorParas[k].originalText.length;
      }
      e = split.lastEditor + 1;
      continue;
    }

    alignment[e] = {
      sourceIndex: null,
      isNew: false,
      unmatchedText: p.originalText,
      anchorAfter: cursor - 1,
    };
    unmatched += 1;
    e += 1;
  }
  return { alignment, unmatched };
}

// ---------------------------------------------------------------------------
// Full analysis
// ---------------------------------------------------------------------------

export function analyze(docDir, { log = () => {} } = {}) {
  const SOURCE_FILE = path.join(docDir, 'zh-TW-source.docx');
  const EDITOR_FILES = [1, 2, 3].map((n) => path.join(docDir, `zh-TW-editor${n}.docx`));
  for (const f of [SOURCE_FILE, ...EDITOR_FILES]) {
    if (!fs.existsSync(f)) throw new Error(`Missing file: ${f}`);
  }

  log('Loading source document…');
  const source = loadDocument(SOURCE_FILE);
  log(`  source: ${source.paragraphs.length} paragraphs`);

  const editors = EDITOR_FILES.map((f, i) => {
    log(`Loading editor${i + 1}…`);
    const doc = loadDocument(f);
    const inserted = new Set();
    for (const p of doc.paragraphs) {
      for (const ch of p.changes) {
        if (ch.kind === 'ins' || ch.kind === 'moveTo') {
          const norm = normalize(ch.text);
          if (norm) inserted.add(norm);
        }
      }
    }
    const { alignment, unmatched } = alignToSource(source.paragraphs, doc.paragraphs);
    log(`  editor${i + 1}: ${doc.paragraphs.length} paragraphs, ${unmatched} unmatched, ${doc.comments.size} comments`);
    return { name: `editor${i + 1}`, file: path.basename(f), doc, inserted, alignment, unmatched };
  });

  for (const ed of editors) {
    const authors = new Set();
    for (const p of ed.doc.paragraphs)
      for (const ch of p.changes) if (ch.author) authors.add(ch.author);
    ed.reviewer = [...authors].join(', ') || '(unknown)';
  }

  const bySource = new Map();
  function bucket(key) {
    if (!bySource.has(key)) bySource.set(key, { perEditor: new Map(), comments: [] });
    return bySource.get(key);
  }

  const editorStats = [];
  for (const ed of editors) {
    const stats = {
      editor: ed.name,
      reviewer: ed.reviewer,
      insertions: 0,
      replacements: 0,
      deletions_total: 0,
      orphan_deletions: 0,
      likely_moves: 0,
      explicit_moves: 0,
      new_paragraphs: 0,
      merged_paragraph_marks: 0,
      punct_only_hidden: 0,
      comments: ed.doc.comments.size,
      unmatched_paragraphs: ed.unmatched,
      touched_source_paragraphs: 0,
      orphan_list: [],
      min_paragraph: undefined,
      max_paragraph: undefined,
    };
    ed.doc.paragraphs.forEach((p, pIdx) => {
      const align = ed.alignment[pIdx];
      if (!align || align.empty) return;
      if (p.paraMarkDeleted) stats.merged_paragraph_marks += 1;
      const logical = classifyChanges(p, ed.inserted);
      if (align.isNew) stats.new_paragraphs += 1;

      const baseKey = align.isNew
        ? `new:${ed.name}:${pIdx}`
        : align.sourceIndex !== null
          ? align.sourceIndex
          : `unmatched:${ed.name}:${pIdx}`;
      const keyFor = (ch) => {
        if (typeof baseKey !== 'number') return baseKey;
        if (align.mergedThrough !== undefined) {
          let off = 0;
          for (let j = align.sourceIndex; j <= align.mergedThrough; j++) {
            const len = source.paragraphs[j].originalText.length;
            if (ch.origStart < off + len || j === align.mergedThrough) {
              ch.origStart -= off;
              ch.origEnd = Math.max(ch.origStart, ch.origEnd - off);
              return j;
            }
            off += len;
          }
        }
        if (align.sourceOffset) {
          ch.origStart += align.sourceOffset;
          ch.origEnd += align.sourceOffset;
        }
        return baseKey;
      };

      for (const ch of logical) {
        const key = keyFor(ch);
        ch.sourceKey = key;
        ch.editor = ed.name;
        const b = bucket(key);
        if (typeof key !== 'number') {
          if (align.anchorAfter !== undefined) b.anchorAfter = align.anchorAfter;
          b.editorOriginalText = p.originalText;
          b.editorFinalText = p.finalText;
        }
        const entry = b.perEditor.get(ed.name) || { logical: [] };
        entry.logical.push(ch);
        b.perEditor.set(ed.name, entry);
      }
      if (p.commentIds.length > 0) {
        const b = bucket(baseKey);
        if (typeof baseKey !== 'number' && align.anchorAfter !== undefined) {
          b.anchorAfter = align.anchorAfter;
        }
        for (const id of p.commentIds) {
          const c = ed.doc.comments.get(id);
          if (c) b.comments.push({ editor: ed.name, text: c.text });
        }
      }

      for (const ch of logical) {
        if (typeof ch.sourceKey === 'number') {
          stats.min_paragraph = Math.min(stats.min_paragraph ?? Infinity, ch.sourceKey);
          stats.max_paragraph = Math.max(stats.max_paragraph ?? -1, ch.sourceKey);
        }
        if (REVIEWABLE.has(ch.type) && ch.punctOnly) stats.punct_only_hidden += 1;
        if (ch.type === 'insertion') stats.insertions += 1;
        else if (ch.type === 'replacement') stats.replacements += 1;
        else if (ch.type === 'move-in' || ch.type === 'move-out') stats.explicit_moves += 1;
        else if (ch.type === 'likely-move') {
          stats.likely_moves += 1;
          stats.deletions_total += 1;
        } else if (ch.type === 'deletion') {
          stats.deletions_total += 1;
          stats.orphan_deletions += 1;
          stats.orphan_list.push({
            sourceParagraph: typeof ch.sourceKey === 'number' ? ch.sourceKey : String(ch.sourceKey),
            text: ch.delText,
          });
        }
        if (ch.type === 'replacement') stats.deletions_total += 1;
      }
      if (logical.length > 0) stats.touched_source_paragraphs += 1;
    });
    editorStats.push(stats);
  }

  // ---- Conflict detection --------------------------------------------------
  const hardConflicts = [];
  const softConflicts = [];
  const coEdited = [];
  const agreedDuplicates = [];

  for (const [key, b] of bySource) {
    if (typeof key !== 'number') continue;
    const editorsHere = [...b.perEditor.entries()];
    if (editorsHere.length < 2) continue;

    const ranges = [];
    for (const [edName, { logical }] of editorsHere) {
      for (const ch of logical) {
        ranges.push({
          editor: edName,
          type: ch.type,
          start: ch.origStart,
          end: ch.origEnd,
          delText: ch.delText ?? '',
          insText: ch.insText ?? '',
          text: ch.insText ?? ch.delText ?? '',
          ref: ch,
        });
      }
    }
    let isHard = false;
    let isSoft = false;
    const pairs = [];
    for (let a = 0; a < ranges.length; a++) {
      for (let c = a + 1; c < ranges.length; c++) {
        const A = ranges[a];
        const B = ranges[c];
        if (A.editor === B.editor) continue;
        const aWidth = A.end > A.start;
        const bWidth = B.end > B.start;
        const overlap = A.start <= B.end && B.start <= A.end;
        if (!overlap) continue;
        const identical =
          A.type === B.type &&
          A.start === B.start &&
          A.end === B.end &&
          A.delText === B.delText &&
          A.insText === B.insText;
        if (identical) {
          A.ref.agreedWith = B.editor;
          B.ref.duplicateOf = A.editor;
          pairs.push({ severity: 'agreed', a: A, b: B });
        } else if (aWidth || bWidth) {
          isHard = true;
          pairs.push({ severity: 'hard', a: A, b: B });
        } else if (A.start === B.start) {
          isSoft = true;
          pairs.push({ severity: 'soft', a: A, b: B });
        }
      }
    }
    const agreedPairs = pairs.filter((p) => p.severity === 'agreed');
    for (const p of agreedPairs) {
      agreedDuplicates.push({
        sourceParagraph: key,
        editors: [p.a.editor, p.b.editor],
        type: p.a.type,
        delText: snippet(p.a.delText),
        insText: snippet(p.a.insText),
      });
    }
    const record = {
      sourceParagraph: key,
      sourceText: snippet(source.paragraphs[key].originalText, 100),
      editors: editorsHere.map(([n]) => n),
      variants: Object.fromEntries(
        editorsHere.map(([n, { logical }]) => [
          n,
          logical.map((ch) => ({
            type: ch.type,
            delText: ch.delText ? snippet(ch.delText, 120) : undefined,
            insText: ch.insText ? snippet(ch.insText, 120) : undefined,
            origStart: ch.origStart,
          })),
        ])
      ),
      pairs: pairs
        .filter((p) => p.severity !== 'agreed')
        .map((p) => ({
          severity: p.severity,
          [p.a.editor]: `${p.a.type}: "${snippet(p.a.text)}" @${p.a.start}`,
          [p.b.editor]: `${p.b.type}: "${snippet(p.b.text)}" @${p.b.start}`,
        })),
    };
    if (isHard) hardConflicts.push(record);
    else if (isSoft) softConflicts.push(record);
    else if (agreedPairs.length === 0)
      coEdited.push({ sourceParagraph: key, editors: editorsHere.map(([n]) => n) });
  }

  // ---- Affected paragraphs & invisible comments ----------------------------
  let affected = 0;
  let invisibleCommentParas = 0;
  let invisibleComments = 0;
  for (const [, b] of bySource) {
    const hasReviewable = [...b.perEditor.values()].some(({ logical }) =>
      logical.some(isReviewable)
    );
    if (hasReviewable) affected += 1;
    else if (b.comments.length > 0) {
      invisibleCommentParas += 1;
      invisibleComments += b.comments.length;
    }
  }

  return {
    source,
    editors,
    bySource,
    editorStats,
    hardConflicts,
    softConflicts,
    coEdited,
    agreedDuplicates,
    affected,
    invisibleComments,
    invisibleCommentParas,
    sourceFile: SOURCE_FILE,
  };
}
