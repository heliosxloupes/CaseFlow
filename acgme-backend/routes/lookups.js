const express = require('express');
const router  = express.Router();
const { getLookupData, getUserProfile } = require('../services/acgmeService');
const { decrypt }       = require('../services/encryptionService');
const pw  = require('../services/playwrightService');
const db  = require('../db');

// GET /api/lookups/roles?specialtyId=158&activeAsOfDate=3%2F28%2F2026
router.get('/roles', async (req, res, next) => {
  try {
    const cookie = await getOrRefreshSession(req.userId);
    res.json(await getLookupData(cookie, 'roles', req.query));
  } catch (err) { next(err); }
});

// GET /api/lookups/cpt-codes?specialtyId=158&activeAsOfDate=...
router.get('/cpt-codes', async (req, res, next) => {
  try {
    const cookie = await getOrRefreshSession(req.userId);
    res.json(await getLookupData(cookie, 'cptCodes', req.query));
  } catch (err) { next(err); }
});

// GET /api/lookups/types?specialtyId=158
router.get('/types', async (req, res, next) => {
  try {
    const cookie = await getOrRefreshSession(req.userId);
    res.json(await getLookupData(cookie, 'types', req.query));
  } catch (err) { next(err); }
});

// GET /api/lookups/codes?specialtyId=158&searchTerm=breast
router.get('/codes', async (req, res, next) => {
  try {
    const cookie = await getOrRefreshSession(req.userId);
    res.json(await getLookupData(cookie, 'codes', req.query));
  } catch (err) { next(err); }
});

// GET /api/lookups/user-profile
// Returns the user's program-specific sites and attendings fetched from ACGME.
router.get('/user-profile', async (req, res, next) => {
  try {
    const cookie = await getOrRefreshSession(req.userId);
    const profile = await getUserProfile(cookie);
    res.json(profile);
  } catch (err) { next(err); }
});

// ─── Helper ──────────────────────────────────────────────────────────────────

async function getOrRefreshSession(userId) {
  const cookieHeader = await pw.getValidCookieHeader(userId);
  if (cookieHeader) return cookieHeader;

  const { rows } = await db.query(
    'SELECT acgme_username, acgme_password_encrypted FROM user_acgme_credentials WHERE user_id = $1',
    [userId]
  );
  if (!rows.length) throw new Error('No ACGME credentials found. Please connect your ACGME account in Settings.');

  const password = decrypt(rows[0].acgme_password_encrypted);
  const result   = await pw.startLogin(rows[0].acgme_username, password);

  if (result.success) {
    await pw.storeSessionCookies(userId, result.cookies);
    return pw.cookiesArrayToHeader(result.cookies);
  }

  throw new Error('ACGME session expired. Please reconnect your account in Settings → ACGME Account.');
}

module.exports = router;
