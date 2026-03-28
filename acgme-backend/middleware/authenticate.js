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
  if (!process.env.JWT_SECRET) {
    return res.status(500).json({ error: 'JWT_SECRET not configured on server' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // Token already has a numeric userId (future flow)
    if (decoded.userId) {
      req.userId = decoded.userId;
      return next();
    }

    // Token has email (current Vercel flow) — look up or create user
    if (decoded.email) {
      try {
        const { rows } = await db.query(
          `INSERT INTO users (email)
           VALUES ($1)
           ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email
           RETURNING id`,
          [decoded.email]
        );
        req.userId = rows[0].id;
        return next();
      } catch (dbErr) {
        console.error('DB error in authenticate:', dbErr.message);
        return res.status(500).json({ error: `DB error: ${dbErr.message}` });
      }
    }

    return res.status(401).json({ error: 'Invalid token payload' });
  } catch (err) {
    // Distinguish JWT errors from everything else
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token expired — please sign out and back in.' });
    }
    if (err.name === 'JsonWebTokenError') {
      return res.status(401).json({ error: 'Token signature invalid — JWT_SECRET mismatch between Vercel and Railway. Check both env vars.' });
    }
    return res.status(401).json({ error: `Auth error: ${err.message}` });
  }
}

module.exports = { authenticate };
