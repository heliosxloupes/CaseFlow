const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
require('dotenv').config();

const authRoutes = require('./routes/auth');
const caseRoutes = require('./routes/cases');
const lookupRoutes = require('./routes/lookups');
const { errorHandler } = require('./middleware/errorHandler');
const { authenticate } = require('./middleware/authenticate');
const { migrate } = require('./db/migrate');

const app = express();

app.use(cors({ origin: '*' }));
app.use(express.json());

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
});
app.use(limiter);

app.use('/api/auth', authRoutes);
app.use('/api/cases', authenticate, caseRoutes);
app.use('/api/lookups', authenticate, lookupRoutes);

app.get('/health', (req, res) => {
  const dbUrl = process.env.DATABASE_URL || '';
  res.json({
    status: 'ok',
    jwtConfigured: !!process.env.JWT_SECRET,
    dbConfigured: !!dbUrl,
    dbUrlPrefix: dbUrl.slice(0, 40) || 'EMPTY',
    encryptionConfigured: !!process.env.ENCRYPTION_KEY,
  });
});

// Test actual DB connection
app.get('/health/db', async (req, res) => {
  const db = require('./db');
  const dbUrl = process.env.DATABASE_URL || '';
  try {
    await db.query('SELECT 1');
    res.json({ connected: true, dbUrlPrefix: dbUrl.slice(0, 50) });
  } catch (err) {
    res.status(500).json({
      connected: false,
      error: err.message,
      dbUrlPrefix: dbUrl.slice(0, 50),
      dbConfigured: !!dbUrl,
    });
  }
});

// Debug: test B2C login flow step-by-step
app.post('/debug/b2c-login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'username and password required' });
  try {
    // Import the modular helpers from acgmeService
    // We re-implement inline so we can return intermediate state
    const fetch = require('node-fetch');
    const AbortController = require('abort-controller');
    const { URLSearchParams } = require('url');
    const B2C_TENANT = 'acgmeras.b2clogin.com';
    const B2C_POLICY = 'b2c_1a_signup_signin';
    const B2C_CLIENT = 'dcdddbd1-2b64-4940-9983-6a6442c526aa';
    const B2C_REDIRECT = 'https://apps.acgme.org/ads/';
    const B2C_BASE = `https://${B2C_TENANT}/acgmeras.onmicrosoft.com/${B2C_POLICY}`;
    const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15';

    function parseCookies(arr) { return arr.map(c => c.split(';')[0]).join('; '); }
    async function ft(url, opts, ms = 12000) {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), ms);
      try { return await fetch(url, { ...opts, signal: ctrl.signal }); }
      finally { clearTimeout(t); }
    }

    // Step 1: authorize - follow manually
    const authorizeUrl = `${B2C_BASE}/oauth2/v2.0/authorize`
      + `?client_id=${B2C_CLIENT}&redirect_uri=${encodeURIComponent(B2C_REDIRECT)}`
      + `&response_type=code%20id_token&scope=openid%20profile&response_mode=form_post&nonce=dbg${Date.now()}`;

    let url = authorizeUrl;
    let cookies = [];
    let loginHtml = '';
    let loginUrl = '';
    const hops = [];

    for (let i = 0; i < 8; i++) {
      const r = await ft(url, { headers: { 'User-Agent': UA, 'Cookie': parseCookies(cookies) }, redirect: 'manual' }, 10000);
      const sc = r.headers.raw()['set-cookie'] || [];
      cookies = [...cookies, ...sc];
      const loc = r.headers.get('location') || '';
      hops.push({ hop: i, status: r.status, url: url.slice(0, 100), location: loc.slice(0, 100) });
      if (r.status >= 200 && r.status < 300) { loginHtml = await r.text(); loginUrl = url; break; }
      if (r.status >= 300 && r.status < 400) {
        if (loc.startsWith(B2C_REDIRECT)) { hops.push({ note: 'Redirected to ACGME before login page!' }); break; }
        url = loc.startsWith('http') ? loc : `https://${B2C_TENANT}${loc}`;
        continue;
      }
      hops.push({ error: `HTTP ${r.status}` }); break;
    }

    // Step 2: extract config
    let csrf = null, transId = null, apiBase = B2C_BASE;
    const sm = loginHtml.match(/var\s+SETTINGS\s*=\s*(\{[\s\S]*?\});/i);
    if (sm) { try { const s = JSON.parse(sm[1]); csrf = s.csrf; transId = s.transId; if (s.hosts?.tenant) apiBase = `https://${B2C_TENANT}${s.hosts.tenant}`; } catch(_){} }
    if (!csrf)    csrf    = loginHtml.match(/"csrf"\s*:\s*"([^"]+)"/)?.[1] || null;
    if (!transId) transId = loginHtml.match(/"transId"\s*:\s*"([^"]+)"/)?.[1] || loginUrl.match(/[?&]tx=([^&]+)/)?.[1] || null;

    // Merge cookies: later values override earlier ones for same name
    function mergeCookies(existing, newer) {
      const map = {};
      [...existing, ...newer].forEach(c => {
        const part = c.split(';')[0]; const eq = part.indexOf('=');
        if (eq > 0) map[part.slice(0, eq).trim()] = part;
      });
      return Object.values(map).join('; ');
    }

    // Step 3: POST credentials — use apiBase (case-correct from SETTINGS)
    const saUrl = `${apiBase}/SelfAsserted?tx=${transId||''}&p=${B2C_POLICY}`;
    const saHeaders = {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': UA, 'Cookie': mergeCookies(cookies, []),
      'Referer': loginUrl, 'Origin': `https://${B2C_TENANT}`, 'X-Requested-With': 'XMLHttpRequest',
    };
    if (csrf) saHeaders['X-CSRF-TOKEN'] = csrf;
    const saBody = new URLSearchParams({ signInName: username, password, request_type: 'RESPONSE' });
    const saRes = await ft(saUrl, { method: 'POST', headers: saHeaders, body: saBody.toString(), redirect: 'manual' }, 12000);
    const saText = await saRes.text();
    const saCookies = saRes.headers.raw()['set-cookie'] || [];
    const cookiesAfterSA = mergeCookies(cookies, saCookies); // merged string

    // Step 4: GET confirmed — follow redirects to see final destination
    const confirmedUrl = `${apiBase}/api/CombinedSigninAndSignup/confirmed`
      + `?rememberMe=false&csrf_token=${encodeURIComponent(csrf||'')}&tx=${transId||''}&p=${B2C_POLICY}`;
    const cfRes = await ft(confirmedUrl, {
      headers: { 'User-Agent': UA, 'Cookie': cookiesAfterSA, 'Referer': loginUrl, 'Accept': 'text/html,application/xhtml+xml' },
      redirect: 'follow',
    }, 15000);
    const cfText = await cfRes.text();
    const cfCookies = cfRes.headers.raw()['set-cookie'] || [];
    const cfLocation = cfRes.headers.get('location') || '';
    const cookiesAfterCF = mergeCookies(cookies, [...saCookies, ...cfCookies]);

    // Step 4b: If confirmed returned the login page again (new transId), do ANOTHER SelfAsserted POST
    let step4bStatus = null, step4bBody = null;
    const cfSettings = cfText.match(/var\s+SETTINGS\s*=\s*(\{[\s\S]*?\});/i);
    let cfTransId = null, cfCsrf = null;
    if (cfSettings) { try { const s = JSON.parse(cfSettings[1]); cfTransId = s.transId; cfCsrf = s.csrf; } catch(_){} }

    if (cfTransId && cfTransId !== transId) {
      // New session started — post credentials again with new transId
      const sa2Url = `${apiBase}/SelfAsserted?tx=${cfTransId}&p=${B2C_POLICY}`;
      const sa2Headers = {
        'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA,
        'Cookie': cookiesAfterCF, 'Referer': confirmedUrl, 'Origin': `https://${B2C_TENANT}`,
        'X-Requested-With': 'XMLHttpRequest',
      };
      if (cfCsrf) sa2Headers['X-CSRF-TOKEN'] = cfCsrf;
      const sa2Body = new URLSearchParams({ signInName: username, password, request_type: 'RESPONSE' });
      const sa2Res = await ft(sa2Url, { method: 'POST', headers: sa2Headers, body: sa2Body.toString(), redirect: 'manual' }, 12000);
      const sa2Text = await sa2Res.text();
      const sa2Cookies = sa2Res.headers.raw()['set-cookie'] || [];
      step4bStatus = sa2Res.status;
      step4bBody = sa2Text;
      cookiesAfterCF = mergeCookies(cookiesAfterCF.split('; ').map(p => p + '; Path=/'), sa2Cookies);

      // If step4b worked, try confirmed again
      if (sa2Res.status === 200) {
        const cf2Url = `${apiBase}/api/CombinedSigninAndSignup/confirmed`
          + `?rememberMe=false&csrf_token=${encodeURIComponent(cfCsrf||'')}&tx=${cfTransId}&p=${B2C_POLICY}`;
        const cf2Res = await ft(cf2Url, {
          headers: { 'User-Agent': UA, 'Cookie': cookiesAfterCF, 'Referer': confirmedUrl },
          redirect: 'follow',
        }, 12000);
        const cf2Text = await cf2Res.text();
        const cf2Cookies = cf2Res.headers.raw()['set-cookie'] || [];
        step4bBody += ' | CF2 status:' + cf2Res.status + ' | idToken in CF2:' + cf2Text.includes('id_token') + ' | formIn CF2:' + cf2Text.includes('<form');
        // Update cfText and cfCookies for step 5
        cfText.__replaced = cf2Text; // for display only
        cookiesAfterCF = mergeCookies(cookiesAfterCF.split('; ').map(p => p + '; Path=/'), cf2Cookies);
      }
    }

    // Step 5: POST id_token if present
    const idToken = cfText.match(/name="id_token"\s+value="([^"]+)"/i)?.[1];
    const code    = cfText.match(/name="code"\s+value="([^"]+)"/i)?.[1];
    const action  = cfText.match(/<form[^>]+action="([^"]+)"/i)?.[1]?.replace(/&amp;/g, '&');
    let acgmeStatus = null, acgmeCookieCount = 0, acgmeCookieNames = [];
    if (idToken || code) {
      const tokenBody = new URLSearchParams();
      if (idToken) tokenBody.append('id_token', idToken);
      if (code) tokenBody.append('code', code);
      const stateM = cfText.match(/name="state"\s+value="([^"]+)"/i);
      if (stateM) tokenBody.append('state', stateM[1]);
      const acgmeRes = await ft(action || 'https://apps.acgme.org/ads/', {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA, 'Cookie': cookiesAfterCF },
        body: tokenBody.toString(), redirect: 'follow',
      }, 12000);
      const acgmeCookies = acgmeRes.headers.raw()['set-cookie'] || [];
      acgmeStatus = acgmeRes.status;
      acgmeCookieCount = acgmeCookies.length;
      acgmeCookieNames = acgmeCookies.map(c => c.split('=')[0]);
    }

    // Extract full SETTINGS from initial login page for diagnosis
    let settingsParsed = null;
    const sm2 = loginHtml.match(/var\s+SETTINGS\s*=\s*(\{[\s\S]*?\});/i);
    if (sm2) { try { settingsParsed = JSON.parse(sm2[1]); } catch(_){} }

    return res.json({
      hops,
      loginUrl: loginUrl.slice(0, 200),
      settings: settingsParsed,   // Full SETTINGS object from B2C page
      csrfFound: !!csrf, transIdFound: !!transId,
      transIdValue: (transId||'').slice(0, 60),
      step1CookieNames: cookies.map(c => c.split('=')[0]),
      selfAssertedStatus: saRes.status, selfAssertedBody: saText,
      saCookieNames: saCookies.map(c => c.split('=')[0]),
      saCookiesFull: saCookies.map(c => c.slice(0, 200)),
      cookiesSentToConfirmed: cookiesAfterSA.slice(0, 400),
      confirmedUrl: confirmedUrl.slice(0, 200),
      confirmedFinalUrl: cfRes.url?.slice(0, 200),
      confirmedStatus: cfRes.status, confirmedLocation: cfLocation.slice(0, 200),
      originalTransId: transId?.slice(0, 60),
      cfNewTransId: cfTransId?.slice(0, 60),
      transIdsMatch: transId === cfTransId,
      step4bStatus, step4bBody: step4bBody?.slice(0, 300),
      confirmedHtmlLength: cfText.length,
      confirmedSettingsApi: cfText.match(/"api"\s*:\s*"([^"]+)"/)?.[1] || 'not found',
      confirmedSettingsTransId: cfText.match(/"transId"\s*:\s*"([^"]+)"/)?.[1]?.slice(0, 50) || 'not found',
      confirmedHtmlLast300: cfText.slice(-300),
      idTokenFound: !!idToken, codeFound: !!code, formAction: (action || 'none').slice(0, 150),
      acgmeStatus, acgmeCookieCount, acgmeCookieNames,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// Debug: verify a token without needing a DB — helps diagnose JWT_SECRET mismatches
app.post('/debug/verify-token', (req, res) => {
  const { token } = req.body || {};
  if (!token) return res.status(400).json({ error: 'token required' });
  try {
    const jwt = require('jsonwebtoken');
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    res.json({ valid: true, payload: decoded });
  } catch (err) {
    res.status(401).json({ valid: false, error: err.message });
  }
});

app.use(errorHandler);

const PORT = process.env.PORT || 3001;
app.listen(PORT, async () => {
  console.log(`ACGME backend running on port ${PORT}`);
  const dbUrl = process.env.DATABASE_URL || '';
  console.log(`DATABASE_URL configured: ${!!dbUrl} (starts with: ${dbUrl.slice(0, 30) || 'EMPTY'})`);
  console.log(`JWT_SECRET configured: ${!!process.env.JWT_SECRET}`);
  console.log(`NODE_ENV: ${process.env.NODE_ENV}`);
  await migrate();
});
