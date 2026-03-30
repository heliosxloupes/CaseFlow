const express = require('express');
const router = express.Router();
const { submitCase } = require('../services/acgmeService');
const pw = require('../services/playwrightService');
const sessionCache = require('../services/sessionCache');
const db = require('../db');

/** One retry after clearing in-memory ACGME cookie cache + forcing refresh (handles flaky / racey sessions). */
function isRetryableAcgmeSessionError(err) {
  if (!err || err.mfaRequired) return false;
  const msg = String(err.message || '');
  return /session expired|not authenticated|Insert returned redirect|Could not find __RequestVerificationToken|Failed to load ACGME Insert page/i.test(msg);
}

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
 *   selectedCodes:   "30410" or "P,4780,1118932,1,1"  ← bare CPT is resolved server-side via GetCodes; tuples pass through
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
      caseId = '',
    } = req.body;

    const required = { procedureDate, procedureYear, residentRoleId, institutionId, attendingId, patientTypeId, selectedCodes };
    const missing = Object.entries(required).filter(([, v]) => !v).map(([k]) => k);
    if (missing.length) {
      return res.status(400).json({ error: `Missing required fields: ${missing.join(', ')}` });
    }

    const casePayload = {
      procedureDate, procedureYear, residentRoleId,
      institutionId, attendingId, patientTypeId,
      selectedCodes, codeDescription, comments,
      caseId,
    };

    let result;
    let lastErr;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        if (attempt > 0) {
          sessionCache.clearSession(req.userId);
          console.log(`[cases/submit] Retry ${attempt} after session error; cleared cookie cache for user ${req.userId}`);
        }
        const cookie = await getOrRefreshSession(req.userId);
        result = await submitCase(cookie, casePayload);
        break;
      } catch (err) {
        lastErr = err;
        if (err.mfaRequired) throw err;
        if (attempt === 0 && isRetryableAcgmeSessionError(err)) continue;
        throw err;
      }
    }
    if (!result) throw lastErr || new Error('Submit failed');

    await db.query(
      `INSERT INTO case_submissions (user_id, procedure_date, procedure_year, selected_codes, code_description, status, submitted_at)
       VALUES ($1, $2, $3, $4, $5, 'success', NOW())`,
      [req.userId, procedureDate, procedureYear, selectedCodes, codeDescription]
    );

    res.json(result);
  } catch (err) {
    // Do NOT insert a bare “failed” row with no case data — those polluted history as
    // “No procedures listed / Invalid Date”. Errors are returned to the client; real cases
    // stay in /api/cases/save rows or localStorage.

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
         AND NOT (
           status = 'failed'
           AND (procedure_date IS NULL OR TRIM(procedure_date) = '')
           AND (selected_codes IS NULL OR TRIM(selected_codes) = '')
         )
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
  // Only use cookies that already pass the Insert probe. Never run Playwright login from
  // submit — that would send MFA/Duo codes without the user pressing Save in Settings.
  const cookieHeader = await pw.getValidCookieHeader(userId);
  if (cookieHeader) return cookieHeader;

  throw new Error(
    'No active ACGME session. Open Settings → ACGME Account, save credentials, and complete verification — then try again.'
  );
}

module.exports = router;
