const express = require('express');
const router  = express.Router();
const { getLookupData, getUserProfile } = require('../services/acgmeService');
const pw  = require('../services/playwrightService');

// GET /api/lookups/roles?specialtyId=158&activeAsOfDate=3%2F28%2F2026
router.get('/roles', async (req, res, next) => {
  try {
    const cookie = await getLookupSession(req.userId);
    res.json(await getLookupData(cookie, 'roles', req.query));
  } catch (err) { next(err); }
});

// GET /api/lookups/cpt-codes?specialtyId=158&activeAsOfDate=...
router.get('/cpt-codes', async (req, res, next) => {
  try {
    const cookie = await getLookupSession(req.userId);
    res.json(await getLookupData(cookie, 'cptCodes', req.query));
  } catch (err) { next(err); }
});

// GET /api/lookups/types?specialtyId=158
router.get('/types', async (req, res, next) => {
  try {
    const cookie = await getLookupSession(req.userId);
    res.json(await getLookupData(cookie, 'types', req.query));
  } catch (err) { next(err); }
});

// GET /api/lookups/codes?specialtyId=158&codeDesc=19325&activeAsOfDate=3%2F30%2F2026
// (searchTerm is accepted as alias for codeDesc for older clients)
router.get('/codes', async (req, res, next) => {
  try {
    const cookie = await getLookupSession(req.userId);
    res.json(await getLookupData(cookie, 'codes', req.query));
  } catch (err) { next(err); }
});

// GET /api/lookups/user-profile
// Returns the user's program-specific sites and attendings fetched from ACGME.
router.get('/user-profile', async (req, res, next) => {
  try {
    const cookie = await getLookupSession(req.userId);
    const profile = await getUserProfile(cookie);
    res.json(profile);
  } catch (err) { next(err); }
});

// ─── Helper ──────────────────────────────────────────────────────────────────

/**
 * Lookups must NOT run silent Playwright re-login (would send MFA codes unexpectedly).
 * Only returns a cookie header if Insert probe already passes — same bar as submit.
 */
async function getLookupSession(userId) {
  const cookieHeader = await pw.getValidCookieHeader(userId);
  if (cookieHeader) return cookieHeader;
  throw new Error(
    'No active ACGME session. Open Settings → ACGME Account, save credentials, and complete verification — then try again.'
  );
}

module.exports = router;
