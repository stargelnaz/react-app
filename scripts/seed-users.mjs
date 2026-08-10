// Seeds users from the PRIVATE list at <docDir>/users.json (outside this
// public repo) and writes the magic-link distribution sheet to
// <docDir>/magic-links.txt for the owner to send manually.
//
// - Tokens are generated here (32-char base64url, ~192 bits) and stored only
//   in the database and the distribution sheet — never in users.json.
// - Idempotent: existing users (matched by name) keep their token, so links
//   already distributed stay valid. New names are added.
//
// Usage: node scripts/seed-users.mjs [--dir <folder>] [--base <portal url>]

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { select, insert } from './lib/db.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
function argValue(name, fallback) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}
const docDir = path.resolve(argValue('--dir', path.join(repoRoot, '..')));
const baseUrl = argValue('--base', 'https://react-app.vercel.app').replace(/\/$/, '');

const usersFile = path.join(docDir, 'users.json');
if (!fs.existsSync(usersFile)) {
  console.error(`Missing ${usersFile}`);
  process.exit(1);
}
const wanted = JSON.parse(fs.readFileSync(usersFile, 'utf8'));

for (const u of wanted) {
  if (!u.name || !['stakeholder', 'admin'].includes(u.role)) {
    console.error(`Invalid entry: ${JSON.stringify(u)} — need name + role stakeholder|admin`);
    process.exit(1);
  }
}

const existing = await select('users', 'select=name,role,token,is_test');
const byName = new Map(existing.map((u) => [u.name, u]));

const toInsert = [];
for (const u of wanted) {
  if (byName.has(u.name)) continue;
  toInsert.push({
    name: u.name,
    role: u.role,
    email: u.email ?? null,
    is_test: u.is_test ?? false,
    token: crypto.randomBytes(24).toString('base64url'),
  });
}
if (toInsert.length) {
  await insert('users', toInsert);
  console.log(`Inserted ${toInsert.length} new user(s).`);
} else {
  console.log('No new users to insert.');
}

const all = await select('users', 'select=name,role,token,is_test&order=role.desc,name.asc');
const lines = [
  `Magic links — Document Revision & Stakeholder Voting Portal`,
  `Generated: ${new Date().toISOString()}`,
  `Base URL: ${baseUrl}`,
  ``,
  `PRIVATE — each link is tied to the named person. Send individually; do not forward.`,
  ``,
];
for (const u of all) {
  const flag = u.is_test ? '  [TEST]' : '';
  lines.push(`${u.name} (${u.role})${flag}`);
  lines.push(`  ${baseUrl}/?t=${u.token}`);
  lines.push(``);
}
const outFile = path.join(docDir, 'magic-links.txt');
fs.writeFileSync(outFile, lines.join('\n'), 'utf8');
console.log(`Distribution sheet written to ${outFile} (${all.length} users).`);
console.log('Users in the sheet:', all.map((u) => `${u.name}/${u.role}${u.is_test ? '/test' : ''}`).join(', '));
