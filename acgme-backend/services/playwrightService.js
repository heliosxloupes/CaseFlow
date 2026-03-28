/**
 * Playwright-based ACGME login service.
 *
 * Replaces the broken node-fetch B2C approach with a real browser that can:
 *   - Handle Azure AD B2C's two-step (email → password) flow
 *   - Pause and wait for MFA codes entered by the user in the app
 *   - Store valid session cookies in the DB (valid ~14 days due to B2C SSO)
 *
 * Flow:
 *   1. startLogin(username, password)
 *      → success:     { success: true, cookies: [...] }
 *      → MFA needed:  { success: false, mfaRequired: true, sessionId: 'hex' }
 *   2. completeMFA(sessionId, code)
 *      → success:     { success: true, cookies: [...] }
 *
 * Cookie lifecycle:
 *   - After a successful login, call storeSessionCookies(userId, cookies)
 *   - Before submitting a case, call getValidCookieHeader(userId)
 *     which loads DB cookies, validates them, and refreshes if possible
 */

const { chromium } = require('playwright');
const crypto = require('crypto');
const db = require('../db');
const { encrypt, decrypt } = require('./encryptionService');
const { setSession, getSession } = require('./sessionCache');

const ACGME_ORIGIN = 'https://apps.acgme.org';
const B2C_TENANT   = 'acgmeras.b2clogin.com';
const B2C_POLICY   = 'b2c_1a_signup_signin';
const B2C_CLIENT   = 'dcdddbd1-2b64-4940-9983-6a6442c526aa';
const B2C_REDIRECT = 'https://apps.acgme.org/ads/';

// In-memory map of sessionId → pending MFA session data
const pendingMfaSessions = new Map();

function launchBrowser() {
  return chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--single-process',
    ],
  });
}

// ── Cookie Persistence ────────────────────────────────────────────────────────

/**
 * Serialize a Playwright cookies array to an encrypted JSON string for DB storage.
 */
async function storeSessionCookies(userId, cookies) {
  const json      = JSON.stringify(cookies);
  const encrypted = encrypt(json);
  await db.query(
    `UPDATE user_acgme_credentials
     SET browser_cookies = $1, cookies_updated_at = NOW()
     WHERE user_id = $2`,
    [encrypted, userId]
  );
  // Also warm the in-memory cache
  setSession(userId, cookiesArrayToHeader(cookies));
  console.log(`[PW] Stored ${cookies.length} cookies for user ${userId}`);
}

/**
 * Load stored Playwright cookies array from DB.
 */
async function loadStoredCookies(userId) {
  try {
    const { rows } = await db.query(
      'SELECT browser_cookies, cookies_updated_at FROM user_acgme_credentials WHERE user_id = $1',
      [userId]
    );
    if (!rows.length || !rows[0].browser_cookies) return null;
    const cookies = JSON.parse(decrypt(rows[0].browser_cookies));
    console.log(`[PW] Loaded ${cookies.length} stored cookies for user ${userId}`);
    return cookies;
  } catch (err) {
    console.error('[PW] Failed to load stored cookies:', err.message);
    return null;
  }
}

/**
 * Convert a Playwright cookies array to a Cookie header string for node-fetch.
 */
function cookiesArrayToHeader(cookies) {
  return cookies
    .filter(c => c.domain && c.domain.includes('acgme.org'))
    .map(c => `${c.name}=${c.value}`)
    .join('; ');
}

/**
 * Test whether stored cookies are still valid by hitting an authenticated ACGME endpoint.
 */
async function testCookiesValid(cookies) {
  const fetch       = require('node-fetch');
  const cookieHeader = cookiesArrayToHeader(cookies);
  if (!cookieHeader) return false;
  try {
    const res = await fetch(`${ACGME_ORIGIN}/ads/CaseLogs/CaseEntryMobile/GetResidentRoles`, {
      headers: {
        Cookie:              cookieHeader,
        'X-Requested-With': 'XMLHttpRequest',
        Accept:              'application/json',
      },
    });
    return res.status === 200;
  } catch {
    return false;
  }
}

/**
 * Get a valid Cookie header string for a user, attempting refresh if necessary.
 * Returns null if no valid session is available (user must reconnect ACGME).
 */
async function getValidCookieHeader(userId) {
  // 1. Check in-memory session cache (25-min TTL)
  const cached = getSession(userId);
  if (cached) return cached;

  // 2. Load cookies stored in DB
  const cookies = await loadStoredCookies(userId);
  if (!cookies || cookies.length === 0) return null;

  // 3. Test if they still work
  const valid = await testCookiesValid(cookies);
  if (valid) {
    const header = cookiesArrayToHeader(cookies);
    setSession(userId, header); // warm cache for 25 min
    return header;
  }

  console.log(`[PW] Stored cookies for user ${userId} are no longer valid`);
  return null;
}

// ── Playwright Login ──────────────────────────────────────────────────────────

/**
 * Start a Playwright-based ACGME login.
 *
 * @returns
 *   { success: true,  cookies }              — login succeeded, no MFA
 *   { success: false, mfaRequired: true, sessionId } — MFA page shown, browser kept alive
 */
async function startLogin(username, password) {
  const browser = await launchBrowser();
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  });
  const page = await context.newPage();

  try {
    // Navigate directly to the B2C authorize URL so we go straight to the login form
    const authorizeUrl = `https://${B2C_TENANT}/acgmeras.onmicrosoft.com/${B2C_POLICY}/oauth2/v2.0/authorize`
      + `?client_id=${B2C_CLIENT}`
      + `&redirect_uri=${encodeURIComponent(B2C_REDIRECT)}`
      + `&response_type=code%20id_token`
      + `&scope=openid%20profile%20offline_access`
      + `&response_mode=form_post`
      + `&nonce=pw${Date.now()}`;

    console.log('[PW] Navigating to B2C authorize...');
    await page.goto(authorizeUrl, { timeout: 30000, waitUntil: 'domcontentloaded' });

    // Accept cookie consent banner if it appears
    const cookieBtn = page.locator('button:has-text("Accept"), button:has-text("I accept"), #acceptButton').first();
    if (await cookieBtn.count() > 0) {
      await cookieBtn.click().catch(() => {});
    }

    // ── Step 1: Email ─────────────────────────────────────────────────────────
    console.log('[PW] Waiting for email input...');
    const emailInput = page.locator(
      '#signInName, input[name="signInName"], input[name="logonIdentifier"], input[type="email"]'
    ).first();
    await emailInput.waitFor({ state: 'visible', timeout: 20000 });
    await emailInput.fill(username);

    // Click Continue
    await page.locator('#continue, button#continue, button:has-text("Continue"), button[type="submit"]').first().click();
    await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});

    // ── Step 2: Password ──────────────────────────────────────────────────────
    console.log('[PW] Waiting for password input...');
    const passwordInput = page.locator('#password, input[name="password"], input[type="password"]').first();
    await passwordInput.waitFor({ state: 'visible', timeout: 20000 });
    await passwordInput.fill(password);

    // Click Sign In
    await page.locator('#next, button#next, button:has-text("Sign in"), button[type="submit"]').first().click();

    // ── Wait for outcome ──────────────────────────────────────────────────────
    console.log('[PW] Waiting for login outcome...');

    // Use 'attached' (not 'visible') — verificationCode starts hidden; we'll trigger Send Code
    const outcome = await Promise.race([
      page.waitForURL(`${ACGME_ORIGIN}/ads/**`, { timeout: 45000 }).then(() => 'success'),
      page.waitForSelector('#verificationCode', { timeout: 40000, state: 'attached' }).then(() => 'mfa'),
      page.waitForSelector('#errorMessage', { timeout: 40000, state: 'visible' }).then(() => 'error'),
    ]).catch(() => 'timeout');

    const currentUrl = page.url();
    const pageTitle  = await page.title().catch(() => '');
    console.log(`[PW] Outcome: ${outcome} | title: ${pageTitle} | url: ${currentUrl.slice(0, 80)}`);

    // ── Handle outcomes ───────────────────────────────────────────────────────
    if (outcome === 'success') {
      const cookies = await context.cookies([ACGME_ORIGIN]);
      await browser.close();
      console.log(`[PW] Login succeeded, captured ${cookies.length} cookies`);
      return { success: true, cookies };
    }

    if (outcome === 'mfa') {
      // Click "Send Code" / "Send verification code" to trigger OTP delivery to user's email/phone
      console.log('[PW] MFA page detected — looking for Send Code button...');
      try {
        const sendBtn = page.locator('#sendCode, button:has-text("Send Code"), button:has-text("Send")').first();
        if (await sendBtn.count() > 0) {
          await sendBtn.click();
          console.log('[PW] Clicked #sendCode, waiting for verificationCode to become visible...');
          await page.waitForSelector('#verificationCode', { state: 'visible', timeout: 20000 }).catch(() => {});
        }
      } catch (e) {
        console.log('[PW] Send Code warning:', e.message);
      }

      const sessionId = crypto.randomBytes(16).toString('hex');
      const timer = setTimeout(async () => {
        const s = pendingMfaSessions.get(sessionId);
        if (s) {
          await s.browser.close().catch(() => {});
          pendingMfaSessions.delete(sessionId);
          console.log(`[PW] MFA session ${sessionId} expired after 5 min`);
        }
      }, 5 * 60 * 1000);

      pendingMfaSessions.set(sessionId, { browser, context, page, timer });
      console.log(`[PW] MFA required, sessionId=${sessionId}`);
      return { success: false, mfaRequired: true, sessionId };
    }

    // Error or timeout
    const errText = await page
      .locator('#errorMessage, .error.pageLevel, [aria-live="assertive"]')
      .textContent()
      .catch(() => '');
    await browser.close();
    throw new Error(`ACGME login failed (${outcome}): ${errText.trim() || 'Unknown error'}`);

  } catch (err) {
    await browser.close().catch(() => {});
    throw err;
  }
}

/**
 * Complete an MFA challenge.
 *
 * @param {string} sessionId  returned from startLogin()
 * @param {string} code       the OTP/verification code from the user
 * @returns { success: true, cookies }
 */
async function completeMFA(sessionId, code) {
  const session = pendingMfaSessions.get(sessionId);
  if (!session) {
    throw new Error('MFA session not found or expired. Please start the ACGME connection again.');
  }

  const { browser, context, page, timer } = session;
  clearTimeout(timer);

  try {
    console.log(`[PW] Entering MFA code for session ${sessionId}...`);

    // Fill in the OTP — ACGME B2C uses #verificationCode
    await page.waitForSelector('#verificationCode', { state: 'visible', timeout: 10000 }).catch(() => {});
    const otpInput = page.locator('#verificationCode, input[name="otpCode"], input[type="tel"]').first();
    await otpInput.fill(code);

    // Submit — B2C "Verify Code" button
    await page.locator('#verifyCode, button:has-text("Verify Code"), button:has-text("Verify")').first().click();

    // Wait for ACGME to load
    await page.waitForURL(`${ACGME_ORIGIN}/ads/**`, { timeout: 35000 });

    const cookies = await context.cookies([ACGME_ORIGIN]);
    await browser.close();
    pendingMfaSessions.delete(sessionId);

    console.log(`[PW] MFA completed, captured ${cookies.length} cookies`);
    return { success: true, cookies };

  } catch (err) {
    await browser.close().catch(() => {});
    pendingMfaSessions.delete(sessionId);
    throw err;
  }
}

module.exports = {
  startLogin,
  completeMFA,
  storeSessionCookies,
  loadStoredCookies,
  getValidCookieHeader,
  testCookiesValid,
  cookiesArrayToHeader,
};
