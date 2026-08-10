import { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';

const PAGE = 50;

// Read-only live dashboard: polls aggregates every 3s (pauses when the tab is
// hidden). Voting controls intentionally absent; authorization is enforced
// server-side regardless.
export default function AdminDashboard({ user, paragraphs }) {
  const [results, setResults] = useState(null);
  const [pollError, setPollError] = useState(null);
  const [filter, setFilter] = useState('all'); // all | voted | notes | conflict
  const [limit, setLimit] = useState(PAGE);
  const [unlocking, setUnlocking] = useState(null);

  useEffect(() => {
    let timer;
    let stopped = false;
    async function poll() {
      if (!document.hidden) {
        try {
          const r = await api.adminResults();
          if (!stopped) {
            setResults(r);
            setPollError(null);
          }
        } catch (e) {
          if (!stopped) setPollError(e.message);
        }
      }
      timer = setTimeout(poll, 3000);
    }
    poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, []);

  const byPara = results?.by_paragraph ?? {};
  const stakeholderCount = results?.stakeholder_count ?? 0;

  const stats = useMemo(() => {
    let fullyVoted = 0;
    let anyVote = 0;
    let withNotes = 0;
    for (const p of paragraphs) {
      const agg = byPara[p.id];
      if (!agg) continue;
      if (agg.voted > 0) anyVote += 1;
      if (agg.voted >= stakeholderCount && stakeholderCount > 0) fullyVoted += 1;
      if (agg.notes.length > 0) withNotes += 1;
    }
    return { fullyVoted, anyVote, withNotes };
  }, [paragraphs, byPara, stakeholderCount]);

  const visible = useMemo(() => {
    return paragraphs.filter((p) => {
      const agg = byPara[p.id];
      if (filter === 'voted') return agg && agg.voted > 0;
      if (filter === 'notes') return agg && agg.notes.length > 0;
      if (filter === 'conflict') return p.item_type === 'conflict';
      return true;
    });
  }, [paragraphs, byPara, filter]);

  async function unlock(name) {
    setUnlocking(name);
    try {
      await api.adminUnlock(name);
      const r = await api.adminResults();
      setResults(r);
    } catch (e) {
      alert(`Unlock failed: ${e.message}`);
    } finally {
      setUnlocking(null);
    }
  }

  return (
    <div className="page">
      <div className="topbar">
        <div className="topbar-row">
          <div className="topbar-title">
            Admin Dashboard 管理面板 — <strong>{user.name}</strong>
          </div>
          <span className={`poll-dot ${pollError ? 'poll-err' : ''}`} title={pollError ?? 'live'} />
          <a className="btn" href={api.exportUrl('csv')}>Export CSV</a>
          <a className="btn" href={api.exportUrl('json')}>Export JSON</a>
        </div>
        <div className="topbar-row admin-stats">
          <span>{paragraphs.length} paragraphs</span>
          <span>{stats.anyVote} with votes</span>
          <span>{stats.fullyVoted} fully voted (all {stakeholderCount})</span>
          <span>{stats.withNotes} with notes</span>
        </div>
        <div className="topbar-row filters">
          {[
            ['all', 'All 全部'],
            ['voted', 'With votes 有投票'],
            ['notes', 'With notes 有備註'],
            ['conflict', 'Conflict 衝突項'],
          ].map(([f, label]) => (
            <button
              key={f}
              className={`chip ${filter === f ? 'chip-active' : ''}`}
              onClick={() => {
                setFilter(f);
                setLimit(PAGE);
              }}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="topbar-row roster">
          {(results?.stakeholders ?? []).map((s) => (
            <span key={s.name} className={`roster-chip ${s.signed_off_at ? 'roster-done' : ''}`}>
              {s.name} {s.signed_off_at ? '✓ submitted' : '… voting'}
              {s.signed_off_at && (
                <button
                  className="link-btn"
                  disabled={unlocking === s.name}
                  onClick={() => unlock(s.name)}
                >
                  {unlocking === s.name ? 'unlocking…' : 'unlock'}
                </button>
              )}
            </span>
          ))}
        </div>
      </div>

      <main className="cards">
        {visible.slice(0, limit).map((p) => {
          const agg = byPara[p.id];
          const counts = agg?.counts ?? { YES: 0, NO: 0, A: 0, B: 0, REJECT_BOTH: 0 };
          const isConflict = p.item_type === 'conflict';
          return (
            <article key={p.id} className="card card-admin">
              <header className="card-head">
                <span className="card-para">¶ {p.source_index ?? 'new'}</span>
                <span className="card-section">{p.section}</span>
                {isConflict && <span className="badge-conflict">Conflict</span>}
                <span className="admin-counts">
                  {isConflict ? (
                    <>A: {counts.A} · B: {counts.B} · Reject: {counts.REJECT_BOTH}</>
                  ) : (
                    <>Yes: {counts.YES} · No: {counts.NO}</>
                  )}
                  {' · '}Pending: {Math.max(0, stakeholderCount - (agg?.voted ?? 0))}
                </span>
              </header>
              <div
                className="paragraph-text"
                dangerouslySetInnerHTML={{ __html: p.rendered_html }}
              />
              {isConflict &&
                p.variants.map((v) => (
                  <div key={v.option} className="variant">
                    <div className="variant-label">
                      Option {v.option} ({v.reviewer})
                    </div>
                    <div className="paragraph-text" dangerouslySetInnerHTML={{ __html: v.html }} />
                  </div>
                ))}
              {agg?.notes.length > 0 && (
                <div className="comments">
                  <div className="comments-title">Stakeholder notes</div>
                  <ul>
                    {agg.notes.map((n, i) => (
                      <li key={i}>
                        <strong>{n.name}:</strong> {n.text}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </article>
          );
        })}
        {visible.length > limit && (
          <button className="btn btn-more" onClick={() => setLimit((n) => n + PAGE)}>
            Show more ({visible.length - limit} remaining)
          </button>
        )}
      </main>
    </div>
  );
}
