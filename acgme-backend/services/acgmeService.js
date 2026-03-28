const fetch = require('node-fetch');
const { URLSearchParams } = require('url');

const BASE_URL = 'https://apps.acgme.org';

// Azure B2C tenant details (extracted from ACGME login redirect)
const B2C_TENANT   = 'acgmeras.b2clogin.com';
const B2C_POLICY   = 'b2c_1a_signup_signin';
const B2C_CLIENT   = 'dcdddbd1-2b64-4940-9983-6a6442c526aa';
const B2C_REDIRECT = 'https://apps.acgme.org/ads/';

/**
 * Step 1: Login to ACGME via Azure B2C and return session cookies.
 *
 * ACGME uses Azure Active Directory B2C (OAuth2/OIDC).
 * Flow: GET login page → extract CSRF token → POST credentials
 *       → follow redirect back to apps.acgme.org → capture session cookie.
 */
async function loginToACGME(username, password) {
  // ── 1. Start the OAuth flow — get the B2C login page ──────────────────────
  const authorizeUrl = `https://${B2C_TENANT}/${B2C_TENANT.split('.')[0]}.onmicrosoft.com/${B2C_POLICY}/oauth2/v2.0/authorize`
    + `?client_id=${B2C_CLIENT}`
    + `&redirect_uri=${encodeURIComponent(B2C_REDIRECT)}`
    + `&response_type=code%20id_token`
    + `&scope=openid%20profile%20offline_access`
    + `&response_mode=form_post`
    + `&nonce=caseflow${Date.now()}`;

  const loginPageRes = await fetch(authorizeUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15',
      'Accept': 'text/html,application/xhtml+xml',
    },
    redirect: 'follow',
  });

  const loginHtml = await loginPageRes.text();
  const loginCookies = loginPageRes.headers.raw()['set-cookie'] || [];
  const loginUrl = loginPageRes.url;

  // ── 2. Extract CSRF token and form POST URL from the B2C login page ────────
  console.log('[ACGME] Login page URL after redirects:', loginUrl);

  // B2C embeds config JSON in a <script> block: var SETTINGS = {...}
  // The csrf field and transId are inside that JSON blob.
  const settingsMatch = loginHtml.match(/var\s+SETTINGS\s*=\s*(\{[\s\S]*?\});/i)
    || loginHtml.match(/var\s+settings\s*=\s*(\{[\s\S]*?\});/i);

  let csrf = null;
  let transId = null;
  if (settingsMatch) {
    try {
      const settings = JSON.parse(settingsMatch[1]);
      csrf = settings.csrf;
      transId = settings.transId;
      console.log('[ACGME] Extracted CSRF from SETTINGS:', csrf ? csrf.slice(0, 10) + '...' : 'none');
    } catch (e) {
      console.log('[ACGME] Could not parse SETTINGS JSON:', e.message);
    }
  }
  // Fallback: hidden input field or inline JSON string
  if (!csrf) {
    const csrfMatch = loginHtml.match(/"csrf"\s*:\s*"([^"]+)"/i)
      || loginHtml.match(/name="RequestVerificationToken"[^>]*value="([^"]+)"/i);
    if (csrfMatch) csrf = csrfMatch[1];
  }

  // Extract transId for the SelfAsserted endpoint URL
  if (!transId) {
    const txMatch = loginUrl.match(/[?&]tx=([^&]+)/);
    if (txMatch) transId = txMatch[1];
  }

  console.log('[ACGME] CSRF:', csrf ? 'found' : 'NOT found');
  console.log('[ACGME] TransId:', transId ? 'found' : 'NOT found');

  // B2C SelfAsserted endpoint
  const tenant = B2C_TENANT.split('.')[0]; // 'acgmeras'
  const selfAssertedUrl = `https://${B2C_TENANT}/${tenant}.onmicrosoft.com/${B2C_POLICY}/SelfAsserted`
    + `?tx=${transId || ''}&p=${B2C_POLICY}`;

  console.log('[ACGME] SelfAsserted URL:', selfAssertedUrl);

  const cookieHeader = parseCookies(loginCookies);

  // ── 3. POST credentials to Azure B2C SelfAsserted endpoint ────────────────
  // B2C requires request_type=RESPONSE and X-CSRF-TOKEN header
  const body = new URLSearchParams({
    signInName: username,
    password: password,
    request_type: 'RESPONSE',
  });

  const credHeaders = {
    'Content-Type': 'application/x-www-form-urlencoded',
    'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15',
    'Cookie': cookieHeader,
    'Referer': loginUrl,
    'Origin': `https://${B2C_TENANT}`,
    'X-Requested-With': 'XMLHttpRequest',
  };
  if (csrf) credHeaders['X-CSRF-TOKEN'] = csrf;

  const credRes = await fetch(selfAssertedUrl, {
    method: 'POST',
    headers: credHeaders,
    body: body.toString(),
    redirect: 'manual',
  });

  const credBody = await credRes.text();
  console.log('[ACGME] SelfAsserted response status:', credRes.status);
  console.log('[ACGME] SelfAsserted response body:', credBody.slice(0, 500));

  const credCookies = credRes.headers.raw()['set-cookie'] || [];
  const allCookies = parseCookies([...loginCookies, ...credCookies]);

  // B2C SelfAsserted returns 200 with JSON {status:'200'} on success, or error JSON
  if (credRes.status !== 200 && credRes.status !== 302) {
    throw new Error(`Azure B2C login failed with status ${credRes.status}. Check your ACGME username and password.`);
  }
  try {
    const credJson = JSON.parse(credBody);
    if (credJson.status && credJson.status !== '200') {
      throw new Error(`ACGME login rejected: ${credJson.message || JSON.stringify(credJson)}`);
    }
  } catch (parseErr) {
    if (parseErr.message.startsWith('ACGME login rejected')) throw parseErr;
    // Non-JSON body — could be a redirect page, continue
  }

  // ── 4. Follow the confirmation redirect to get ACGME session ─────────────
  // After a successful SelfAsserted POST, B2C returns JSON with a
  // status:'200' and we then need to GET the confirmed_url / follow location.
  const location = credRes.headers.get('location') || '';
  if (location.includes('error') || location.includes('AADB2C')) {
    throw new Error('ACGME login rejected by B2C. Check your username and password.');
  }

  // B2C next step: GET the /api/CombinedSigninAndSignup/confirmed endpoint
  const confirmedUrl = `https://${B2C_TENANT}/${tenant}.onmicrosoft.com/${B2C_POLICY}/api/CombinedSigninAndSignup/confirmed`
    + `?rememberMe=false&csrf_token=${encodeURIComponent(csrf || '')}&tx=${transId || ''}&p=${B2C_POLICY}`;

  console.log('[ACGME] Fetching confirmed URL...');
  const confirmedRes = await fetch(confirmedUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15',
      'Cookie': allCookies,
      'Referer': loginUrl,
    },
    redirect: 'follow',
  });

  const confirmedHtml = await confirmedRes.text();
  const confirmedCookies = confirmedRes.headers.raw()['set-cookie'] || [];
  let sessionCookie = parseCookies([...loginCookies, ...credCookies, ...confirmedCookies]);

  console.log('[ACGME] Confirmed URL response status:', confirmedRes.status);
  console.log('[ACGME] Final URL after confirmed:', confirmedRes.url);

  // The confirmed page contains a form that auto-posts id_token to ACGME
  // Extract and follow that form_post
  const idTokenMatch = confirmedHtml.match(/name="id_token"\s+value="([^"]+)"/i);
  const codeMatch = confirmedHtml.match(/name="code"\s+value="([^"]+)"/i);
  const formActionMatch2 = confirmedHtml.match(/<form[^>]+action="([^"]+)"/i);

  if (idTokenMatch || codeMatch) {
    const acgmeFormAction = formActionMatch2
      ? formActionMatch2[1].replace(/&amp;/g, '&')
      : B2C_REDIRECT;
    const tokenBody = new URLSearchParams();
    if (idTokenMatch) tokenBody.append('id_token', idTokenMatch[1]);
    if (codeMatch) tokenBody.append('code', codeMatch[1]);
    const stateInForm = confirmedHtml.match(/name="state"\s+value="([^"]+)"/i);
    if (stateInForm) tokenBody.append('state', stateInForm[1]);

    console.log('[ACGME] Posting id_token to ACGME:', acgmeFormAction);
    const acgmeRes = await fetch(acgmeFormAction, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15',
        'Cookie': sessionCookie,
      },
      body: tokenBody.toString(),
      redirect: 'follow',
    });
    const acgmeCookies = acgmeRes.headers.raw()['set-cookie'] || [];
    sessionCookie = parseCookies([...loginCookies, ...credCookies, ...confirmedCookies, ...acgmeCookies]);
    console.log('[ACGME] ACGME post-login status:', acgmeRes.status);
  } else if (location) {
    const followUrl = location.startsWith('http') ? location : `https://${B2C_TENANT}${location}`;
    const followRes = await fetch(followUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15',
        'Cookie': allCookies,
      },
      redirect: 'follow',
    });
    const followCookies = followRes.headers.raw()['set-cookie'] || [];
    sessionCookie = parseCookies([...loginCookies, ...credCookies, ...followCookies]);
  }

  // ── 5. Confirm we have an ACGME session ────────────────────────────────────
  if (!sessionCookie.includes('ASP.NET_SessionId') && !sessionCookie.includes('.AspNet')) {
    throw new Error(
      'Login did not return an ACGME session. ' +
      'If your account requires Duo MFA, automatic login is not yet supported — ' +
      'see Settings for manual session setup.'
    );
  }

  return sessionCookie;
}

/**
 * Step 2: Get Insert page + scrape anti-forgery token and hidden fields
 */
async function getInsertPageData(sessionCookie) {
  const res = await fetch(`${BASE_URL}/ads/CaseLogs/CaseEntryMobile/Insert`, {
    headers: {
      'Cookie': sessionCookie,
      'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15',
      'Accept': 'text/html,application/xhtml+xml',
    },
  });

  if (!res.ok) throw new Error(`Failed to load Insert page: ${res.status}`);

  const html = await res.text();

  const tokenMatch = html.match(/name="__RequestVerificationToken"\s+[^>]*value="([^"]+)"/);
  if (!tokenMatch) throw new Error('Could not find request verification token on Insert page');

  const hidden = scrapeHiddenFields(html);

  return { token: tokenMatch[1], hidden };
}

/**
 * Step 3: Submit a case to ACGME
 */
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

  const submitRes = await fetch(`${BASE_URL}/ads/CaseLogs/CaseEntryMobile/Insert`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Cookie': sessionCookie,
      'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15',
      'Referer': `${BASE_URL}/ads/CaseLogs/CaseEntryMobile/Insert`,
      'Origin': BASE_URL,
    },
    body: payload,
    redirect: 'manual',
  });

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

/**
 * Fetch dropdown data (roles, codes, patient types, etc.)
 */
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

  const res = await fetch(url, {
    headers: {
      'Cookie': sessionCookie,
      'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15',
      'Accept': 'application/json, text/javascript, */*',
      'X-Requested-With': 'XMLHttpRequest',
    },
  });

  if (!res.ok) throw new Error(`Lookup failed: ${res.status}`);
  return res.json();
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function parseCookies(setCookieArray) {
  return setCookieArray.map(c => c.split(';')[0]).join('; ');
}

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
