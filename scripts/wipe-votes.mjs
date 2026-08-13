// Pre-launch reset: clears all stakeholder votes and sign-off state so
// production starts clean after testing. Run with: node scripts/wipe-votes.mjs
import { remove, patch, count } from './lib/db.mjs';

const before = await count('stakeholder_votes');
console.log(`stakeholder_votes rows before: ${before}`);

await remove('stakeholder_votes', 'id=not.is.null');
await patch('users', 'signed_off_at=not.is.null', { signed_off_at: null });

const after = await count('stakeholder_votes');
console.log(`stakeholder_votes rows after: ${after}`);
console.log('Done.');
