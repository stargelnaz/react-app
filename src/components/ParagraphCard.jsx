import { memo, useRef, useState, useEffect } from 'react';
import { api } from '../api.js';

// One review item. Manages its own vote/notes state and auto-save so typing
// never re-renders the 800-card list; reports saved values up for progress.
function ParagraphCard({ paragraph, initialVote, initialNotes, locked, onSaved, index }) {
  const [vote, setVote] = useState(initialVote);
  const [notes, setNotes] = useState(initialNotes);
  const [status, setStatus] = useState('idle'); // idle | saving | saved | error
  const debounceRef = useRef(null);
  const latestRef = useRef({ vote: initialVote, notes: initialNotes });
  latestRef.current = { vote, notes };

  useEffect(() => () => clearTimeout(debounceRef.current), []);

  async function save(v, n) {
    setStatus('saving');
    try {
      await api.vote(paragraph.id, v, n);
      setStatus('saved');
      onSaved(paragraph.id, v, n);
    } catch (e) {
      setStatus(e.status === 403 ? 'locked' : 'error');
    }
  }

  function handleVote(newVote) {
    if (locked) return;
    const v = vote === newVote ? null : newVote; // click again to clear
    setVote(v);
    clearTimeout(debounceRef.current);
    save(v, latestRef.current.notes);
  }

  function handleNotesChange(e) {
    setNotes(e.target.value);
    if (locked) return;
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      save(latestRef.current.vote, latestRef.current.notes);
    }, 800);
  }

  function handleNotesBlur() {
    if (locked) return;
    clearTimeout(debounceRef.current);
    save(latestRef.current.vote, latestRef.current.notes);
  }

  const isConflict = paragraph.item_type === 'conflict';

  return (
    <article className={`card ${vote ? 'card-voted' : ''}`} id={`p-${paragraph.id}`}>
      <header className="card-head">
        <span className="card-num">#{index + 1}</span>
        <span className="card-para">¶ {paragraph.source_index ?? 'new'}</span>
        {paragraph.section && <span className="card-section">{paragraph.section}</span>}
        {isConflict && <span className="badge-conflict">Conflict 衝突項</span>}
        <span className={`save-status save-${status}`}>
          {status === 'saving' && 'Saving…'}
          {status === 'saved' && 'Saved ✓'}
          {status === 'error' && (
            <button className="link-btn" onClick={() => save(vote, notes)}>
              Save failed — retry 重試
            </button>
          )}
        </span>
      </header>

      {isConflict ? (
        <>
          <p className="conflict-intro">
            Two reviewers changed the same text differently. Choose one option, or reject both.
            <span lang="zh-TW">兩位審閱者對同一段文字提出不同修改。請選擇其中一個版本，或兩者皆不採用。</span>
          </p>
          <div className="variant-label">Original 原文:</div>
          <div
            className="paragraph-text paragraph-original"
            dangerouslySetInnerHTML={{ __html: paragraph.rendered_html }}
          />
          {paragraph.variants.map((v) => (
            <div
              key={v.option}
              className={`variant ${vote === v.option ? 'variant-chosen' : ''}`}
              onClick={() => handleVote(v.option)}
            >
              <div className="variant-label">Option {v.option} 版本 {v.option}:</div>
              <div className="paragraph-text" dangerouslySetInnerHTML={{ __html: v.html }} />
            </div>
          ))}
        </>
      ) : (
        <div
          className="paragraph-text"
          dangerouslySetInnerHTML={{ __html: paragraph.rendered_html }}
        />
      )}

      {paragraph.comments.length > 0 && (
        <div className="comments">
          <div className="comments-title">Reviewer comments 審閱者註解</div>
          <ul>
            {paragraph.comments.map((c, i) => (
              <li key={i}>{c}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="controls">
        {isConflict ? (
          <button
            className={`btn btn-reject ${vote === 'REJECT_BOTH' ? 'btn-active' : ''}`}
            disabled={locked}
            onClick={() => handleVote('REJECT_BOTH')}
          >
            Reject both 兩者皆不採用
          </button>
        ) : (
          <>
            <button
              className={`btn btn-yes ${vote === 'YES' ? 'btn-active' : ''}`}
              disabled={locked}
              onClick={() => handleVote('YES')}
            >
              Yes 同意
            </button>
            <button
              className={`btn btn-no ${vote === 'NO' ? 'btn-active' : ''}`}
              disabled={locked}
              onClick={() => handleVote('NO')}
            >
              No 不同意
            </button>
          </>
        )}
      </div>

      <textarea
        className="notes"
        placeholder="Optional notes — refer to changes as (1), (2)… 選填備註，可用 (1)、(2) 指涉特定修改"
        value={notes}
        disabled={locked}
        rows={2}
        onChange={handleNotesChange}
        onBlur={handleNotesBlur}
      />
    </article>
  );
}

export default memo(ParagraphCard);
