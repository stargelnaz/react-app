// Local smoke test: invokes API handlers directly with mock req/res against
// the real database. Uses the Scott Test (is_test) stakeholder and an admin.
// Run: node scripts/smoke-api.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
for (const line of fs.readFileSync(path.join(repoRoot, '.env.local'), 'utf8').split(/\r?\n/)) {
  const i = line.indexOf('=');
  if (i > 0 && !line.startsWith('#')) process.env[line.slice(0, i)] ??= line.slice(i + 1).replace(/^"|"$/g, '');
}

const { select } = await import('../react-app/scripts/lib/db.mjs').catch(() => import('./lib/db.mjs'));

function mockRes() {
  const res = {
    statusCode: 200,
    headers: {},
    body: undefined,
    status(c) { res.statusCode = c; return res; },
    setHeader(k, v) { res.headers[k] = v; },
    json(b) { res.body = b; return res; },
    send(b) { res.body = b; return res; },
  };
  return res;
}

async function call(handlerPath, { method = 'GET', query = {}, body } = {}) {
  const { default: handler } = await import(handlerPath);
  const req = { method, query, body, headers: {} };
  const res = mockRes();
  await handler(req, res);
  return res;
}

const testUser = (await select('users', 'select=name,token&is_test=eq.true&limit=1'))[0];
const admin = (await select('users', "select=name,token&role=eq.admin&order=name.asc&limit=1"))[0];
console.log(`Test stakeholder: ${testUser.name}; admin: ${admin.name}`);

let failures = 0;
function check(label, cond, detail = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures += 1;
}

// 1. bad token
let r = await call('../api/me.js', { query: { t: 'nope' } });
check('me: rejects bad token', r.statusCode === 401);

// 2. me
r = await call('../api/me.js', { query: { t: testUser.token } });
check('me: identifies test user', r.statusCode === 200 && r.body.name === testUser.name && r.body.role === 'stakeholder');

// 3. paragraphs
const dbParaCount = (await select('paragraphs', 'select=id')).length;
r = await call('../api/paragraphs.js', { query: { t: testUser.token } });
const paras = r.body?.paragraphs ?? [];
check(`paragraphs: returns all ${dbParaCount}`, paras.length === dbParaCount, `got ${paras.length}`);
const conflict = paras.find((p) => p.item_type === 'conflict');
check('paragraphs: conflict card present with 2 variants', conflict && conflict.variants?.length === 2);
const withComments = paras.filter((p) => p.comments.length > 0).length;
check('paragraphs: comments attached', withComments > 0, `${withComments} paragraphs have comments`);
const terms = paras.filter((p) => p.item_type === 'term');
check('paragraphs: term cards present and sorted first', terms.length > 0 && paras[0].item_type === 'term', `${terms.length} term cards`);
const term = terms[0];
check(
  'paragraphs: term variants anonymized for stakeholder',
  term && term.variants.del && term.variants.examples?.length > 0 && term.variants.reviewers === undefined,
  JSON.stringify({ ...term?.variants, examples: term?.variants?.examples?.length })
);

// 4. vote on standard paragraph
const std = paras.find((p) => p.item_type === 'standard');
r = await call('../api/vote.js', { method: 'POST', body: { t: testUser.token, paragraphId: std.id, vote: 'YES', notes: '測試 note ①' } });
check('vote: YES accepted on standard', r.statusCode === 200 && r.body.ok);

// 5. invalid vote value for standard
r = await call('../api/vote.js', { method: 'POST', body: { t: testUser.token, paragraphId: std.id, vote: 'A' } });
check('vote: A rejected on standard', r.statusCode === 400);

// 6. conflict vote
r = await call('../api/vote.js', { method: 'POST', body: { t: testUser.token, paragraphId: conflict.id, vote: 'A', notes: '' } });
check('vote: A accepted on conflict', r.statusCode === 200);

// 6b. term card votes YES/NO, rejects A
r = await call('../api/vote.js', { method: 'POST', body: { t: testUser.token, paragraphId: term.id, vote: 'YES', notes: '' } });
check('vote: YES accepted on term card', r.statusCode === 200);
r = await call('../api/vote.js', { method: 'POST', body: { t: testUser.token, paragraphId: term.id, vote: 'A' } });
check('vote: A rejected on term card', r.statusCode === 400);

// 7. upsert (change vote, ensure single row)
r = await call('../api/vote.js', { method: 'POST', body: { t: testUser.token, paragraphId: std.id, vote: 'NO', notes: 'changed my mind 改了' } });
const voteRows = await select('stakeholder_votes', `select=vote&paragraph_id=eq.${std.id}`);
check('vote: upsert keeps one row per user', r.statusCode === 200 && voteRows.length === 1 && voteRows[0].vote === 'NO', JSON.stringify(voteRows));

// 8. admin results exclude test user
r = await call('../api/admin/results.js', { query: { t: admin.token } });
const agg = r.body?.by_paragraph?.[std.id];
check('admin results: test user votes excluded', r.statusCode === 200 && agg === undefined, agg ? JSON.stringify(agg) : 'no aggregate for test-voted paragraph');
const realStakeholders = (await select('users', 'select=id&role=eq.stakeholder&is_test=eq.false')).length;
check('admin results: roster excludes test user', r.body.stakeholder_count === realStakeholders, `count ${r.body?.stakeholder_count}, expected ${realStakeholders}`);

// 9. admin endpoints reject stakeholder token
r = await call('../api/admin/results.js', { query: { t: testUser.token } });
check('admin results: stakeholder rejected', r.statusCode === 403);

// 10. export csv
r = await call('../api/admin/export.js', { query: { t: admin.token, format: 'csv' } });
check('export: csv produced', r.statusCode === 200 && typeof r.body === 'string' && r.body.split('\n').length === dbParaCount + 1, `lines ${typeof r.body === 'string' ? r.body.split('\n').length : 'n/a'}`);
check('export: term rows labeled', typeof r.body === 'string' && r.body.includes('TERM: '), '');

// 11. signoff locks voting
r = await call('../api/signoff.js', { method: 'POST', body: { t: testUser.token } });
check('signoff: succeeds', r.statusCode === 200 && r.body.ok);
r = await call('../api/vote.js', { method: 'POST', body: { t: testUser.token, paragraphId: std.id, vote: 'YES' } });
check('vote: blocked after signoff', r.statusCode === 403);

// 12. admin unlock restores voting
r = await call('../api/admin/unlock.js', { method: 'POST', body: { t: admin.token, name: testUser.name } });
check('unlock: succeeds', r.statusCode === 200);
r = await call('../api/vote.js', { method: 'POST', body: { t: testUser.token, paragraphId: std.id, vote: 'YES' } });
check('vote: works after unlock', r.statusCode === 200);

// cleanup test votes
const testUserRow = (await select('users', `select=id&token=eq.${testUser.token}`))[0];
await (await import('./lib/db.mjs')).remove('stakeholder_votes', `user_id=eq.${testUserRow.id}`);
console.log('\nTest votes cleaned up.');
console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
