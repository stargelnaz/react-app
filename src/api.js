// Token handling + API client. The magic-link token arrives as ?t=..., is
// stored in localStorage, and is stripped from the URL so screenshots and
// browser history don't leak it.

const TOKEN_KEY = 'portal_token';

export function bootstrapToken() {
  const url = new URL(window.location.href);
  const t = url.searchParams.get('t');
  if (t) {
    localStorage.setItem(TOKEN_KEY, t);
    url.searchParams.delete('t');
    window.history.replaceState({}, '', url.pathname + url.search + url.hash);
  }
  return localStorage.getItem(TOKEN_KEY);
}

export function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}

async function request(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'x-portal-token': getToken() ?? '',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

export const api = {
  paragraphs: () => request('/api/paragraphs'),
  vote: (paragraphId, vote, notes) =>
    request('/api/vote', { method: 'POST', body: { paragraphId, vote, notes } }),
  signoff: () => request('/api/signoff', { method: 'POST' }),
  adminResults: () => request('/api/admin/results'),
  adminUnlock: (name) => request('/api/admin/unlock', { method: 'POST', body: { name } }),
  exportUrl: (format) =>
    `/api/admin/export?format=${format}&t=${encodeURIComponent(getToken() ?? '')}`,
};
