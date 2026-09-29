// Shared Supabase REST access for API functions. Uses the service-role secret
// (server-only env) — RLS is deny-all, so nothing here is reachable without a
// verified magic-link token.

const URL_ = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SECRET_KEY;

export async function rest(pathAndQuery, { method = 'GET', body, headers = {} } = {}) {
  const res = await fetch(`${URL_}/rest/v1/${pathAndQuery}`, {
    method,
    headers: {
      apikey: KEY,
      Authorization: `Bearer ${KEY}`,
      'Content-Type': 'application/json',
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`${method} ${pathAndQuery} -> HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  return text ? JSON.parse(text) : null;
}

export const select = (table, query) => rest(`${table}?${query}`);

export function tokenFrom(req) {
  return (
    req.query?.t ||
    req.headers['x-portal-token'] ||
    (req.body && typeof req.body === 'object' ? req.body.t : undefined) ||
    null
  );
}

export async function getUserByToken(token) {
  if (!token || typeof token !== 'string' || token.length < 8) return null;
  const rows = await select(
    'users',
    `select=id,name,role,is_test,signed_off_at&token=eq.${encodeURIComponent(token)}&limit=1`
  );
  return rows[0] ?? null;
}

// Standard guard: resolves the user or ends the response with 401/403.
export async function requireUser(req, res, role = null) {
  const user = await getUserByToken(tokenFrom(req));
  if (!user) {
    res.status(401).json({ error: 'Invalid or missing token' });
    return null;
  }
  if (role && user.role !== role) {
    res.status(403).json({ error: `Requires ${role} role` });
    return null;
  }
  return user;
}

// Wraps a handler so a Supabase outage (or any unhandled error) returns a
// clean JSON error instead of a bare FUNCTION_INVOCATION_FAILED 500 — the
// frontend shows `error` from JSON, so this is what turns into the user-
// facing message on the Retry screen.
export function withHandler(fn) {
  return async function wrapped(req, res) {
    try {
      await fn(req, res);
    } catch (err) {
      console.error('API handler error:', err);
      if (res.headersSent) return;
      const dbUnavailable = /fetch failed|ECONNREFUSED|ENOTFOUND|HTTP 5\d\d/.test(err.message ?? '');
      res
        .status(dbUnavailable ? 503 : 500)
        .json({
          error: dbUnavailable
            ? 'The database is temporarily unavailable. Please try again in a minute. 資料庫暫時無法使用，請稍後再試。'
            : 'An unexpected server error occurred. 伺服器發生非預期錯誤。',
        });
    }
  };
}
