import { requireUser } from './_lib/db.js';

export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;
  res.json({
    name: user.name,
    role: user.role,
    is_test: user.is_test,
    signed_off_at: user.signed_off_at,
  });
}
