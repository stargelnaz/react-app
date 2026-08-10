import { useMemo, useState } from 'react';
import { api } from '../api.js';

// Final review before sign-off: summary of every vote, list of anything still
// pending, and the submit action that locks the ballot.
export default function ReviewPage({ user, paragraphs, votes, signedOffAt, onSignedOff, onBack }) {
  const [confirming, setConfirming] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  const { voted, pending } = useMemo(() => {
    const voted = [];
    const pending = [];
    paragraphs.forEach((p, i) => {
      const v = votes[p.id];
      if (v?.vote) voted.push({ p, v, i });
      else pending.push({ p, i });
    });
    return { voted, pending };
  }, [paragraphs, votes]);

  async function submit() {
    setSubmitting(true);
    setError(null);
    try {
      const r = await api.signoff();
      onSignedOff(r.signed_off_at);
    } catch (e) {
      setError(e.message);
    } finally {
      setSubmitting(false);
    }
  }

  const voteLabel = { YES: 'Yes 同意', NO: 'No 不同意', A: 'Option A 版本A', B: 'Option B 版本B', REJECT_BOTH: 'Reject both 皆不採用' };

  return (
    <div className="page">
      <div className="topbar">
        <div className="topbar-row">
          <button className="btn" onClick={onBack}>← Back 返回</button>
          <div className="topbar-title">Review your votes 檢查投票 — {user.name}</div>
        </div>
      </div>
      <main className="review">
        <section className="review-summary">
          <div className="stat">
            <div className="stat-num">{voted.length}</div>
            <div className="stat-label">Voted 已投票</div>
          </div>
          <div className="stat">
            <div className="stat-num">{pending.length}</div>
            <div className="stat-label">Pending 未投票</div>
          </div>
        </section>

        {signedOffAt ? (
          <div className="signed-banner">
            Submitted 已送出 — {new Date(signedOffAt).toLocaleString()}.
            Contact the administrator to unlock. 如需修改請聯絡管理員。
          </div>
        ) : (
          <section className="submit-box">
            {pending.length > 0 && (
              <p className="warn">
                {pending.length} paragraphs have no vote yet. You can still submit — unvoted items
                count as abstained. 尚有 {pending.length} 段未投票，送出後視為棄權。
              </p>
            )}
            {!confirming ? (
              <button className="btn btn-submit" onClick={() => setConfirming(true)}>
                Submit final votes 送出最終投票
              </button>
            ) : (
              <div className="confirm-row">
                <span>Submit and lock your votes? 確定送出並鎖定投票？</span>
                <button className="btn btn-submit" disabled={submitting} onClick={submit}>
                  {submitting ? 'Submitting…' : 'Confirm 確定'}
                </button>
                <button className="btn" disabled={submitting} onClick={() => setConfirming(false)}>
                  Cancel 取消
                </button>
              </div>
            )}
            {error && <p className="warn">Submit failed: {error}</p>}
          </section>
        )}

        {pending.length > 0 && (
          <section>
            <h2>Pending 未投票 ({pending.length})</h2>
            <ul className="review-list">
              {pending.slice(0, 100).map(({ p, i }) => (
                <li key={p.id}>
                  <span className="card-num">#{i + 1}</span> ¶ {p.source_index ?? 'new'} —{' '}
                  {p.section}
                </li>
              ))}
              {pending.length > 100 && <li>…and {pending.length - 100} more 更多</li>}
            </ul>
          </section>
        )}

        <section>
          <h2>Your votes 您的投票 ({voted.length})</h2>
          <ul className="review-list">
            {voted.map(({ p, v, i }) => (
              <li key={p.id}>
                <span className="card-num">#{i + 1}</span> ¶ {p.source_index ?? 'new'} —{' '}
                <strong>{voteLabel[v.vote] ?? v.vote}</strong>
                {v.notes && <span className="review-notes"> 「{v.notes}」</span>}
              </li>
            ))}
          </ul>
        </section>
      </main>
    </div>
  );
}
