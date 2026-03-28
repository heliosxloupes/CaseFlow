const fetch = require('node-fetch');
const { URLSearchParams } = require('url');
const AbortController = require('abort-controller');

const BASE_URL = 'https://apps.acgme.org';

const B2C_TENANT   = 'acgmeras.b2clogin.com';
const B2C_POLICY   = 'b2c_1a_signup_signin';
const B2C_CLIENT   = 'dcdddbd1-2b64-4940-9983-6a6442c526aa';
const B2C_REDIRECT = 'https://apps.acgme.org/ads/';
const B2C_BASE     = `https://${B2C_TENANT}/acgmeras.onmicrosoft.com/${B2C_POLICY}`;

const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15';

// ── helpers ──────────────────────────────────────────────────────────────────

function parseCookies(setCookieArray) {
  return setCookieArray.map(c => c.split(';')[0]).join('; ');
}

function mergeSetCookies(existing, newCookies) {
  // Keep a map of name→value, later cookies override earlier ones
  const map = {};
  [...existing, ...newCookies].forEach(c => {
    const part = c.split(';')[0];
    const eq = part.indexOf('=');
    if (eq > 0) map[part.slice(0, eq).trim()] = part;
  });
  return Object.values(map).join('; ');
}

/** Fetch with a hard timeout (ms) */
async function fetchWithTimeout(url, opts, timeoutMs = 15000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } finally {
    clearTimeout(id);
  }
}

// ── Step 1 – Start the OAuth flow ────────────────────────────────────────────

/**
 * Initiates the Azure B2C authorize flow.
 * Returns: { loginUrl, loginHtml, cookies }
 */
async function startB2CFlow() {
  const authorizeUrl = `${B2C_BASE}/oauth2/v2.0/authorize`
    + `?client_id=${B2C_CLIENT}`
    + `&redirect_uri=${encodeURIComponent(B2C_REDIRECT)}`
    + `&response_type=code%20id_token`
    + `&scope=openid%20profile%20offline_access`
    + `&response_mode=form_post`
    + `&nonce=caseflow${Date.now()}`;

  console.log('[B2C] Step 1 – authorize URL:', authorizeUrl.slice(0, 120));

  // Follow redirects manually so we don't chase the final ACGME redirect
  let url = authorizeUrl;
  let cookies = [];
  let html = '';
  let finalUrl = url;

  for (let i = 0; i < 10; i++) {
    const res = await fetchWithTimeout(url, {
      headers: { 'User-Agent': UA, 'Accept': 'text/html', 'Cookie': parseCookies(cookies) },
      redirect: 'manual',
    }, 10000);

    const newCookies = res.headers.raw()['set-cookie'] || [];
    cookies = [...cookies, ...newCookies];

    const location = res.headers.get('location') || '';
    console.log(`[B2C] Step 1 hop ${i}: status=${res.status} location=${location.slice(0, 100)}`);

    if (res.status >= 200 && res.status < 300) {
      html = await res.text();
      finalUrl = url;
      break;
    }

    if (res.status >= 300 && res.status < 400) {
      // Don't follow if it redirects back to the ACGME redirect_uri (end of flow)
      if (location.startsWith(B2C_REDIRECT)) {
        throw new Error('B2C immediately redirected to ACGME without showing login page — unexpected flow.');
      }
      url = location.startsWith('http') ? location : `https://${B2C_TENANT}${location}`;
      continue;
    }

    throw new Error(`B2C authorize step failed with status ${res.status}`);
  }

  if (!html) throw new Error('B2C login page never returned HTML after 10 hops');

  return { loginUrl: finalUrl, loginHtml: html, cookies };
}

// ── Step 2 – Extract CSRF / transId ─────────────────────────────────────────

function extractB2CConfig(html, url) {
  let csrf = null;
  let transId = null;

  // Try SETTINGS JSON block first
  const settingsMatch = html.match(/var\s+SETTINGS\s*=\s*(\{[\s\S]*?\});/i);
  if (settingsMatch) {
    try {
      const s = JSON.parse(settingsMatch[1]);
      csrf = s.csrf || null;
      transId = s.transId || null;
    } catch (_) {}
  }

  // Fallback: inline JSON strings
  if (!csrf)    csrf    = (html.match(/"csrf"\s*:\s*"([^"]+)"/)?.[1]) || null;
  if (!transId) transId = (html.match(/"transId"\s*:\s*"([^"]+)"/)?.[1]) || null;

  // Fallback: URL param tx=
  if (!transId) transId = (url.match(/[?&]tx=([^&]+)/)?.[1]) || null;

  console.log('[B2C] Step 2 – csrf:', csrf ? 'found' : 'MISSING', '| transId:', transId ? 'found' : 'MISSING');
  return { csrf, transId };
}

// ── Step 3 – POST credentials to SelfAsserted ────────────────────────────────

async function postCredentials(username, password, csrf, transId, loginUrl, cookies) {
  const selfAssertedUrl = `${B2C_BASE}/SelfAsserted?tx=${transId || ''}&p=${B2C_POLICY}`;
  console.log('[B2C] Step 3 – POST to SelfAsserted:', selfAssertedUrl.slice(0, 120));

  const body = new URLSearchParams({
    signInName: username,
    password,
    request_type: 'RESPONSE',
  });

  const headers = {
    'Content-Type': 'application/x-www-form-urlencoded',
    'User-Agent': UA,
    'Cookie': parseCookies(cookies),
    'Referer': loginUrl,
    'Origin': `https://${B2C_TENANT}`,
    'X-Requested-With': 'XMLHttpRequest',
  };
  if (csrf) headers['X-CSRF-TOKEN'] = csrf;

  const res = await fetchWithTimeout(selfAssertedUrl, {
    method: 'POST',
    headers,
    body: body.toString(),
    redirect: 'manual',
  }, 15000);

  const newCookies = res.headers.raw()['set-cookie'] || [];
  const allCookies = [...cookies, ...newCookies];
  const resText = await res.text();

  console.log('[B2C] Step 3 – status:', res.status, '| body:', resText.slice(0, 300));

  if (res.status !== 200 && res.status !== 302) {
    throw new Error(`B2C credential POST failed with status ${res.status}`);
  }

  // B2C SelfAsserted returns JSON: {"status":"200"} on success
  try {
    const json = JSON.parse(resText);
    if (json.status && json.status !== '200') {
      throw new Error(`ACGME login rejected: ${json.message || json.status}`);
    }
  } catch (e) {
    if (e.message.startsWith('ACGME login rejected')) throw e;
    // Not JSON — may be a 302 redirect page, continue
  }

  return { allCookies };
}

// ── Step 4 – GET /confirmed to trigger the OIDC redirect ─────────────────────

async function getConfirmedPage(csrf, transId, loginUrl, cookies) {
  const confirmedUrl = `${B2C_BASE}/api/CombinedSigninAndSignup/confirmed`
    + `?rememberMe=false&csrf_token=${encodeURIComponent(csrf || '')}&tx=${transId || ''}&p=${B2C_POLICY}`;

  console.log('[B2C] Step 4 – GET confirmed:', confirmedUrl.slice(0, 120));

  const res = await fetchWithTimeout(confirmedUrl, {
    headers: { 'User-Agent': UA, 'Cookie': parseCookies(cookies), 'Referer': loginUrl },
    redirect: 'manual',
  }, 15000);

  const newCookies = res.headers.raw()['set-cookie'] || [];
  const html = await res.text();
  const location = res.headers.get('location') || '';

  console.log('[B2C] Step 4 – status:', res.status, '| location:', location.slice(0, 100));
  console.log('[B2C] Step 4 – html snippet:', html.slice(0, 400));

  return { html, location, allCookies: [...cookies, ...newCookies] };
}

// ── Step 5 – Post id_token to ACGME ──────────────────────────────────────────

async function postTokenToACGME(html, cookies) {
  const idToken = html.match(/name="id_token"\s+value="([^"]+)"/i)?.[1];
  const code    = html.match(/name="code"\s+value="([^"]+)"/i)?.[1];
  const state   = html.match(/name="state"\s+value="([^"]+)"/i)?.[1];
  const action  = html.match(/<form[^>]+action="([^"]+)"/i)?.[1]?.replace(/&amp;/g, '&');

  if (!idToken && !code) {
    console.log('[B2C] Step 5 – No id_token/code in confirmed page, skipping ACGME POST');
    return parseCookies(cookies);
  }

  const target = action || B2C_REDIRECT;
  console.log('[B2C] Step 5 – POST to ACGME:', target);

  const body = new URLSearchParams();
  if (idToken) body.append('id_token', idToken);
  if (code)    body.append('code', code);
  if (state)   body.append('state', state);

  const res = await fetchWithTimeout(target, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': UA,
      'Cookie': parseCookies(cookies),
    },
    body: body.toString(),
    redirect: 'follow',
  }, 15000);

  const acgmeCookies = res.headers.raw()['set-cookie'] || [];
  console.log('[B2C] Step 5 – ACGME status:', res.status, '| new cookies:', acgmeCookies.length);

  return mergeSetCookies(cookies, acgmeCookies);
}

// ── Main login function ───────────────────────────────────────────────────────

async function loginToACGME(username, password) {
  const { loginUrl, loginHtml, cookies: loginCookies } = await startB2CFlow();
  const { csrf, transId } = extractB2CConfig(loginHtml, loginUrl);

  if (!transId) {
    console.log('[B2C] loginHtml snippet:', loginHtml.slice(0, 800));
    throw new Error('Could not extract B2C transId from login page. ACGME may have changed their login flow.');
  }

  const { allCookies: cookiesAfterCred } = await postCredentials(username, password, csrf, transId, loginUrl, loginCookies);
  const { html: confirmedHtml, location, allCookies: cookiesAfterConfirm } = await getConfirmedPage(csrf, transId, loginUrl, cookiesAfterCred);

  let sessionCookie;
  if (confirmedHtml.includes('id_token') || confirmedHtml.includes('code')) {
    sessionCookie = await postTokenToACGME(confirmedHtml, cookiesAfterConfirm);
  } else if (location && location.startsWith('http')) {
    // Some B2C configs redirect directly
    const followRes = await fetchWithTimeout(location, {
      headers: { 'User-Agent': UA, 'Cookie': parseCookies(cookiesAfterConfirm) },
      redirect: 'follow',
    }, 15000);
    const followCookies = followRes.headers.raw()['set-cookie'] || [];
    sessionCookie = mergeSetCookies(cookiesAfterConfirm, followCookies);
    console.log('[B2C] Followed redirect to:', location.slice(0, 80), '| status:', followRes.status);
  } else {
    sessionCookie = parseCookies(cookiesAfterConfirm);
  }

  if (!sessionCookie.includes('ASP.NET_SessionId') && !sessionCookie.includes('.AspNet')) {
    console.log('[B2C] Final cookies:', sessionCookie.slice(0, 200));
    throw new Error(
      'Login did not produce an ACGME session cookie. ' +
      'If your account requires Duo/MFA, automatic login is not yet supported.'
    );
  }

  return sessionCookie;
}

// ── Step 2: Get Insert page data ─────────────────────────────────────────────

async function getInsertPageData(sessionCookie) {
  const res = await fetchWithTimeout(`${BASE_URL}/ads/CaseLogs/CaseEntryMobile/Insert`, {
    headers: {
      'Cookie': sessionCookie,
      'User-Agent': UA,
      'Accept': 'text/html,application/xhtml+xml',
    },
  }, 15000);

  if (!res.ok) throw new Error(`Failed to load Insert page: ${res.status}`);

  const html = await res.text();

  const tokenMatch = html.match(/name="__RequestVerificationToken"\s+[^>]*value="([^"]+)"/);
  if (!tokenMatch) throw new Error('Could not find request verification token on Insert page');

  const hidden = scrapeHiddenFields(html);
  return { token: tokenMatch[1], hidden };
}

// ── Step 3: Submit a case ─────────────────────────────────────────────────────

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

  const submitRes = await fetchWithTimeout(`${BASE_URL}/ads/CaseLogs/CaseEntryMobile/Insert`, {
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

  if (submitRes.status === 302) {
    const location = submitRes.headers.get('location') || '';
    if (location.includes('Insert') || location.includes('CaseLogs')) {
      return { success: true, message: 'Case submitted successfully' };
    }
  }

  if (submitRes.status === 200) {
    const responseHtml = await submitRes.text();
    if (responseHtml.includes('submitted successfully') || responseHtml.includes('case was submitted')) {
      return { success: true, message: 'Case submitted successfully' };
    }
    const errorMatch = responseHtml.match(/class="[^"]*error[^"]*"[^>]*>([^<]+)</i);
    if (errorMatch) throw new Error(`ACGME error: ${errorMatch[1].trim()}`);
  }

  throw new Error(`Unexpected response status: ${submitRes.status}`);
}

// ── Lookup data ───────────────────────────────────────────────────────────────

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
  const url = `${BASE_URL}${endpoint}${query ? '?' + query : ''}`;

  const res = await fetchWithTimeout(url, {
    headers: {
      'Cookie': sessionCookie,
      'User-Agent': UA,
      'Accept': 'application/json, text/javascript, */*',
      'X-Requested-With': 'XMLHttpRequest',
    },
  }, 15000);

  if (!res.ok) throw new Error(`Lookup failed: ${res.status}`);
  return res.json();
}

// ── HTML helpers ──────────────────────────────────────────────────────────────

function scrapeHiddenFields(html) {
  const fields = {};
  const regex = /<input[^>]+type="hidden"[^>]+name="([^"]+)"[^>]+value="([^"]*)"[^>]*>/gi;
  let match;
  while ((match = regex.exec(html)) !== null) {
    if (match[1] !== '__RequestVerificationToken') {
      fields[match[1]] = match[2];
    }
  }
  return fields;
}

module.exports = { loginToACGME, getInsertPageData, submitCase, getLookupData };
