const db = require('../db');

function getAdminEmails() {
  return String(process.env.ADMIN_EMAILS || '')
    .split(',')
    .map(v => v.trim().toLowerCase())
    .filter(Boolean);
}

async function requireAdmin(req, res, next) {
  try {
    const { rows } = await db.query(
      'SELECT id, email, name, is_admin FROM users WHERE id = $1 LIMIT 1',
      [req.userId]
    );
    if (!rows.length) return res.status(403).json({ error: 'Admin access required' });

    const user = rows[0];
    const email = String(user.email || '').toLowerCase();
    const allowByEmail = getAdminEmails().includes(email);
    if (!user.is_admin && !allowByEmail) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    req.adminUser = user;
    return next();
  } catch (err) {
    return res.status(500).json({ error: 'Could not verify admin access' });
  }
}

module.exports = { requireAdmin, getAdminEmails };
