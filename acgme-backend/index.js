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
    let csrf = null, transId = null, apiBase = B2C_BASE, b2cApiType = 'SelfAsserted';
    const sm = loginHtml.match(/var\s+SETTINGS\s*=\s*(\{[\s\S]*?\});/i);
    if (sm) { try { const s = JSON.parse(sm[1]); csrf = s.csrf; transId = s.transId; if (s.api) b2cApiType = s.api; if (s.hosts?.tenant) apiBase = `https://${B2C_TENANT}${s.hosts.tenant}`; } catch(_){} }
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

    // Step 3a: POST email ONLY first (B2C is a two-step flow: email → password)
    const saUrl = `${apiBase}/SelfAsserted?tx=${transId||''}&p=${B2C_POLICY}`;
    const saHeaders = {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': UA, 'Cookie': mergeCookies(cookies, []),
      'Referer': loginUrl, 'Origin': `https://${B2C_TENANT}`, 'X-Requested-With': 'XMLHttpRequest',
    };
    if (csrf) saHeaders['X-CSRF-TOKEN'] = csrf;
    const saBody = new URLSearchParams({ signInName: username, request_type: 'RESPONSE' });
    const saRes = await ft(saUrl, { method: 'POST', headers: saHeaders, body: saBody.toString(), redirect: 'manual' }, 12000);
    const saText = await saRes.text();
    const saCookies = saRes.headers.raw()['set-cookie'] || [];
    const cookiesAfterSA = mergeCookies(cookies, saCookies);

    // After email POST: decode x-ms-cpim-trans cookie to get the new transId for confirmed calls
    function decodeTransCookie(cookieStr) {
      try {
        const trans = cookieStr.split('; ').find(c => c.trim().startsWith('x-ms-cpim-trans='));
        if (!trans) return null;
        const b64 = trans.split('=').slice(1).join('=');
        const decoded = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
        const uid = decoded.T_DIC?.[0]?.I;
        if (uid) return 'StateProperties=' + Buffer.from(JSON.stringify({ TID: uid })).toString('base64').replace(/=+$/, '');
        return null;
      } catch(_) { return null; }
    }
    const transIdAfterEmail = decodeTransCookie(cookiesAfterSA) || transId;

    // Step 3b: GET confirmed to get the password form using NEW transId from trans cookie
    const confirmedUrl = `${apiBase}/api/${b2cApiType}/confirmed`
      + `?rememberMe=false&csrf_token=${encodeURIComponent(csrf||'')}&tx=${transIdAfterEmail}&p=${B2C_POLICY}`;
    const cfRes = await ft(confirmedUrl, {
      headers: { 'User-Agent': UA, 'Cookie': cookiesAfterSA, 'Referer': loginUrl, 'Accept': 'text/html,application/xhtml+xml' },
      redirect: 'manual',
    }, 15000);
    const cfText = await cfRes.text();
    const cfCookies = cfRes.headers.raw()['set-cookie'] || [];
    const cfLocation = cfRes.headers.get('location') || '';
    const cookiesAfterCF = mergeCookies(cookies, [...saCookies, ...cfCookies]);

    // Extract new SETTINGS from password form page (for csrf, apiType, and transId)
    const cfSettings = cfText.match(/var\s+SETTINGS\s*=\s*(\{[\s\S]*?\});/i);
    let cfTransId = transIdAfterEmail, cfCsrf = csrf, cfApiType = b2cApiType;
    if (cfSettings) { try { const s = JSON.parse(cfSettings[1]); if (s.csrf) cfCsrf = s.csrf; if (s.api) cfApiType = s.api; if (s.transId) cfTransId = s.transId; } catch(_){} }
    // Extract x-ms-cpim-csrf value from cookiesAfterCF to see what value it carries into SA2
    const csrfCookieInCF = cookiesAfterCF.split('; ').find(c => c.trim().startsWith('x-ms-cpim-csrf='));
    const csrfCookieValueAfterCF = csrfCookieInCF ? csrfCookieInCF.split('=').slice(1).join('=') : 'MISSING';

    // Step 4: POST email+password using transId from password form SETTINGS
    let step4bStatus = null, step4bBody = null;
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
    const sa2RawHeaders = sa2Res.headers.raw();
    const cookiesAfterSA2 = mergeCookies(cookiesAfterCF, sa2Cookies);

    // Step 5: GET second confirmed using transId and apiType from password form SETTINGS + cfCsrf
    const transFromCookieAfterSA2 = decodeTransCookie(cookiesAfterSA2) || transIdAfterEmail;
    // cfApiType defaults to b2cApiType if SETTINGS parse failed; use cfApiType (CombinedSigninAndSignup per SETTINGS)
    const cf2ApiTypeToUse = cfApiType || b2cApiType;
    const cf2Url = `${apiBase}/api/${cf2ApiTypeToUse}/confirmed`
      + `?rememberMe=false&csrf_token=${encodeURIComponent(cfCsrf||'')}&tx=${cfTransId}&p=${B2C_POLICY}`;
    const cf2Res = await ft(cf2Url, {
      headers: {
        'User-Agent': UA,
        'Cookie': cookiesAfterSA2,
        'Referer': confirmedUrl,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Origin': `https://${B2C_TENANT}`,
      },
      redirect: 'follow',
    }, 15000);
    const cf2Text = await cf2Res.text();
    const cf2Cookies = cf2Res.headers.raw()['set-cookie'] || [];
    const cf2Location = cf2Res.headers.get('location') || '';
    const cf2RawHeaders = cf2Res.headers.raw();
    const cookiesAfterCF2 = mergeCookies(cookiesAfterSA2, cf2Cookies);

    // Step 6: POST id_token / code to ACGME
    const idToken = cf2Text.match(/name="id_token"\s+value="([^"]+)"/i)?.[1];
    const code    = cf2Text.match(/name="code"\s+value="([^"]+)"/i)?.[1];
    const action  = cf2Text.match(/<form[^>]+action="([^"]+)"/i)?.[1]?.replace(/&amp;/g, '&');
    let acgmeStatus = null, acgmeCookieCount = 0, acgmeCookieNames = [];
    if (idToken || code) {
      const tokenBody = new URLSearchParams();
      if (idToken) tokenBody.append('id_token', idToken);
      if (code) tokenBody.append('code', code);
      const stateM = cf2Text.match(/name="state"\s+value="([^"]+)"/i);
      if (stateM) tokenBody.append('state', stateM[1]);
      const acgmeRes = await ft(action || 'https://apps.acgme.org/ads/', {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA, 'Cookie': cookiesAfterCF2 },
        body: tokenBody.toString(), redirect: 'follow',
      }, 12000);
      const acgmeCookies = acgmeRes.headers.raw()['set-cookie'] || [];
      acgmeStatus = acgmeRes.status;
      acgmeCookieCount = acgmeCookies.length;
      acgmeCookieNames = acgmeCookies.map(c => c.split('=')[0]);
    } else if (cf2Location && cf2Location.startsWith('http')) {
      const followRes = await ft(cf2Location, { headers: { 'User-Agent': UA, 'Cookie': cookiesAfterCF2 }, redirect: 'follow' }, 12000);
      const followCookies = followRes.headers.raw()['set-cookie'] || [];
      acgmeStatus = followRes.status;
      acgmeCookieCount = followCookies.length;
      acgmeCookieNames = followCookies.map(c => c.split('=')[0]);
    }

    // Extract full SETTINGS from initial login page for diagnosis
    let settingsParsed = null;
    const sm2 = loginHtml.match(/var\s+SETTINGS\s*=\s*(\{[\s\S]*?\});/i);
    if (sm2) { try { settingsParsed = JSON.parse(sm2[1]); } catch(_){} }

    return res.json({
      hops,
      loginUrl: loginUrl.slice(0, 200),
      b2cApiType,
      csrfFound: !!csrf, transIdFound: !!transId,
      originalCsrfFirst20: csrf?.slice(0, 20),
      step1CookieNames: cookies.map(c => c.split('=')[0]),
      // Step 3a: Email POST
      emailPostStatus: saRes.status, emailPostBody: saText,
      saCookieNames: saCookies.map(c => c.split('=')[0]),
      // Step 3b: First confirmed (password form page)
      confirmedUrl: confirmedUrl.slice(0, 200),
      confirmedStatus: cfRes.status, confirmedLocation: cfLocation.slice(0, 200),
      confirmedHtmlLength: cfText.length,
      confirmedApiType: cfApiType,
      cfCsrfFirst20: cfCsrf?.slice(0, 20),
      cfCsrfChanged: cfCsrf !== csrf,
      cfSetCookieNames: cfCookies.map(c => c.split('=')[0]),
      csrfCookieValueAfterCFFirst20: csrfCookieValueAfterCF.slice(0, 20),
      csrfCookieMatchesCfCsrf: csrfCookieValueAfterCF === cfCsrf,
      passwordFormFirst2000: cfText.slice(0, 2000),
      passwordFormSettingsRaw: cfText.match(/var\s+SETTINGS\s*=\s*(\{[\s\S]*?\});/i)?.[1]?.slice(0, 800) || 'not found',
      passwordFormHosts: cfText.match(/"hosts"\s*:\s*(\{[^}]+\})/)?.[1] || 'not found',
      // Step 4: Password POST
      pwPostStatus: step4bStatus, pwPostBody: step4bBody?.slice(0, 200),
      sa2CookieNames: sa2Cookies.map(c => c.split('=')[0]),
      // Step 5: Second confirmed (should have id_token)
      transIdAfterEmail: (transIdAfterEmail || '').slice(0, 60),
      cfTransId: (cfTransId || '').slice(0, 80),
      cfTransIdDiffFromAfterEmail: cfTransId !== transIdAfterEmail,
      transFromCookieAfterSA2: (transFromCookieAfterSA2 || '').slice(0, 60),
      sa2TransChanged: transFromCookieAfterSA2 !== transId,
      sa2ResponseHeaders: sa2RawHeaders,
      cf2Url: cf2Url.slice(0, 200),
      cf2Status: cf2Res.status, cf2Location: cf2Location.slice(0, 200),
      cf2RawHeaders,
      cf2HtmlLength: cf2Text.length,
      cf2ApiType: cf2Text.match(/"api"\s*:\s*"([^"]+)"/)?.[1] || 'not found',
      cf2First300: cf2Text.slice(0, 300),
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
