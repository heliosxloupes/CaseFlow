/**
 * Shared ACGME session acquisition for API routes (cases, lookups).
 * After a silent Playwright re-login, verifies Case Entry Insert loads — same bar as submit.
 */

const db = require('../db');
const { decrypt } = require('./encryptionService');
const pw = require('./playwrightService');
const { getInsertPageData } = require('./acgmeService');

async function getOrRefreshSession(userId) {
  const cookieHeader = await pw.getValidCookieHeader(userId);
  if (cookieHeader) return cookieHeader;

  const { rows } = await db.query(
    'SELECT acgme_username, acgme_password_encrypted FROM user_acgme_credentials WHERE user_id = $1',
    [userId]
  );
  if (!rows.length) {
    throw new Error('No ACGME credentials found. Go to Settings → ACGME Account to connect your account.');
  }

  const password = decrypt(rows[0].acgme_password_encrypted);
  const result = await pw.startLogin(rows[0].acgme_username, password);

  if (result.success) {
    const header = pw.cookiesArrayToHeader(result.cookies);
    try {
      await getInsertPageData(header);
    } catch (e) {
      console.error('[acgmeSession] Insert probe failed after silent login:', e.message);
      throw new Error(
        e.message && /session expired|not authenticated/i.test(e.message)
          ? e.message
          : 'Signed in to ACGME, but Case Entry did not open. If your hospital uses Duo, approve the prompt on your phone, then open Settings → ACGME Account → Reconnect and try again.'
      );
    }
    await pw.storeSessionCookies(userId, result.cookies);
    return header;
  }

  if (result.mfaRequired) {
    const err = new Error(
      'Your ACGME session has expired and MFA verification is required. ' +
        'Please go to Settings → ACGME Account → Reconnect to re-authenticate.'
    );
    err.mfaRequired = true;
    err.sessionId = result.sessionId;
    throw err;
  }

  throw new Error('Failed to refresh ACGME session. Please reconnect your account in Settings.');
}

module.exports = { getOrRefreshSession };
