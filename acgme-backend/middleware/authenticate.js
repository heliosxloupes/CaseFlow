const jwt = require('jsonwebtoken');
const db = require('../db');

/**
 * Accepts JWTs from both:
 *  - Vercel auth (payload: { email })  ← current CaseFlow tokens
 *  - This backend's own tokens (payload: { userId })  ← future
 *
 * On email tokens: auto-creates a user row if first time, attaches req.userId.
 */
async function authenticate(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid authorization header' });
  }

  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // Token already has a numeric userId (future flow)
    if (decoded.userId) {
      req.userId = decoded.userId;
      return next();
    }

    // Token has email (current Vercel flow) — look up or create user
    if (decoded.email) {
      const { rows } = await db.query(
        `INSERT INTO users (email)
         VALUES ($1)
         ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email
         RETURNING id`,
        [decoded.email]
      );
      req.userId = rows[0].id;
      return next();
    }

    return res.status(401).json({ error: 'Invalid token payload' });
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

module.exports = { authenticate };
