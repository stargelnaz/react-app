import { useCallback, useMemo, useState } from 'react';
import ParagraphCard from './ParagraphCard.jsx';
import ReviewPage from './ReviewPage.jsx';

const PAGE = 50;

export default function VotingView({ user, paragraphs }) {
  // votes map drives progress + filters; card-local state drives typing.
  const [votes, setVotes] = useState(() => {
    const m = {};
    for (const p of paragraphs) m[p.id] = { vote: p.myVote, notes: p.myNotes };
    return m;
  });
  const [filter, setFilter] = useState('all'); // all | pending | voted
  const [section, setSection] = useState('all');
  const [limit, setLimit] = useState(PAGE);
  const [showReview, setShowReview] = useState(false);
  const [signedOffAt, setSignedOffAt] = useState(user.signed_off_at);

  const onSaved = useCallback((id, vote, notes) => {
    setVotes((prev) => ({ ...prev, [id]: { vote, notes } }));
  }, []);

  const sections = useMemo(
    () => [...new Set(paragraphs.map((p) => p.section))].filter(Boolean).sort(),
    [paragraphs]
  );

  const votedCount = useMemo(
    () => paragraphs.reduce((n, p) => n + (votes[p.id]?.vote ? 1 : 0), 0),
    [paragraphs, votes]
  );

  const visible = useMemo(() => {
    return paragraphs.filter((p) => {
      if (section !== 'all' && p.section !== section) return false;
      const v = votes[p.id]?.vote;
      if (filter === 'pending') return !v;
      if (filter === 'voted') return !!v;
      return true;
    });
  }, [paragraphs, votes, filter, section]);

  const total = paragraphs.length;
  const pct = total === 0 ? 0 : Math.round((votedCount / total) * 100);
  const locked = !!signedOffAt;

  if (showReview) {
    return (
      <ReviewPage
        user={user}
        paragraphs={paragraphs}
        votes={votes}
        signedOffAt={signedOffAt}
        onSignedOff={setSignedOffAt}
        onBack={() => setShowReview(false)}
      />
    );
  }

  return (
    <div className="page">
      <div className="topbar">
        <div className="topbar-row">
          <div className="topbar-title">
            Document Review 文件審閱 — <strong>{user.name}</strong>
          </div>
          <div className="topbar-progress-label">
            {votedCount} / {total} voted 已投票 ({pct}%)
          </div>
          <button className="btn btn-review" onClick={() => setShowReview(true)}>
            {locked ? 'View submission 檢視送出結果' : 'Review & submit 檢查並送出'}
          </button>
        </div>
        <div className="progress-track">
          <div className="progress-fill" style={{ width: `${pct}%` }} />
        </div>
        <div className="topbar-row filters">
          {['all', 'pending', 'voted'].map((f) => (
            <button
              key={f}
              className={`chip ${filter === f ? 'chip-active' : ''}`}
              onClick={() => {
                setFilter(f);
                setLimit(PAGE);
              }}
            >
              {f === 'all' ? 'All 全部' : f === 'pending' ? 'Pending 未投票' : 'Voted 已投票'}
            </button>
          ))}
          {sections.length > 0 && (
            <>
              <span className="chip-divider" />
              <button
                className={`chip ${section === 'all' ? 'chip-active' : ''}`}
                onClick={() => {
                  setSection('all');
                  setLimit(PAGE);
                }}
              >
                All sections 所有章節
              </button>
              {sections.map((s) => (
                <button
                  key={s}
                  className={`chip ${section === s ? 'chip-active' : ''}`}
                  onClick={() => {
                    setSection(s);
                    setLimit(PAGE);
                  }}
                >
                  {s}
                </button>
              ))}
            </>
          )}
        </div>
        {locked && (
          <div className="locked-banner">
            Submitted 已送出 — voting is locked. Contact the administrator to make changes.
            如需修改請聯絡管理員。
          </div>
        )}
      </div>

      <main className="cards">
        {visible.slice(0, limit).map((p, i) => (
          <ParagraphCard
            key={p.id}
            paragraph={p}
            index={paragraphs.indexOf(p)}
            initialVote={votes[p.id]?.vote ?? null}
            initialNotes={votes[p.id]?.notes ?? ''}
            locked={locked}
            onSaved={onSaved}
          />
        ))}
        {visible.length === 0 && <div className="empty">Nothing here 此篩選條件下沒有項目</div>}
        {visible.length > limit && (
          <button className="btn btn-more" onClick={() => setLimit((n) => n + PAGE)}>
            Show more 顯示更多 ({visible.length - limit} remaining 剩餘)
          </button>
        )}
      </main>
    </div>
  );
}
