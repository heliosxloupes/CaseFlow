const express = require('express');
const router = express.Router();
const { loginToACGME } = require('../services/acgmeService');
const { encrypt, decrypt } = require('../services/encryptionService');
const { setSession, clearSession } = require('../services/sessionCache');
const { authenticate } = require('../middleware/authenticate');
const db = require('../db');

/**
 * POST /api/auth/save-credentials
 * Saves & verifies ACGME credentials for the logged-in user.
 * Call this when user first sets up their ACGME account in Settings.
 */
router.post('/save-credentials', authenticate, async (req, res, next) => {
  try {
    const { acgmeUsername, acgmePassword } = req.body;
    if (!acgmeUsername || !acgmePassword) {
      return res.status(400).json({ error: 'Username and password required' });
    }

    // Verify the credentials actually work before saving
    const cookie = await loginToACGME(acgmeUsername, acgmePassword);

    // Cache the session so the first submission is instant
    setSession(req.userId, cookie);

    const encryptedPassword = encrypt(acgmePassword);
    await db.query(
      `INSERT INTO user_acgme_credentials (user_id, acgme_username, acgme_password_encrypted, created_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (user_id) DO UPDATE
       SET acgme_username = $2, acgme_password_encrypted = $3, updated_at = NOW()`,
      [req.userId, acgmeUsername, encryptedPassword]
    );

    res.json({ success: true, message: 'ACGME credentials saved and verified' });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/auth/verify-acgme
 * Tests if stored credentials still work (use in Settings status check).
 */
router.post('/verify-acgme', authenticate, async (req, res, next) => {
  try {
    const { rows } = await db.query(
      'SELECT acgme_username, acgme_password_encrypted FROM user_acgme_credentials WHERE user_id = $1',
      [req.userId]
    );
    if (!rows.length) return res.status(404).json({ error: 'No ACGME credentials saved' });

    const password = decrypt(rows[0].acgme_password_encrypted);
    const cookie = await loginToACGME(rows[0].acgme_username, password);
    setSession(req.userId, cookie);
    res.json({ success: true, message: 'ACGME login successful' });
  } catch (err) {
    next(err);
  }
});

/**
 * DELETE /api/auth/disconnect-acgme
 * Removes stored ACGME credentials.
 */
router.delete('/disconnect-acgme', authenticate, async (req, res, next) => {
  try {
    await db.query('DELETE FROM user_acgme_credentials WHERE user_id = $1', [req.userId]);
    clearSession(req.userId);
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/auth/acgme-status
 * Returns whether the user has ACGME credentials saved.
 */
router.get('/acgme-status', authenticate, async (req, res, next) => {
  try {
    const { rows } = await db.query(
      'SELECT acgme_username, created_at FROM user_acgme_credentials WHERE user_id = $1',
      [req.userId]
    );
    if (!rows.length) return res.json({ connected: false });
    res.json({ connected: true, username: rows[0].acgme_username, savedAt: rows[0].created_at });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
