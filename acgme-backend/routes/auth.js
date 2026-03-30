const express  = require('express');
const router   = express.Router();
const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');
const { encrypt, decrypt } = require('../services/encryptionService');
const { clearSession }     = require('../services/sessionCache');
const { authenticate }     = require('../middleware/authenticate');
const pw = require('../services/playwrightService');
const { getInsertPageData } = require('../services/acgmeService');
const db = require('../db');

async function assertInsertReachableFromCookies(cookies) {
  const header = pw.cookiesArrayToHeader(cookies);
  await getInsertPageData(header);
}

/** Records that an MFA browser session was started (survives only in-memory Map on one server process). */
async function registerMfaSession(sessionId, userId) {
  await db.query('DELETE FROM acgme_mfa_pending WHERE expires_at < NOW()').catch(() => {});
  await db.query(
    `INSERT INTO acgme_mfa_pending (session_id, user_id, expires_at)
     VALUES ($1, $2, NOW() + INTERVAL '15 minutes')
     ON CONFLICT (session_id) DO UPDATE SET expires_at = EXCLUDED.expires_at, user_id = EXCLUDED.user_id`,
    [sessionId, userId]
  );
}

async function clearMfaSession(sessionId) {
  await db.query('DELETE FROM acgme_mfa_pending WHERE session_id = $1', [sessionId]).catch(() => {});
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/auth/register
// Body: { name, email, password }
// Returns: { token, user: { id, name, email } }
// ─────────────────────────────────────────────────────────────────────────────
router.post('/register', async (req, res, next) => {
  try {
    const { name, email, password } = req.body || {};

    if (!name || !email || !password) {
      return res.status(400).json({ error: 'Name, email, and password are required.' });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters.' });
    }
    const emailRx = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRx.test(email)) {
      return res.status(400).json({ error: 'Please enter a valid email address.' });
    }

    // Check if email already exists
    const existing = await db.query('SELECT id FROM users WHERE email = $1', [email.toLowerCase()]);
    if (existing.rows.length) {
      return res.status(409).json({ error: 'An account with that email already exists.' });
    }

    const passwordHash = await bcrypt.hash(password, 12);

    const { rows } = await db.query(
      `INSERT INTO users (name, email, password_hash, created_at)
       VALUES ($1, $2, $3, NOW()) RETURNING id, name, email`,
      [name.trim(), email.toLowerCase(), passwordHash]
    );

    const user  = rows[0];
    const secret = process.env.JWT_SECRET;
    if (!secret) return res.status(500).json({ error: 'JWT_SECRET not configured.' });

    const token = jwt.sign({ userId: user.id, email: user.email }, secret, { expiresIn: '30d' });
    return res.status(201).json({ token, user: { id: user.id, name: user.name, email: user.email } });
  } catch (err) {
    next(err);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/auth/login
// Body: { email, password }
// Returns: { token, user: { id, name, email } }
// ─────────────────────────────────────────────────────────────────────────────
router.post('/login', async (req, res, next) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required.' });
    }

    const { rows } = await db.query(
      'SELECT id, name, email, password_hash FROM users WHERE email = $1',
      [email.toLowerCase()]
    );

    if (!rows.length) {
      return res.status(401).json({ error: 'Incorrect email or password.' });
    }

    const user = rows[0];

    // Support legacy single-user accounts that have no password_hash yet
    if (!user.password_hash) {
      return res.status(401).json({ error: 'Account requires a password reset. Please create a new account or contact your administrator.' });
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Incorrect email or password.' });
    }

    const secret = process.env.JWT_SECRET;
    if (!secret) return res.status(500).json({ error: 'JWT_SECRET not configured.' });

    const token = jwt.sign({ userId: user.id, email: user.email }, secret, { expiresIn: '30d' });
    return res.json({ token, user: { id: user.id, name: user.name || email.split('@')[0], email: user.email } });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/auth/save-credentials
 *
 * Save ACGME username + password, then immediately attempt a Playwright login.
 *
 * Response shapes:
 *   { success: true, message }                              — logged in, cookies stored
 *   { success: false, mfaRequired: true, sessionId, message } — MFA needed, use /complete-mfa
 */
router.post('/save-credentials', authenticate, async (req, res, next) => {
  try {
    const { acgmeUsername, acgmePassword } = req.body;
    if (!acgmeUsername || !acgmePassword) {
      return res.status(400).json({ error: 'Username and password required' });
    }

    // Persist credentials first (even before login succeeds, so MFA completion can retrieve them)
    const encryptedPassword = encrypt(acgmePassword);
    await db.query(
      `INSERT INTO user_acgme_credentials (user_id, acgme_username, acgme_password_encrypted, created_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (user_id) DO UPDATE
       SET acgme_username = $2, acgme_password_encrypted = $3, updated_at = NOW()`,
      [req.userId, acgmeUsername, encryptedPassword]
    );

    // Attempt Playwright login
    const result = await pw.startLogin(acgmeUsername, acgmePassword);

    if (result.success) {
      try {
        await assertInsertReachableFromCookies(result.cookies);
      } catch (e) {
        return res.status(401).json({
          error:
            e.message ||
            'Case Entry did not open after login. If your hospital uses Duo, approve the prompt on your phone and try Save again.',
          insertProbeFailed: true,
        });
      }
      await pw.storeSessionCookies(req.userId, result.cookies);
      return res.json({ success: true, message: 'ACGME account connected successfully' });
    }

    if (result.mfaRequired) {
      await registerMfaSession(result.sessionId, req.userId);
      console.log(`[auth] MFA pending sessionId=${result.sessionId} user=${req.userId} pid=${process.pid}`);
      return res.json({
        success: false,
        mfaRequired: true,
        sessionId: result.sessionId,
        message: 'MFA required. Please check your email/phone for a verification code.',
      });
    }

    return res.status(500).json({ error: 'Unexpected login result' });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/auth/complete-mfa
 *
 * Supply the MFA verification code to finish an in-progress Playwright session.
 *
 * Body: { sessionId, code }
 * Response: { success: true, message }
 */
router.post('/complete-mfa', authenticate, async (req, res, next) => {
  try {
    const { sessionId, code, mode } = req.body || {};
    if (!sessionId) {
      return res.status(400).json({ error: 'sessionId required' });
    }
    const duoPush = mode === 'duo_push';
    if (!duoPush && (!code || String(code).trim() === '')) {
      return res.status(400).json({
        error:
          'Enter the verification code, or use “I approved Duo on my phone” if you do not have a numeric code.',
      });
    }

    let result;
    try {
      result = await pw.completeMFA(sessionId, duoPush ? '' : String(code).trim(), {
        mode: duoPush ? 'duo_push' : 'otp',
      });
    } catch (err) {
      if (err.message && err.message.includes('MFA session not found')) {
        const { rows } = await db.query(
          `SELECT 1 FROM acgme_mfa_pending WHERE session_id = $1 AND user_id = $2 AND expires_at > NOW()`,
          [sessionId, req.userId]
        );
        if (rows.length) {
          await clearMfaSession(sessionId);
          return res.status(503).json({
            error:
              'Sign-in started on a different server or the server restarted before you finished. In Railway, set this backend to exactly 1 replica (not multiple instances), save credentials again, then complete MFA within 15 minutes.',
            mfaSessionLost: true,
          });
        }
      }
      throw err;
    }

    if (result.success) {
      try {
        await assertInsertReachableFromCookies(result.cookies);
      } catch (e) {
        return res.status(401).json({
          error:
            e.message ||
            'Case Entry did not open after MFA. If your hospital uses Duo, approve the prompt and try again.',
          insertProbeFailed: true,
        });
      }
      await pw.storeSessionCookies(req.userId, result.cookies);
      await clearMfaSession(sessionId);
      return res.json({ success: true, message: 'MFA verified. ACGME account connected!' });
    }

    return res.status(500).json({ error: 'MFA verification failed' });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/auth/verify-acgme
 *
 * Re-test whether stored session cookies are still valid.
 * If they've expired, attempts a fresh Playwright login (no MFA needed if within 14-day SSO window).
 */
router.post('/verify-acgme', authenticate, async (req, res, next) => {
  try {
    const { rows } = await db.query(
      'SELECT acgme_username, acgme_password_encrypted FROM user_acgme_credentials WHERE user_id = $1',
      [req.userId]
    );
    if (!rows.length) return res.status(404).json({ error: 'No ACGME credentials saved' });

    // Check if stored cookies still work
    const cookieHeader = await pw.getValidCookieHeader(req.userId);
    if (cookieHeader) {
      return res.json({ success: true, message: 'ACGME session is active' });
    }

    // Cookies expired — try a fresh Playwright login (usually works within 14-day MFA window)
    const password = decrypt(rows[0].acgme_password_encrypted);
    const result   = await pw.startLogin(rows[0].acgme_username, password);

    if (result.success) {
      try {
        await assertInsertReachableFromCookies(result.cookies);
      } catch (e) {
        return res.status(401).json({
          error:
            e.message ||
            'Case Entry did not open after re-authentication. If your hospital uses Duo, approve the prompt, then use Reconnect again.',
          insertProbeFailed: true,
        });
      }
      await pw.storeSessionCookies(req.userId, result.cookies);
      return res.json({ success: true, message: 'ACGME re-authenticated successfully' });
    }

    if (result.mfaRequired) {
      await registerMfaSession(result.sessionId, req.userId);
      return res.json({
        success: false,
        mfaRequired: true,
        sessionId: result.sessionId,
        message: 'Your ACGME session has expired and MFA is required to reconnect.',
      });
    }

    return res.status(500).json({ error: 'Re-authentication failed' });
  } catch (err) {
    next(err);
  }
});

/**
 * DELETE /api/auth/disconnect-acgme
 */
router.delete('/disconnect-acgme', authenticate, async (req, res, next) => {
  try {
    await db.query('DELETE FROM acgme_mfa_pending WHERE user_id = $1', [req.userId]).catch(() => {});
    await db.query('DELETE FROM user_acgme_credentials WHERE user_id = $1', [req.userId]);
    clearSession(req.userId);
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/auth/acgme-status
 */
router.get('/acgme-status', authenticate, async (req, res, next) => {
  try {
    const { rows } = await db.query(
      'SELECT acgme_username, created_at, cookies_updated_at FROM user_acgme_credentials WHERE user_id = $1',
      [req.userId]
    );
    if (!rows.length) return res.json({ connected: false });

    const cookieHeader = await pw.getValidCookieHeader(req.userId);
    res.json({
      connected:      true,
      sessionActive:  !!cookieHeader,
      username:       rows[0].acgme_username,
      savedAt:        rows[0].created_at,
      cookiesUpdated: rows[0].cookies_updated_at,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
