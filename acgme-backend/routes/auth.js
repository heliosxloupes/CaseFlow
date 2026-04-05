const express  = require('express');
const router   = express.Router();
const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');
const { encrypt, decrypt } = require('../services/encryptionService');
const { clearSession }     = require('../services/sessionCache');
const { authenticate }     = require('../middleware/authenticate');
const pw = require('../services/playwrightService');
const db = require('../db');
const { getAdminEmails } = require('../middleware/requireAdmin');
const { logActivity, logError } = require('../services/logService');
const { getUserProfile } = require('../services/acgmeService');
const { generateTrackedCodes } = require('../services/trackedCodesService');
const { ACGME_ID_TO_SLUG } = require('../config/specialties');

const TOS_VERSION = '2026-03-31';
const APP_VERSION = 'beta-2026.03.31';

/**
 * After ACGME session cookies are stored, scrape specialty + sync CPT codes.
 * Non-blocking — errors are logged but do not fail the connect response.
 */
async function postConnectSync(userId, userEmail) {
  try {
    const cookieHeader = await pw.getValidCookieHeader(userId);
    if (!cookieHeader) return;

    // 1. Scrape specialty from Insert page
    let specialty = null;
    try {
      const profile = await getUserProfile(cookieHeader);
      if (profile.specialtyId) {
        specialty = ACGME_ID_TO_SLUG[String(profile.specialtyId)] || null;
        if (specialty) {
          await db.query('UPDATE users SET specialty = $1 WHERE id = $2', [specialty, userId]);
          console.log(`[postConnectSync] user=${userId} specialty=${specialty}`);
        } else {
          console.warn(`[postConnectSync] Unknown ACGME specialty ID: ${profile.specialtyId} — keeping existing`);
        }
      }
    } catch (err) {
      console.warn(`[postConnectSync] specialty scrape failed:`, err.message);
    }

    // 2. Download & cache tracked CPT codes
    try {
      const codes = await generateTrackedCodes(cookieHeader);
      if (codes.length) {
        await db.query(
          `INSERT INTO user_cpt_codes (user_id, codes, synced_at)
           VALUES ($1, $2, NOW())
           ON CONFLICT (user_id) DO UPDATE SET codes = $2, synced_at = NOW()`,
          [userId, JSON.stringify(codes)]
        );
        console.log(`[postConnectSync] user=${userId} cpt_codes=${codes.length}`);
        await logActivity({
          userId,
          userEmail,
          eventType: 'acgme.cpt_sync',
          message: `Synced ${codes.length} tracked CPT codes`,
          context: { count: codes.length, specialty },
        });
      }
    } catch (err) {
      console.warn(`[postConnectSync] CPT sync failed:`, err.message);
    }
  } catch (err) {
    console.warn(`[postConnectSync] outer error:`, err.message);
  }
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function adminByEmail(email) {
  return getAdminEmails().includes(normalizeEmail(email));
}

function createToken(user) {
  const secret = process.env.JWT_SECRET;
  return jwt.sign(
    { userId: user.id, email: user.email, name: user.name || null },
    secret,
    { expiresIn: '30d' }
  );
}

async function consumeBetaInviteForRegistration(client, inviteKey, email) {
  const key = String(inviteKey || '').trim().toUpperCase();
  if (!key) {
    throw new Error('A beta key is required to create an account.');
  }

  const { rows } = await client.query(
    `SELECT id, invite_key, label, allowed_email, claimed_email, is_active, expires_at
       FROM beta_invites
      WHERE invite_key = $1
      LIMIT 1`,
    [key]
  );
  if (!rows.length) {
    throw new Error('That beta key is not valid.');
  }

  const invite = rows[0];
  if (!invite.is_active) {
    throw new Error('That beta key is no longer active.');
  }
  if (invite.expires_at && new Date(invite.expires_at).getTime() < Date.now()) {
    throw new Error('That beta key has expired.');
  }

  const normalizedEmail = normalizeEmail(email);
  if (invite.allowed_email && normalizeEmail(invite.allowed_email) !== normalizedEmail) {
    throw new Error('That beta key is assigned to a different email address.');
  }
  if (invite.claimed_email && normalizeEmail(invite.claimed_email) !== normalizedEmail) {
    throw new Error('That beta key has already been claimed by another tester.');
  }

  await client.query(
    `UPDATE beta_invites
        SET claimed_email = COALESCE(claimed_email, $1),
            updated_at = NOW()
      WHERE id = $2`,
    [normalizedEmail, invite.id]
  );

  return invite;
}

async function attachInviteUsage(client, inviteId, userId, email) {
  await client.query(
    `UPDATE beta_invites
        SET claimed_email = COALESCE(claimed_email, $1),
            used_by_user_id = $2,
            used_at = NOW(),
            updated_at = NOW()
      WHERE id = $3`,
    [normalizeEmail(email), userId, inviteId]
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/auth/register
// Body: { name, email, password }
// Returns: { token, user: { id, name, email } }
// ─────────────────────────────────────────────────────────────────────────────
router.post('/register', async (req, res, next) => {
  try {
    const { name, email, password, betaKey, tosAccepted } = req.body || {};

    if (!name || !email || !password) {
      return res.status(400).json({ error: 'Name, email, and password are required.' });
    }
    if (!tosAccepted) {
      return res.status(400).json({ error: 'You must accept the Terms of Service to create an account.' });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters.' });
    }
    const emailRx = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRx.test(email)) {
      return res.status(400).json({ error: 'Please enter a valid email address.' });
    }
    const normalizedEmail = normalizeEmail(email);

    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');

      const existing = await client.query('SELECT id FROM users WHERE email = $1', [normalizedEmail]);
      if (existing.rows.length) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'An account with that email already exists.' });
      }

      const invite = await consumeBetaInviteForRegistration(client, betaKey, normalizedEmail);
      const passwordHash = await bcrypt.hash(password, 12);
      const userInsert = await client.query(
        `INSERT INTO users
           (name, email, password_hash, created_at, is_admin, beta_invite_id, beta_key_label, tos_accepted_at, tos_version, last_login_at)
         VALUES ($1, $2, $3, NOW(), $4, $5, $6, NOW(), $7, NOW())
         RETURNING id, name, email, is_admin, beta_key_label, tos_accepted_at, tos_version`,
        [
          name.trim(),
          normalizedEmail,
          passwordHash,
          adminByEmail(normalizedEmail),
          invite.id,
          invite.label || invite.invite_key,
          TOS_VERSION,
        ]
      );
      const user = userInsert.rows[0];

      await attachInviteUsage(client, invite.id, user.id, normalizedEmail);
      await client.query('COMMIT');

      await logActivity({
        userId: user.id,
        userEmail: user.email,
        eventType: 'auth.register',
        message: 'Beta account created',
        context: {
          betaInviteId: invite.id,
          betaKeyLabel: user.beta_key_label,
          tosVersion: TOS_VERSION,
        },
      });

      const token = createToken(user);
      return res.status(201).json({
        token,
        user: {
          id: user.id,
          name: user.name,
          email: user.email,
          isAdmin: !!user.is_admin,
          betaKeyLabel: user.beta_key_label,
          tosAcceptedAt: user.tos_accepted_at,
          tosVersion: user.tos_version,
        },
      });
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      if (err.message && /beta key|terms of service|email address/i.test(err.message)) {
        return res.status(400).json({ error: err.message });
      }
      throw err;
    } finally {
      client.release();
    }
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
      'SELECT id, name, email, password_hash, is_admin, beta_key_label, tos_accepted_at, tos_version FROM users WHERE email = $1',
      [normalizeEmail(email)]
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

    await db.query('UPDATE users SET last_login_at = NOW() WHERE id = $1', [user.id]);
    await logActivity({
      userId: user.id,
      userEmail: user.email,
      eventType: 'auth.login',
      message: 'User signed in',
    });

    const token = createToken(user);
    return res.json({
      token,
      user: {
        id: user.id,
        name: user.name || email.split('@')[0],
        email: user.email,
        isAdmin: !!user.is_admin,
        betaKeyLabel: user.beta_key_label || null,
        tosAcceptedAt: user.tos_accepted_at || null,
        tosVersion: user.tos_version || null,
      },
    });
  } catch (err) {
    next(err);
  }
});

router.get('/me', authenticate, async (req, res, next) => {
  try {
    const [userRes, cptRes] = await Promise.all([
      db.query(
        `SELECT id, name, email, is_admin, beta_key_label, tos_accepted_at, tos_version, created_at, last_login_at, specialty
           FROM users
          WHERE id = $1
          LIMIT 1`,
        [req.userId]
      ),
      db.query(
        `SELECT synced_at FROM user_cpt_codes WHERE user_id = $1`,
        [req.userId]
      ),
    ]);

    if (!userRes.rows.length) return res.status(404).json({ error: 'User not found' });

    const user = userRes.rows[0];
    const isAdmin = !!user.is_admin || adminByEmail(user.email);
    const cptSyncedAt = cptRes.rows[0]?.synced_at || null;

    return res.json({
      user: {
        id: user.id,
        name: user.name || null,
        email: user.email,
        isAdmin,
        betaKeyLabel: user.beta_key_label || null,
        tosAcceptedAt: user.tos_accepted_at || null,
        tosVersion: user.tos_version || null,
        createdAt: user.created_at,
        lastLoginAt: user.last_login_at,
        specialty: user.specialty || 'plastic-surgery',
        cptSyncedAt,
      },
      app: {
        version: APP_VERSION,
        tosVersion: TOS_VERSION,
      },
    });
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
      await pw.storeSessionCookies(req.userId, result.cookies);
      await logActivity({
        userId: req.userId,
        userEmail: req.userEmail,
        eventType: 'acgme.connect',
        message: 'ACGME account connected successfully',
      });
      // Non-blocking: scrape specialty + sync CPT codes in background
      postConnectSync(req.userId, req.userEmail).catch(() => {});
      return res.json({ success: true, message: 'ACGME account connected successfully' });
    }

    if (result.mfaRequired) {
      await logActivity({
        userId: req.userId,
        userEmail: req.userEmail,
        eventType: 'acgme.mfa_required',
        message: 'ACGME requested MFA during connection',
      });
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
    const { sessionId, code } = req.body;
    if (!sessionId || !code) {
      return res.status(400).json({ error: 'sessionId and code required' });
    }

    const result = await pw.completeMFA(sessionId, code);

    if (result.success) {
      await pw.storeSessionCookies(req.userId, result.cookies);
      await logActivity({
        userId: req.userId,
        userEmail: req.userEmail,
        eventType: 'acgme.mfa_complete',
        message: 'ACGME MFA completed',
      });
      // Non-blocking: scrape specialty + sync CPT codes in background
      postConnectSync(req.userId, req.userEmail).catch(() => {});
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
 * Re-test whether stored session cookies still work against the Insert page.
 * Never runs Playwright login here — that would send MFA/Duo codes unexpectedly.
 * To refresh an expired session, the user must use Settings → Save credentials.
 */
router.post('/verify-acgme', authenticate, async (req, res, next) => {
  try {
    const { rows } = await db.query(
      'SELECT acgme_username FROM user_acgme_credentials WHERE user_id = $1',
      [req.userId]
    );
    if (!rows.length) return res.status(404).json({ error: 'No ACGME credentials saved' });

    const cookieHeader = await pw.getValidCookieHeader(req.userId);
    if (cookieHeader) {
      return res.json({ success: true, sessionActive: true, message: 'ACGME session is active' });
    }

    return res.json({
      success: false,
      sessionActive: false,
      message:
        'ACGME session expired. Open Settings → ACGME Auto-Submit → Edit, enter credentials, and Save (only that action sends verification codes).',
    });
  } catch (err) {
    next(err);
  }
});

/**
 * DELETE /api/auth/disconnect-acgme
 */
router.delete('/disconnect-acgme', authenticate, async (req, res, next) => {
  try {
    await db.query('DELETE FROM user_acgme_credentials WHERE user_id = $1', [req.userId]);
    clearSession(req.userId);
    await logActivity({
      userId: req.userId,
      userEmail: req.userEmail,
      eventType: 'acgme.disconnect',
      message: 'ACGME account disconnected',
    });
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

router.delete('/beta-account', authenticate, async (req, res, next) => {
  try {
    const { rows } = await db.query(
      'SELECT id, email, beta_invite_id, beta_key_label FROM users WHERE id = $1 LIMIT 1',
      [req.userId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Account not found' });
    const user = rows[0];

    await logActivity({
      userId: user.id,
      userEmail: user.email,
      eventType: 'auth.beta_account_delete',
      message: 'Beta user requested account recreation',
      context: {
        betaInviteId: user.beta_invite_id,
        betaKeyLabel: user.beta_key_label,
      },
    });

    await db.query('DELETE FROM users WHERE id = $1', [user.id]);
    clearSession(user.id);
    return res.json({
      success: true,
      message: 'Beta account deleted. You can recreate it using the same email and beta key.',
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
