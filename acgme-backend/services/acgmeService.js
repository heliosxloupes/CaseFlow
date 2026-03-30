const fetch = require('node-fetch');
const { URLSearchParams } = require('url');
const AbortController = require('abort-controller');

const BASE_URL    = 'https://apps.acgme.org';
const B2C_TENANT  = 'acgmeras.b2clogin.com';
const B2C_POLICY  = 'b2c_1a_signup_signin';
const B2C_CLIENT  = 'dcdddbd1-2b64-4940-9983-6a6442c526aa';
const B2C_REDIRECT= 'https://apps.acgme.org/ads/';
const B2C_BASE    = `https://${B2C_TENANT}/acgmeras.onmicrosoft.com/${B2C_POLICY}`;
// Must match Playwright browser UA — ACGME ASP.NET binds sessions to the UA string
const UA          = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

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

  // Decode x-ms-cpim-trans cookie to get the updated transId for subsequent calls
  function decodeTransCookie(cookieStr) {
    try {
      const trans = cookieStr.split('; ').find(c => c.trim().startsWith('x-ms-cpim-trans='));
      if (!trans) return null;
      const b64 = trans.split('=').slice(1).join('=');
      const decoded = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
      const uid = decoded.T_DIC?.[0]?.I;
      if (uid) return 'StateProperties=' + Buffer.from(JSON.stringify({ TID: uid })).toString('base64').replace(/=+$/, '');
      return null;
    } catch (_) { return null; }
  }
  const transIdAfterEmail = decodeTransCookie(cookieHeader(allSetCookies)) || transId;
  console.log(`[B2C] TransId after email: ${transIdAfterEmail !== transId ? 'CHANGED' : 'same'} | ${transIdAfterEmail.slice(0, 50)}`);

  // ── STEP 3b: GET /confirmed using updated transId from trans cookie ──
  const confirmedUrl1 = `${apiBase}/api/${b2cApiType}/confirmed`
    + `?rememberMe=false`
    + `&csrf_token=${encodeURIComponent(csrf || '')}`
    + `&tx=${transIdAfterEmail}`
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

  // Extract api type and csrf from password form page SETTINGS
  let csrf2 = csrf, apiType2 = b2cApiType;
  const cf1Sm = cf1Text.match(/var\s+SETTINGS\s*=\s*(\{[\s\S]*?\});/i);
  if (cf1Sm) {
    try {
      const s = JSON.parse(cf1Sm[1]);
      if (s.csrf) csrf2    = s.csrf;
      if (s.api)  apiType2 = s.api;
    } catch (_) {}
  }
  console.log(`[B2C] Password form: ${cf1Res.status} | apiType2: ${apiType2} | csrf2 changed: ${csrf2 !== csrf}`);

  // ── STEP 4: POST email+password using transIdAfterEmail (from trans cookie) ──
  const sa2Url = `${apiBase}/SelfAsserted?tx=${transIdAfterEmail}&p=${B2C_POLICY}`;
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

  // ── STEP 5: GET second /confirmed using transIdAfterEmail and original csrf ──
  const confirmedUrl2 = `${apiBase}/api/${apiType2}/confirmed`
    + `?rememberMe=false`
    + `&csrf_token=${encodeURIComponent(csrf || '')}`
    + `&tx=${transIdAfterEmail}`
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

/**
 * ASP.NET anti-forgery token — attribute order and quoting vary by page version.
 */
function extractRequestVerificationToken(html) {
  const patterns = [
    // name then value (double quotes)
    /name=["']__RequestVerificationToken["'][^>]*?\bvalue=["']([^"']*)["']/is,
    // value then name
    /\bvalue=["']([^"']+)["'][^>]*name=["']__RequestVerificationToken["']/is,
    // Single-quoted value after name
    /name=["']__RequestVerificationToken["'][^>]*?\bvalue='([^']*)'/is,
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m && m[1] !== undefined && m[1] !== '') return m[1];
  }
  // Broader: any <input> tag that names the token, then grab first value= in that tag block
  const inputRe = /<input\b[^>]*\bname=["']__RequestVerificationToken["'][^>]*>/gi;
  let im;
  while ((im = inputRe.exec(html)) !== null) {
    const tag = im[0];
    const vm = tag.match(/\bvalue=["']([^"']*)["']/i) || tag.match(/\bvalue='([^']*)'/i);
    if (vm && vm[1] !== undefined) return vm[1];
  }
  return null;
}

async function getInsertPageData(sessionCookie) {
  const insertUrl = `${BASE_URL}/ads/CaseLogs/CaseEntryMobile/Insert`;
  const res = await fetchT(insertUrl, {
    headers: {
      Cookie: sessionCookie,
      'User-Agent': UA,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      Referer: `${BASE_URL}/ads/`,
      'Upgrade-Insecure-Requests': '1',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'same-origin',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-User': '?1',
    },
    redirect: 'manual',
  }, 15000);

  // Don't follow cross-site auth redirects — treat as dead session (cookie not accepted)
  if (res.status === 301 || res.status === 302 || res.status === 303 || res.status === 307 || res.status === 308) {
    const loc = res.headers.get('location') || '';
    const authish = /b2clogin|login|microsoftonline|oauth|signin|authorize/i.test(loc);
    throw new Error(
      authish
        ? 'ACGME session expired or not authenticated — open Settings and reconnect your ACGME account.'
        : `ACGME Insert returned redirect ${res.status} to ${loc.slice(0, 160)}`
    );
  }

  if (!res.ok) throw new Error(`Failed to load ACGME Insert page: ${res.status}`);

  const html  = await res.text();
  const token = extractRequestVerificationToken(html);
  if (!token) {
    const looksLikeLogin = /sign\s*in|log\s*in|b2clogin|oauth2/i.test(html);
    throw new Error(
      looksLikeLogin
        ? 'ACGME session expired or not authenticated — open Settings and reconnect your ACGME account.'
        : 'Could not find __RequestVerificationToken on Insert page (ACGME page layout may have changed).'
    );
  }

  return { token, hidden: scrapeHiddenFields(html) };
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
    CaseId:          caseData.caseId || '',
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

// ── User Profile (sites + attendings) ─────────────────────────────────────────

/**
 * Parses <select name="NAME"> (or id="NAME") options from Insert HTML.
 * Handles single/double-quoted value= and labels with nested tags/entities.
 */
function parseSelectOptions(html, selectName) {
  const esc = selectName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const blockRe = new RegExp(
    `<select\\b[^>]*\\b(?:name|id)=["']${esc}["'][^>]*>([\\s\\S]*?)<\\/select>`,
    'i'
  );
  let selectMatch = html.match(blockRe);
  if (!selectMatch) {
    const alt = new RegExp(
      `<select[^>]+(?:id|name)=["']${esc}["'][^>]*>([\\s\\S]*?)<\\/select>`,
      'i'
    );
    selectMatch = html.match(alt);
  }
  if (!selectMatch) return [];

  const inner = selectMatch[1];
  const results = [];
  const optRe = /<option\b([^>]*)>([\s\S]*?)<\/option>/gi;
  let m;
  while ((m = optRe.exec(inner)) !== null) {
    const attrs = m[1];
    let label = m[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    label = label.replace(/&nbsp;/gi, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
    let vm = attrs.match(/\bvalue\s*=\s*(["'])([^"']*)\1/i);
    if (!vm) vm = attrs.match(/\bvalue\s*=\s*([^\s>]+)/i);
    const id = vm ? (vm[2] != null ? vm[2] : vm[1]).trim() : '';
    if (!id) continue;
    results.push({ id, label: label || id });
  }
  return results;
}

/**
 * Fetches the ACGME Insert page and returns program-specific selects as {id, label} arrays.
 * Same GET as getInsertPageData (manual redirect) so profile matches submit auth.
 */
async function getUserProfile(sessionCookie) {
  const insertUrl = `${BASE_URL}/ads/CaseLogs/CaseEntryMobile/Insert`;
  const res = await fetchT(insertUrl, {
    headers: {
      Cookie: sessionCookie,
      'User-Agent': UA,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      Referer: `${BASE_URL}/ads/`,
      'Upgrade-Insecure-Requests': '1',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'same-origin',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-User': '?1',
    },
    redirect: 'manual',
  }, 15000);

  if (res.status === 301 || res.status === 302 || res.status === 303 || res.status === 307 || res.status === 308) {
    const loc = res.headers.get('location') || '';
    const authish = /b2clogin|login|microsoftonline|oauth|signin|authorize/i.test(loc);
    throw new Error(
      authish
        ? 'ACGME session expired or not authenticated — open Settings and reconnect your ACGME account.'
        : `ACGME Insert returned redirect ${res.status} to ${loc.slice(0, 160)}`
    );
  }

  if (!res.ok) throw new Error(`Failed to load ACGME Insert page: ${res.status}`);
  const html = await res.text();

  let sites = parseSelectOptions(html, 'Institutions');
  if (!sites.length) sites = parseSelectOptions(html, 'Institution');
  if (!sites.length) sites = parseSelectOptions(html, 'institutions');
  let attendings = parseSelectOptions(html, 'Attendings');
  if (!attendings.length) attendings = parseSelectOptions(html, 'Attending');
  if (!attendings.length) attendings = parseSelectOptions(html, 'attendings');
  let roles = parseSelectOptions(html, 'ResidentRoles');
  if (!roles.length) roles = parseSelectOptions(html, 'ResidentRole');
  if (!roles.length) roles = parseSelectOptions(html, 'residentRoles');
  let patientTypes = parseSelectOptions(html, 'PatientTypes');
  if (!patientTypes.length) patientTypes = parseSelectOptions(html, 'PatientType');
  if (!patientTypes.length) patientTypes = parseSelectOptions(html, 'patientTypes');

  console.log(
    `[profile] sites: ${sites.length}, attendings: ${attendings.length}, roles: ${roles.length}, patientTypes: ${patientTypes.length}`
  );
  return { sites, attendings, roles, patientTypes };
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
  const inputRe = /<input\b([^>]*?)>/gi;
  let m;
  while ((m = inputRe.exec(html)) !== null) {
    const attrs = m[1];
    if (!/type\s*=\s*["']hidden["']/i.test(attrs)) continue;
    const nameM = attrs.match(/\bname\s*=\s*["']([^"']+)["']/i);
    const valM  = attrs.match(/\bvalue\s*=\s*["']([^"']*)["']/i);
    if (!nameM) continue;
    const name = nameM[1];
    if (name === '__RequestVerificationToken') continue;
    fields[name] = valM ? valM[1] : '';
  }
  return fields;
}

module.exports = { loginToACGME, getInsertPageData, submitCase, getLookupData, getUserProfile };
