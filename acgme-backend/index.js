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

// Debug: test B2C login step-by-step and return full diagnostic info
app.post('/debug/b2c-login', async (req, res) => {
  const fetch = require('node-fetch');
  const { URLSearchParams } = require('url');
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'username and password required' });

  const B2C_TENANT   = 'acgmeras.b2clogin.com';
  const B2C_POLICY   = 'b2c_1a_signup_signin';
  const B2C_CLIENT   = 'dcdddbd1-2b64-4940-9983-6a6442c526aa';
  const B2C_REDIRECT = 'https://apps.acgme.org/ads/';
  const tenant = B2C_TENANT.split('.')[0];

  try {
    const authorizeUrl = `https://${B2C_TENANT}/${tenant}.onmicrosoft.com/${B2C_POLICY}/oauth2/v2.0/authorize`
      + `?client_id=${B2C_CLIENT}`
      + `&redirect_uri=${encodeURIComponent(B2C_REDIRECT)}`
      + `&response_type=code%20id_token`
      + `&scope=openid%20profile%20offline_access`
      + `&response_mode=form_post`
      + `&nonce=caseflow${Date.now()}`;

    const loginPageRes = await fetch(authorizeUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15', 'Accept': 'text/html' },
      redirect: 'follow',
    });
    const loginHtml = await loginPageRes.text();
    const loginCookies = loginPageRes.headers.raw()['set-cookie'] || [];
    const loginUrl = loginPageRes.url;

    // Extract SETTINGS JSON
    const settingsMatch = loginHtml.match(/var\s+SETTINGS\s*=\s*(\{[\s\S]*?\});/i);
    let settings = null;
    try { if (settingsMatch) settings = JSON.parse(settingsMatch[1]); } catch(e) {}

    const csrf = settings?.csrf || (loginHtml.match(/"csrf"\s*:\s*"([^"]+)"/)?.[1]);
    const transId = settings?.transId || (loginUrl.match(/[?&]tx=([^&]+)/)?.[1]);

    // POST to SelfAsserted
    const selfAssertedUrl = `https://${B2C_TENANT}/${tenant}.onmicrosoft.com/${B2C_POLICY}/SelfAsserted`
      + `?tx=${transId || ''}&p=${B2C_POLICY}`;

    const cookieHeader = loginCookies.map(c => c.split(';')[0]).join('; ');
    const credHeaders = {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15',
      'Cookie': cookieHeader,
      'Referer': loginUrl,
      'Origin': `https://${B2C_TENANT}`,
      'X-Requested-With': 'XMLHttpRequest',
    };
    if (csrf) credHeaders['X-CSRF-TOKEN'] = csrf;

    const body = new URLSearchParams({ signInName: username, password, request_type: 'RESPONSE' });
    const credRes = await fetch(selfAssertedUrl, { method: 'POST', headers: credHeaders, body: body.toString(), redirect: 'manual' });
    const credBody = await credRes.text();

    return res.json({
      loginUrl,
      loginHtmlSnippet: loginHtml.slice(0, 800),
      settingsFound: !!settings,
      csrfFound: !!csrf,
      transIdFound: !!transId,
      selfAssertedUrl,
      selfAssertedStatus: credRes.status,
      selfAssertedBody: credBody.slice(0, 500),
      loginCookieCount: loginCookies.length,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message, stack: err.stack });
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
