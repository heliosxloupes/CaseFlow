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
  console.log('[ACGME] Login page HTML (first 1000 chars):', loginHtml.slice(0, 1000));

  const csrfMatch = loginHtml.match(/name="RequestVerificationToken"[^>]*value="([^"]+)"/i)
    || loginHtml.match(/"csrf":"([^"]+)"/);
  const stateMatch = loginHtml.match(/name="state"[^>]*value="([^"]+)"/i)
    || loginHtml.match(/"StateProperties=([^"&]+)"/);

  // B2C posts the self-submit form to a URL embedded in the page
  // The action may be relative — resolve it against the B2C tenant base
  const formActionMatch = loginHtml.match(/<form[^>]+action="([^"]+)"/i);
  let formAction;
  if (formActionMatch) {
    const raw = formActionMatch[1].replace(/&amp;/g, '&');
    if (raw.startsWith('http')) {
      formAction = raw;
    } else if (raw.startsWith('/')) {
      formAction = `https://${B2C_TENANT}${raw}`;
    } else {
      formAction = `https://${B2C_TENANT}/${raw}`;
    }
  } else {
    // Fallback: try the SelfAsserted endpoint extracted from the login URL
    const txMatch = loginUrl.match(/[?&]tx=([^&]+)/);
    if (txMatch) {
      formAction = `https://${B2C_TENANT}/${B2C_TENANT.split('.')[0]}.onmicrosoft.com/${B2C_POLICY}/SelfAsserted?tx=${txMatch[1]}&p=${B2C_POLICY}`;
    } else {
      formAction = loginUrl;
    }
  }
  console.log('[ACGME] Form action URL:', formAction);

  const cookieHeader = parseCookies(loginCookies);

  // ── 3. POST credentials to Azure B2C ──────────────────────────────────────
  const body = new URLSearchParams({
    signInName: username,
    password: password,
  });
  if (csrfMatch) body.append('RequestVerificationToken', csrfMatch[1]);
  if (stateMatch) body.append('StateProperties', stateMatch[1]);

  const credRes = await fetch(formAction, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15',
      'Cookie': cookieHeader,
      'Referer': loginUrl,
      'Origin': `https://${B2C_TENANT}`,
    },
    body: body.toString(),
    redirect: 'manual',
  });

  const credCookies = credRes.headers.raw()['set-cookie'] || [];
  const allCookies = parseCookies([...loginCookies, ...credCookies]);

  // 302 or 200 with redirect = B2C accepted the credentials
  if (credRes.status !== 302 && credRes.status !== 200) {
    throw new Error(`Azure B2C login failed with status ${credRes.status}. Check your ACGME username and password.`);
  }

  // ── 4. Follow the redirect chain back to apps.acgme.org ───────────────────
  // B2C sends an id_token via form_post back to the redirect_uri
  const location = credRes.headers.get('location') || '';
  if (location.includes('error') || location.includes('AADB2C')) {
    throw new Error('ACGME login rejected. Check your username and password.');
  }

  // If B2C returns a form-post with id_token, fetch the next page
  let sessionCookie = allCookies;
  if (location) {
    const followRes = await fetch(location.startsWith('http') ? location : `https://${B2C_TENANT}${location}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15',
        'Cookie': allCookies,
      },
      redirect: 'manual',
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
