const express = require('express');
const router = express.Router();
const { submitCase } = require('../services/acgmeService');
const { decrypt } = require('../services/encryptionService');
const pw = require('../services/playwrightService');
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

    // Surface MFA requirement as a structured response (not a 500)
    if (err.mfaRequired) {
      return res.status(401).json({
        error:       err.message,
        mfaRequired: true,
        sessionId:   err.sessionId,
      });
    }
    next(err);
  }
});

/**
 * GET /api/cases/history
 * Returns full case data for the authenticated user
 */
router.get('/history', async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT id, local_id, procedure_date, procedure_year, selected_codes, code_description,
              role, site, attending, patient_type, case_year, notes, procedures,
              status, error_message, submitted_at
       FROM case_submissions
       WHERE user_id = $1
       ORDER BY submitted_at DESC
       LIMIT 200`,
      [req.userId]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/cases/save
 * Saves a full case locally without ACGME submission (pending status).
 * Body: { localId, procedureDate, procedures, role, site, attending, patientType, caseYear, notes }
 */
router.post('/save', async (req, res, next) => {
  try {
    const {
      localId, procedureDate, procedures = [], role, site,
      attending, patientType, caseYear, notes = '',
    } = req.body;

    const codeDescription = procedures.map(p => p.d).join(', ');
    const selectedCodes   = procedures.map(p => p.c).join(', ');

    const { rows } = await db.query(
      `INSERT INTO case_submissions
        (user_id, local_id, procedure_date, selected_codes, code_description,
         role, site, attending, patient_type, case_year, notes, procedures, status, submitted_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'pending',NOW())
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [
        req.userId, localId || null, procedureDate, selectedCodes, codeDescription,
        role, site, attending, patientType, caseYear, notes, JSON.stringify(procedures),
      ]
    );

    res.json({ success: true, id: rows[0]?.id });
  } catch (err) {
    next(err);
  }
});

/**
 * PATCH /api/cases/:id/status
 * Update the status of a case (e.g. after re-submission)
 */
router.patch('/:id/status', async (req, res, next) => {
  try {
    const { status, errorMessage } = req.body;
    await db.query(
      `UPDATE case_submissions SET status=$1, error_message=$2, submitted_at=NOW()
       WHERE id=$3 AND user_id=$4`,
      [status, errorMessage || null, req.params.id, req.userId]
    );
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

/**
 * DELETE /api/cases/:id
 */
router.delete('/:id', async (req, res, next) => {
  try {
    await db.query(
      'DELETE FROM case_submissions WHERE id=$1 AND user_id=$2',
      [req.params.id, req.userId]
    );
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// ─── Helper ──────────────────────────────────────────────────────────────────

async function getOrRefreshSession(userId) {
  // 1. Try in-memory cache or still-valid stored cookies
  const cookieHeader = await pw.getValidCookieHeader(userId);
  if (cookieHeader) return cookieHeader;

  // 2. Cookies expired — try a silent Playwright re-login (works within 14-day B2C SSO window)
  const { rows } = await db.query(
    'SELECT acgme_username, acgme_password_encrypted FROM user_acgme_credentials WHERE user_id = $1',
    [userId]
  );
  if (!rows.length) {
    throw new Error('No ACGME credentials found. Go to Settings → ACGME Account to connect your account.');
  }

  const password = decrypt(rows[0].acgme_password_encrypted);
  const result   = await pw.startLogin(rows[0].acgme_username, password);

  if (result.success) {
    await pw.storeSessionCookies(userId, result.cookies);
    return pw.cookiesArrayToHeader(result.cookies);
  }

  if (result.mfaRequired) {
    // Can't proceed with case submission — user must complete MFA first
    const err = new Error(
      'Your ACGME session has expired and MFA verification is required. ' +
      'Please go to Settings → ACGME Account → Reconnect to re-authenticate.'
    );
    err.mfaRequired = true;
    err.sessionId   = result.sessionId;
    throw err;
  }

  throw new Error('Failed to refresh ACGME session. Please reconnect your account in Settings.');
}

module.exports = router;
