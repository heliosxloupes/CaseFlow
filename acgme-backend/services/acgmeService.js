const fetch = require('node-fetch');
const { URLSearchParams } = require('url');
const AbortController = require('abort-controller');

const BASE_URL    = 'https://apps.acgme.org';
const B2C_TENANT  = 'acgmeras.b2clogin.com';
const B2C_POLICY  = 'b2c_1a_signup_signin';
const B2C_CLIENT  = 'dcdddbd1-2b64-4940-9983-6a6442c526aa';
const B2C_REDIRECT= 'https://apps.acgme.org/ads/';
const B2C_BASE    = `https://${B2C_TENANT}/acgmeras.onmicrosoft.com/${B2C_POLICY}`;
const UA          = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Merge arrays of Set-Cookie strings; later entries override earlier by name */
function mergeCookies(...arrays) {
  const map = {};
  [].concat(...arrays).forEach(c => {
    const pair = c.split(';')[0];
    const eq   = pair.indexOf('=');
    if (eq > 0) map[pair.slice(0, eq).trim()] = pair;
  });
  return Object.values(map).join('; ');
}

/** Build Cookie header string from an array of Set-Cookie strings */
function cookieHeader(arr) {
  return mergeCookies(arr);
}

async function fetchT(url, opts, ms = 15000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

// ── B2C Login Flow ────────────────────────────────────────────────────────────

async function loginToACGME(username, password) {
  // ── STEP 1: GET authorize page (manual redirects to avoid following back to ACGME) ──
  const authorizeUrl = `${B2C_BASE}/oauth2/v2.0/authorize`
    + `?client_id=${B2C_CLIENT}`
    + `&redirect_uri=${encodeURIComponent(B2C_REDIRECT)}`
    + `&response_type=code%20id_token`
    + `&scope=openid%20profile%20offline_access`
    + `&response_mode=form_post`
    + `&nonce=cf${Date.now()}`;

  let url = authorizeUrl;
  let allSetCookies = [];
  let loginHtml = '';
  let loginUrl = '';

  for (let hop = 0; hop < 10; hop++) {
    const r = await fetchT(url, {
      headers: { 'User-Agent': UA, 'Accept': 'text/html', 'Cookie': cookieHeader(allSetCookies) },
      redirect: 'manual',
    }, 12000);

    const sc = r.headers.raw()['set-cookie'] || [];
    allSetCookies = allSetCookies.concat(sc);

    const loc = r.headers.get('location') || '';
    console.log(`[B2C] Hop ${hop}: ${r.status} → ${loc.slice(0, 80) || '(no redirect)'}`);

    if (r.status >= 200 && r.status < 300) {
      loginHtml = await r.text();
      loginUrl  = url;
      break;
    }

    if (r.status >= 300 && r.status < 400) {
      if (loc.startsWith(B2C_REDIRECT)) {
        throw new Error('B2C redirected to ACGME without showing login page — unexpected flow.');
      }
      url = loc.startsWith('http') ? loc : `https://${B2C_TENANT}${loc}`;
      continue;
    }

    throw new Error(`B2C authorize failed at hop ${hop} with status ${r.status}`);
  }

  if (!loginHtml) throw new Error('B2C never returned the login page HTML');

  // ── STEP 2: Extract CSRF, transId, and API base from SETTINGS ──
  let csrf = null, transId = null, apiBase = B2C_BASE, b2cApiType = 'SelfAsserted';

  const sm = loginHtml.match(/var\s+SETTINGS\s*=\s*(\{[\s\S]*?\});/i);
  if (sm) {
    try {
      const s = JSON.parse(sm[1]);
      csrf    = s.csrf    || null;
      transId = s.transId || null;
      if (s.api) b2cApiType = s.api;
      if (s.hosts?.tenant) {
        apiBase = `https://${B2C_TENANT}${s.hosts.tenant}`;
      }
    } catch (_) {}
  }
  if (!csrf)    csrf    = loginHtml.match(/"csrf"\s*:\s*"([^"]+)"/)?.[1]    || null;
  if (!transId) transId = loginHtml.match(/"transId"\s*:\s*"([^"]+)"/)?.[1] || loginUrl.match(/[?&]tx=([^&]+)/)?.[1] || null;

  console.log(`[B2C] CSRF: ${csrf ? 'found' : 'MISSING'} | transId: ${transId ? 'found' : 'MISSING'} | apiBase: ${apiBase} | apiType: ${b2cApiType}`);

  if (!transId) {
    throw new Error('Could not extract B2C transId. ACGME login flow may have changed.');
  }

  // ── STEP 3a: POST email ONLY (B2C two-step: email first, then password) ──
  const selfAssertedUrl = `${apiBase}/SelfAsserted?tx=${transId}&p=${B2C_POLICY}`;
  const saHeaders = {
    'Content-Type': 'application/x-www-form-urlencoded',
    'User-Agent': UA,
    'Cookie': cookieHeader(allSetCookies),
    'Referer': loginUrl,
    'Origin': `https://${B2C_TENANT}`,
    'X-Requested-With': 'XMLHttpRequest',
  };
  if (csrf) saHeaders['X-CSRF-TOKEN'] = csrf;

  const saBody = new URLSearchParams({ signInName: username, request_type: 'RESPONSE' });
  const saRes  = await fetchT(selfAssertedUrl, { method: 'POST', headers: saHeaders, body: saBody.toString(), redirect: 'manual' }, 15000);
  const saText = await saRes.text();
  const saSetCookies = saRes.headers.raw()['set-cookie'] || [];
  allSetCookies = allSetCookies.concat(saSetCookies);

  console.log(`[B2C] Email POST: ${saRes.status} | body: ${saText.slice(0, 150)}`);
  if (saRes.status !== 200 && saRes.status !== 302) {
    throw new Error(`B2C email step failed with status ${saRes.status}`);
  }

  // ── STEP 3b: GET /confirmed → returns password form with new SETTINGS ──
  const confirmedUrl1 = `${apiBase}/api/${b2cApiType}/confirmed`
    + `?rememberMe=false`
    + `&csrf_token=${encodeURIComponent(csrf || '')}`
    + `&tx=${transId}`
    + `&p=${B2C_POLICY}`;

  const cf1Res = await fetchT(confirmedUrl1, {
    headers: {
      'User-Agent': UA,
      'Cookie': cookieHeader(allSetCookies),
      'Referer': loginUrl,
      'Accept': 'text/html,application/xhtml+xml',
    },
    redirect: 'manual',
  }, 15000);

  const cf1Text = await cf1Res.text();
  const cf1SetCookies = cf1Res.headers.raw()['set-cookie'] || [];
  allSetCookies = allSetCookies.concat(cf1SetCookies);

  // Extract new SETTINGS from password form page
  let csrf2 = csrf, transId2 = transId, apiType2 = b2cApiType;
  const cf1Sm = cf1Text.match(/var\s+SETTINGS\s*=\s*(\{[\s\S]*?\});/i);
  if (cf1Sm) {
    try {
      const s = JSON.parse(cf1Sm[1]);
      if (s.csrf)    csrf2    = s.csrf;
      if (s.transId) transId2 = s.transId;
      if (s.api)     apiType2 = s.api;
    } catch (_) {}
  }
  console.log(`[B2C] Password form: ${cf1Res.status} | apiType2: ${apiType2} | csrf2 changed: ${csrf2 !== csrf} | transId2 changed: ${transId2 !== transId}`);

  // ── STEP 4: POST email+password using credentials from password page ──
  const sa2Url = `${apiBase}/SelfAsserted?tx=${transId2}&p=${B2C_POLICY}`;
  const sa2Headers = {
    'Content-Type': 'application/x-www-form-urlencoded',
    'User-Agent': UA,
    'Cookie': cookieHeader(allSetCookies),
    'Referer': confirmedUrl1,
    'Origin': `https://${B2C_TENANT}`,
    'X-Requested-With': 'XMLHttpRequest',
  };
  if (csrf2) sa2Headers['X-CSRF-TOKEN'] = csrf2;

  const sa2Body = new URLSearchParams({ signInName: username, password, request_type: 'RESPONSE' });
  const sa2Res  = await fetchT(sa2Url, { method: 'POST', headers: sa2Headers, body: sa2Body.toString(), redirect: 'manual' }, 15000);
  const sa2Text = await sa2Res.text();
  const sa2SetCookies = sa2Res.headers.raw()['set-cookie'] || [];
  allSetCookies = allSetCookies.concat(sa2SetCookies);

  console.log(`[B2C] Password POST: ${sa2Res.status} | body: ${sa2Text.slice(0, 150)}`);
  try {
    const saJson = JSON.parse(sa2Text);
    if (saJson.status && saJson.status !== '200') {
      throw new Error(`ACGME credentials rejected: ${saJson.message || saJson.status}`);
    }
  } catch (e) {
    if (e.message.startsWith('ACGME credentials rejected')) throw e;
  }
  if (sa2Res.status !== 200 && sa2Res.status !== 302) {
    throw new Error(`B2C password step failed with status ${sa2Res.status}`);
  }

  // ── STEP 5: GET second /confirmed → should have id_token form or redirect ──
  const confirmedUrl2 = `${apiBase}/api/${apiType2}/confirmed`
    + `?rememberMe=false`
    + `&csrf_token=${encodeURIComponent(csrf2 || '')}`
    + `&tx=${transId2}`
    + `&p=${B2C_POLICY}`;

  const cfRes = await fetchT(confirmedUrl2, {
    headers: {
      'User-Agent': UA,
      'Cookie': cookieHeader(allSetCookies),
      'Referer': confirmedUrl1,
      'Accept': 'text/html,application/xhtml+xml',
    },
    redirect: 'manual',
  }, 15000);

  const cfText    = await cfRes.text();
  const cfSetCookies = cfRes.headers.raw()['set-cookie'] || [];
  const cfLocation   = cfRes.headers.get('location') || '';
  allSetCookies = allSetCookies.concat(cfSetCookies);

  console.log(`[B2C] Final confirmed: ${cfRes.status} | location: ${cfLocation.slice(0, 100)}`);
  console.log(`[B2C] Final confirmed HTML snippet: ${cfText.slice(0, 300)}`);

  // ── STEP 6: POST id_token / code to ACGME ──
  const idToken = cfText.match(/name="id_token"\s+value="([^"]+)"/i)?.[1];
  const code    = cfText.match(/name="code"\s+value="([^"]+)"/i)?.[1];
  const state   = cfText.match(/name="state"\s+value="([^"]+)"/i)?.[1];
  const action  = cfText.match(/<form[^>]+action="([^"]+)"/i)?.[1]?.replace(/&amp;/g, '&') || B2C_REDIRECT;

  let sessionCookie = cookieHeader(allSetCookies);

  if (idToken || code) {
    const tokenBody = new URLSearchParams();
    if (idToken) tokenBody.append('id_token', idToken);
    if (code)    tokenBody.append('code', code);
    if (state)   tokenBody.append('state', state);

    console.log(`[B2C] Posting token to ACGME: ${action}`);
    const acgmeRes = await fetchT(action, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': UA,
        'Cookie': cookieHeader(allSetCookies),
      },
      body: tokenBody.toString(),
      redirect: 'follow',
    }, 15000);

    const acgmeSetCookies = acgmeRes.headers.raw()['set-cookie'] || [];
    allSetCookies = allSetCookies.concat(acgmeSetCookies);
    sessionCookie = cookieHeader(allSetCookies);
    console.log(`[B2C] ACGME POST status: ${acgmeRes.status} | cookies: [${acgmeSetCookies.map(c => c.split('=')[0]).join(', ')}]`);
  } else if (cfLocation && cfLocation.startsWith('http')) {
    console.log(`[B2C] Following redirect: ${cfLocation.slice(0, 100)}`);
    const followRes = await fetchT(cfLocation, {
      headers: { 'User-Agent': UA, 'Cookie': cookieHeader(allSetCookies) },
      redirect: 'follow',
    }, 15000);
    const followSetCookies = followRes.headers.raw()['set-cookie'] || [];
    allSetCookies = allSetCookies.concat(followSetCookies);
    sessionCookie = cookieHeader(allSetCookies);
  }

  console.log(`[B2C] Final cookie keys: ${cookieHeader(allSetCookies).split('; ').map(p => p.split('=')[0]).join(', ')}`);

  if (!sessionCookie.includes('ASP.NET_SessionId') && !sessionCookie.includes('.AspNet')) {
    throw new Error(
      'Login succeeded in B2C but no ACGME session cookie was returned. ' +
      'If your account requires Duo/MFA, automatic submission is not yet supported.'
    );
  }

  return sessionCookie;
}

// ── Case Submission ───────────────────────────────────────────────────────────

async function getInsertPageData(sessionCookie) {
  const res = await fetchT(`${BASE_URL}/ads/CaseLogs/CaseEntryMobile/Insert`, {
    headers: { 'Cookie': sessionCookie, 'User-Agent': UA, 'Accept': 'text/html' },
  }, 15000);

  if (!res.ok) throw new Error(`Failed to load ACGME Insert page: ${res.status}`);

  const html       = await res.text();
  const tokenMatch = html.match(/name="__RequestVerificationToken"\s+[^>]*value="([^"]+)"/);
  if (!tokenMatch) throw new Error('Could not find __RequestVerificationToken on Insert page');

  return { token: tokenMatch[1], hidden: scrapeHiddenFields(html) };
}

async function submitCase(sessionCookie, caseData) {
  const { token, hidden } = await getInsertPageData(sessionCookie);

  const payload = new URLSearchParams({
    __RequestVerificationToken: token,
    ...hidden,
    ProcedureDate:   caseData.procedureDate,
    ProcedureYear:   caseData.procedureYear,
    ResidentRoles:   caseData.residentRoleId,
    Institutions:    caseData.institutionId,
    Attendings:      caseData.attendingId,
    PatientTypes:    caseData.patientTypeId,
    SelectedCodes:   caseData.selectedCodes,
    CodeDescription: caseData.codeDescription || '',
    Comments:        caseData.comments || '',
    IsMobileApp:     'True',
    MobileViewMode:  '0',
    SearchTerm:      'False',
  });

  const res = await fetchT(`${BASE_URL}/ads/CaseLogs/CaseEntryMobile/Insert`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Cookie': sessionCookie,
      'User-Agent': UA,
      'Referer': `${BASE_URL}/ads/CaseLogs/CaseEntryMobile/Insert`,
      'Origin': BASE_URL,
    },
    body: payload,
    redirect: 'manual',
  }, 15000);

  if (res.status === 302) {
    const loc = res.headers.get('location') || '';
    if (loc.includes('Insert') || loc.includes('CaseLogs')) {
      return { success: true, message: 'Case submitted successfully' };
    }
  }
  if (res.status === 200) {
    const html = await res.text();
    if (html.includes('submitted successfully') || html.includes('case was submitted')) {
      return { success: true, message: 'Case submitted successfully' };
    }
    const err = html.match(/class="[^"]*error[^"]*"[^>]*>([^<]+)</i);
    if (err) throw new Error(`ACGME error: ${err[1].trim()}`);
  }
  throw new Error(`Unexpected submission response: ${res.status}`);
}

async function getLookupData(sessionCookie, type, params = {}) {
  const endpoints = {
    cptCodes:  '/ads/CaseLogs/CaseEntryMobile/GetCptTypeToAreaInfosBySpecialtyActiveDate',
    types:     '/ads/CaseLogs/CaseEntryMobile/GetTypesBySpecialtyIdOrRRClassId',
    roles:     '/ads/CaseLogs/CaseEntryMobile/GetResidentRoles',
    codes:     '/ads/CaseLogs/CaseEntryMobile/GetCodes',
    caseCount: '/ads/CaseLogs/CaseEntryMobile/GetProcedureCaseCount',
  };
  const endpoint = endpoints[type];
  if (!endpoint) throw new Error(`Unknown lookup type: ${type}`);
  const query = new URLSearchParams(params).toString();
  const url   = `${BASE_URL}${endpoint}${query ? '?' + query : ''}`;
  const res   = await fetchT(url, {
    headers: { 'Cookie': sessionCookie, 'User-Agent': UA, 'Accept': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
  }, 15000);
  if (!res.ok) throw new Error(`Lookup failed: ${res.status}`);
  return res.json();
}

function scrapeHiddenFields(html) {
  const fields = {};
  const regex  = /<input[^>]+type="hidden"[^>]+name="([^"]+)"[^>]+value="([^"]*)"[^>]*>/gi;
  let match;
  while ((match = regex.exec(html)) !== null) {
    if (match[1] !== '__RequestVerificationToken') fields[match[1]] = match[2];
  }
  return fields;
}

module.exports = { loginToACGME, getInsertPageData, submitCase, getLookupData };
