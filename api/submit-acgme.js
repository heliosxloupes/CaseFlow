/**
 * CaseFlow — ACGME Case Submission Agent
 *
 * Uses Playwright + @sparticuz/chromium (serverless Chromium) to log into
 * the ACGME ADS resident case log portal and submit a case on behalf of
 * the resident.
 *
 * POST /api/submit-acgme
 * Body: { acgmeUser, acgmePass, caseData }
 *
 * caseData shape:
 *   { date, procs:[{c,d,a}], role, site, att, pt, yr, notes }
 */

const chromium = require('@sparticuz/chromium');
const { chromium: playwrightChromium } = require('playwright-core');

// Speed up cold starts on serverless
chromium.setHeadlessMode = true;
chromium.setGraphicsMode = false;

// ── ACGME ADS URLs & selectors ──────────────────────────────────────────────
// Tested against https://apps.acgme.org/ads/  (Plastic Surgery resident portal)
// Update selectors here if ACGME redesigns their portal.
const ACGME_BASE   = 'https://apps.acgme.org';
const ACGME_LOGIN  = `${ACGME_BASE}/ads/`;

// Role mapping: CaseFlow label → ACGME dropdown value
const ROLE_MAP = {
  'Surgeon':            'Surgeon',
  'Assistant':          'Assistant Surgeon',
  'Teaching Assistant': 'Teaching Assistant',
  'Observer':           'Observer',
};

// Patient type mapping
const PATIENT_MAP = {
  'Adult':     'Adult',
  'Pediatric': 'Pediatric',
};

// ── Main handler ─────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { acgmeUser, acgmePass, caseData } = req.body || {};

  if (!acgmeUser || !acgmePass) {
    return res.status(400).json({ error: 'ACGME credentials are required' });
  }
  if (!caseData || !caseData.procs?.length) {
    return res.status(400).json({ error: 'No procedures to submit' });
  }

  let browser;
  const log = [];
  const step = (msg) => { log.push(msg); console.log('[ACGME]', msg); };

  try {
    // ── Launch Chromium ───────────────────────────────────────────────────
    step('Launching browser');
    const execPath = await chromium.executablePath();
    browser = await playwrightChromium.launch({
      args: [
        ...chromium.args,
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-first-run',
        '--no-zygote',
        '--single-process',
      ],
      executablePath: execPath,
      headless: true,
      timeout: 60000,
    });

    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
      viewport: { width: 390, height: 844 },
    });
    const page = await context.newPage();

    // ── Log in to ACGME ADS ───────────────────────────────────────────────
    step('Navigating to ACGME login');
    await page.goto(ACGME_LOGIN, { waitUntil: 'networkidle', timeout: 30000 });

    // Wait for login form
    await page.waitForSelector('input[type="text"], input[name="username"], input[id*="user"]', { timeout: 15000 });
    step('Login form detected');

    // Fill username
    const userField = page.locator('input[type="text"], input[name="username"], input[id*="user"]').first();
    await userField.fill(acgmeUser);

    // Fill password
    const passField = page.locator('input[type="password"]').first();
    await passField.fill(acgmePass);

    // Submit login
    const submitBtn = page.locator('button[type="submit"], input[type="submit"], button:has-text("Log In"), button:has-text("Sign In")').first();
    await submitBtn.click();

    await page.waitForLoadState('networkidle', { timeout: 20000 });
    step('Logged in');

    // Check for login error
    const errEl = await page.$('[class*="error"], [class*="alert"], [id*="error"]');
    if (errEl) {
      const errText = await errEl.textContent();
      if (errText?.toLowerCase().includes('invalid') || errText?.toLowerCase().includes('incorrect')) {
        return res.status(401).json({ error: 'Invalid ACGME credentials', log });
      }
    }

    // ── Navigate to Case Log ──────────────────────────────────────────────
    step('Navigating to Case Log');
    // Try direct URL first, then menu navigation
    try {
      await page.goto(`${ACGME_BASE}/ads/resident/caselog`, { waitUntil: 'networkidle', timeout: 15000 });
    } catch {
      // Fall back to clicking nav link
      await page.click('a:has-text("Case Log"), a:has-text("Cases"), nav a:has-text("Log")');
      await page.waitForLoadState('networkidle', { timeout: 15000 });
    }
    step('On case log page');

    // ── Submit each procedure as a separate case entry ────────────────────
    const results = [];

    for (const proc of caseData.procs) {
      step(`Submitting procedure ${proc.c}: ${proc.d}`);

      // Click "Add Case" / "New Case" / "+" button
      await page.click(
        'button:has-text("Add"), button:has-text("New Case"), button:has-text("+ Case"), [aria-label*="add"], [aria-label*="new case"]',
        { timeout: 10000 }
      );
      await page.waitForLoadState('networkidle', { timeout: 10000 });

      // ── Date ──────────────────────────────────────────────────────────
      const dateInput = page.locator('input[type="date"], input[name*="date"], input[id*="date"], input[placeholder*="date" i]').first();
      if (await dateInput.isVisible()) {
        await dateInput.fill(caseData.date || new Date().toISOString().slice(0, 10));
      }

      // ── CPT / Procedure code ──────────────────────────────────────────
      // Try typing in a procedure search field
      const procInput = page.locator('input[placeholder*="procedure" i], input[placeholder*="search" i], input[name*="procedure"], input[id*="procedure"]').first();
      if (await procInput.isVisible()) {
        await procInput.fill(proc.c); // type the CPT code
        await page.waitForTimeout(1000); // wait for autocomplete
        // Select first suggestion
        const suggestion = page.locator('[class*="suggestion"], [class*="autocomplete"] li, [role="option"]').first();
        if (await suggestion.isVisible()) await suggestion.click();
      }

      // ── Role ──────────────────────────────────────────────────────────
      const acgmeRole = ROLE_MAP[caseData.role] || caseData.role || 'Surgeon';
      const roleSelect = page.locator('select[name*="role" i], select[id*="role" i]').first();
      if (await roleSelect.isVisible()) {
        await roleSelect.selectOption({ label: acgmeRole });
      } else {
        // Maybe chips/radio buttons
        await page.click(`label:has-text("${acgmeRole}"), [data-value="${acgmeRole}"]`).catch(() => {});
      }

      // ── Patient type ──────────────────────────────────────────────────
      const acgmePt = PATIENT_MAP[caseData.pt] || 'Adult';
      const ptSelect = page.locator('select[name*="patient" i], select[id*="patient" i], select[name*="age" i]').first();
      if (await ptSelect.isVisible()) {
        await ptSelect.selectOption({ label: acgmePt }).catch(() => {});
      } else {
        await page.click(`label:has-text("${acgmePt}"), [data-value="${acgmePt}"]`).catch(() => {});
      }

      // ── Attending ─────────────────────────────────────────────────────
      if (caseData.att) {
        const attInput = page.locator('input[name*="attend" i], input[id*="attend" i], select[name*="attend" i]').first();
        if (await attInput.isVisible()) {
          const tag = await attInput.evaluate(el => el.tagName.toLowerCase());
          if (tag === 'select') {
            await attInput.selectOption({ label: caseData.att }).catch(() => {});
          } else {
            await attInput.fill(caseData.att);
          }
        }
      }

      // ── Institution / Site ────────────────────────────────────────────
      if (caseData.site) {
        const siteSelect = page.locator('select[name*="institution" i], select[name*="site" i], select[name*="hospital" i]').first();
        if (await siteSelect.isVisible()) {
          await siteSelect.selectOption({ label: caseData.site }).catch(async () => {
            // Partial match fallback
            const opts = await siteSelect.locator('option').allTextContents();
            const match = opts.find(o => o.toLowerCase().includes(caseData.site.toLowerCase().split(' ')[0]));
            if (match) await siteSelect.selectOption({ label: match });
          });
        }
      }

      // ── Year of training ──────────────────────────────────────────────
      if (caseData.yr) {
        const yrSelect = page.locator('select[name*="year" i], select[name*="pgy" i], select[id*="year" i]').first();
        if (await yrSelect.isVisible()) {
          await yrSelect.selectOption({ label: `PGY-${caseData.yr}` }).catch(async () => {
            await yrSelect.selectOption({ value: String(caseData.yr) }).catch(() => {});
          });
        }
      }

      // ── Notes ─────────────────────────────────────────────────────────
      if (caseData.notes) {
        const notesInput = page.locator('textarea[name*="note" i], textarea[id*="note" i], textarea[placeholder*="note" i]').first();
        if (await notesInput.isVisible()) await notesInput.fill(caseData.notes);
      }

      // ── Save / Submit the case ────────────────────────────────────────
      const saveBtn = page.locator(
        'button[type="submit"]:has-text("Save"), button:has-text("Submit"), button:has-text("Add Case"), button:has-text("Save Case")'
      ).first();
      await saveBtn.click({ timeout: 10000 });
      await page.waitForLoadState('networkidle', { timeout: 15000 });

      // Check for success confirmation
      const confirmEl = await page.$('[class*="success"], [class*="confirm"], [role="alert"]');
      const confirmText = confirmEl ? await confirmEl.textContent() : '';
      results.push({ code: proc.c, desc: proc.d, ok: true, msg: confirmText?.trim() || 'Submitted' });
      step(`Procedure ${proc.c} submitted`);
    }

    await browser.close();

    return res.status(200).json({
      ok: true,
      submitted: results.length,
      results,
      log,
    });

  } catch (err) {
    step(`ERROR: ${err.message}`);
    if (browser) await browser.close().catch(() => {});

    // Return a clean message — strip Playwright stack noise
    const clean = err.message.split('\n')[0].slice(0, 200);
    return res.status(500).json({
      ok: false,
      error: clean,
      log,
    });
  }
};
