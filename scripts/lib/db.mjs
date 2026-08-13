// Minimal Supabase REST helper for local scripts (Node 20 lacks the native
// WebSocket that supabase-js's realtime client wants, so scripts use PostgREST
// directly). Reads credentials from .env.local — run `vercel env pull` first.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function loadEnv() {
  const file = path.join(repoRoot, '.env.local');
  if (!fs.existsSync(file)) throw new Error('.env.local not found — run: vercel env pull .env.local --yes');
  const env = {};
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const i = line.indexOf('=');
    if (i > 0 && !line.startsWith('#')) {
      env[line.slice(0, i)] = line.slice(i + 1).replace(/^"|"$/g, '');
    }
  }
  return env;
}

const env = loadEnv();
const URL_ = env.SUPABASE_URL;
const KEY = env.SUPABASE_SECRET_KEY;
if (!URL_ || !KEY) throw new Error('SUPABASE_URL / SUPABASE_SECRET_KEY missing from .env.local');

async function rest(pathAndQuery, { method = 'GET', body, headers = {} } = {}) {
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
  if (!res.ok) throw new Error(`${method} ${pathAndQuery} -> HTTP ${res.status}: ${text.slice(0, 500)}`);
  return { text, headers: res.headers };
}

export async function select(table, query = 'select=*') {
  const { text } = await rest(`${table}?${query}`);
  return JSON.parse(text);
}

export async function count(table) {
  const { headers } = await rest(`${table}?select=id`, {
    method: 'HEAD',
    headers: { Prefer: 'count=exact' },
  });
  const range = headers.get('content-range') || '/0';
  return parseInt(range.split('/')[1], 10);
}

export async function insert(table, rows, chunkSize = 200) {
  let inserted = 0;
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    await rest(table, {
      method: 'POST',
      body: chunk,
      headers: { Prefer: 'return=minimal' },
    });
    inserted += chunk.length;
  }
  return inserted;
}

export async function remove(table, filterQuery) {
  // filterQuery e.g. 'id=not.is.null' to delete all rows
  await rest(`${table}?${filterQuery}`, { method: 'DELETE' });
}

export async function patch(table, filterQuery, body) {
  await rest(`${table}?${filterQuery}`, {
    method: 'PATCH',
    body,
    headers: { Prefer: 'return=minimal' },
  });
}

export async function upsert(table, rows, onConflict) {
  await rest(`${table}?on_conflict=${onConflict}`, {
    method: 'POST',
    body: rows,
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
  });
}
