const express = require('express');
const router = express.Router();
const { getLookupData, loginToACGME } = require('../services/acgmeService');
const { getSession, setSession } = require('../services/sessionCache');
const { decrypt } = require('../services/encryptionService');
const db = require('../db');

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

// ─── Helper ──────────────────────────────────────────────────────────────────

async function getOrRefreshSession(userId) {
  let cookie = getSession(userId);
  if (cookie) return cookie;

  const { rows } = await db.query(
    'SELECT acgme_username, acgme_password_encrypted FROM user_acgme_credentials WHERE user_id = $1',
    [userId]
  );
  if (!rows.length) throw new Error('No ACGME credentials found.');

  const password = decrypt(rows[0].acgme_password_encrypted);
  cookie = await loginToACGME(rows[0].acgme_username, password);
  setSession(userId, cookie);
  return cookie;
}

module.exports = router;
