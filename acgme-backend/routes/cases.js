const express = require('express');
const router = express.Router();
const { submitCase, loginToACGME } = require('../services/acgmeService');
const { decrypt } = require('../services/encryptionService');
const { getSession, setSession } = require('../services/sessionCache');
const db = require('../db');

/**
 * POST /api/cases/submit
 *
 * Body shape:
 * {
 *   procedureDate:   "3/28/2026",
 *   procedureYear:   "4",
 *   residentRoleId:  "119",      ← from /api/lookups/roles
 *   institutionId:   "29262",    ← from /api/lookups (hidden fields on Insert page)
 *   attendingId:     "633696",   ← from /api/lookups
 *   patientTypeId:   "474",      ← from /api/lookups
 *   selectedCodes:   "P,4780,1118932,1,1",  ← ACGME internal code format
 *   codeDescription: "Breast augmentation",
 *   comments:        ""
 * }
 */
router.post('/submit', async (req, res, next) => {
  try {
    const {
      procedureDate, procedureYear, residentRoleId,
      institutionId, attendingId, patientTypeId,
      selectedCodes, codeDescription, comments,
    } = req.body;

    const required = { procedureDate, procedureYear, residentRoleId, institutionId, attendingId, patientTypeId, selectedCodes };
    const missing = Object.entries(required).filter(([, v]) => !v).map(([k]) => k);
    if (missing.length) {
      return res.status(400).json({ error: `Missing required fields: ${missing.join(', ')}` });
    }

    const cookie = await getOrRefreshSession(req.userId);

    const result = await submitCase(cookie, {
      procedureDate, procedureYear, residentRoleId,
      institutionId, attendingId, patientTypeId,
      selectedCodes, codeDescription, comments,
    });

    await db.query(
      `INSERT INTO case_submissions (user_id, procedure_date, procedure_year, selected_codes, code_description, status, submitted_at)
       VALUES ($1, $2, $3, $4, $5, 'success', NOW())`,
      [req.userId, procedureDate, procedureYear, selectedCodes, codeDescription]
    );

    res.json(result);
  } catch (err) {
    await db.query(
      `INSERT INTO case_submissions (user_id, status, error_message, submitted_at)
       VALUES ($1, 'failed', $2, NOW())`,
      [req.userId, err.message]
    ).catch(() => {});
    next(err);
  }
});

/**
 * GET /api/cases/history
 */
router.get('/history', async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT id, procedure_date, procedure_year, selected_codes, code_description, status, error_message, submitted_at
       FROM case_submissions
       WHERE user_id = $1
       ORDER BY submitted_at DESC
       LIMIT 100`,
      [req.userId]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// ─── Helper ──────────────────────────────────────────────────────────────────

async function getOrRefreshSession(userId) {
  let cookie = getSession(userId);
  if (cookie) return cookie;

  const { rows } = await db.query(
    'SELECT acgme_username, acgme_password_encrypted FROM user_acgme_credentials WHERE user_id = $1',
    [userId]
  );
  if (!rows.length) throw new Error('No ACGME credentials found. Go to Settings → ACGME Account to connect your account.');

  const password = decrypt(rows[0].acgme_password_encrypted);
  cookie = await loginToACGME(rows[0].acgme_username, password);
  setSession(userId, cookie);
  return cookie;
}

module.exports = router;
