import { useEffect, useState } from 'react';
import { bootstrapToken, api } from './api.js';
import VotingView from './components/VotingView.jsx';
import AdminDashboard from './components/AdminDashboard.jsx';

export default function App() {
  const [state, setState] = useState({ status: 'loading' });

  useEffect(() => {
    const token = bootstrapToken();
    if (!token) {
      setState({ status: 'no-token' });
      return;
    }
    api
      .paragraphs()
      .then((data) => setState({ status: 'ready', data }))
      .catch((e) =>
        setState({ status: e.status === 401 ? 'bad-token' : 'error', message: e.message })
      );
  }, []);

  if (state.status === 'loading') {
    return <div className="center-screen">Loading 載入中…</div>;
  }
  if (state.status === 'no-token' || state.status === 'bad-token') {
    return (
      <div className="center-screen">
        <div className="notice-card">
          <h1>Document Review Portal 文件審閱系統</h1>
          <p>
            {state.status === 'no-token'
              ? 'This page requires your personal access link. Please open the link you were sent.'
              : 'This access link is not valid. Please use the exact link you were sent, or contact the administrator.'}
          </p>
          <p lang="zh-TW">
            {state.status === 'no-token'
              ? '本頁面需要您的個人專屬連結，請使用您收到的連結開啟。'
              : '此連結無效。請使用您收到的原始連結，或聯絡管理員。'}
          </p>
        </div>
      </div>
    );
  }
  if (state.status === 'error') {
    return (
      <div className="center-screen">
        <div className="notice-card">
          <h1>Something went wrong</h1>
          <p>{state.message}</p>
          <button onClick={() => window.location.reload()}>Retry 重試</button>
        </div>
      </div>
    );
  }

  const { user, paragraphs } = state.data;
  return user.role === 'admin' ? (
    <AdminDashboard user={user} paragraphs={paragraphs} />
  ) : (
    <VotingView user={user} paragraphs={paragraphs} />
  );
}
