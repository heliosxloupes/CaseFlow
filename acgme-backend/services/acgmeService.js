const fetch = require('node-fetch');
const { URLSearchParams } = require('url');

const BASE_URL = 'https://apps.acgme.org';

/**
 * Step 1: Login to ACGME and return session cookies
 */
async function loginToACGME(username, password) {
  const loginPageRes = await fetch(`${BASE_URL}/ads/Account/Login`, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15',
      'Accept': 'text/html,application/xhtml+xml',
    },
    redirect: 'follow',
  });

  const loginHtml = await loginPageRes.text();
  const loginCookies = loginPageRes.headers.raw()['set-cookie'] || [];

  const tokenMatch = loginHtml.match(/name="__RequestVerificationToken"\s+type="hidden"\s+value="([^"]+)"/);
  if (!tokenMatch) throw new Error('Could not find login verification token');

  const loginToken = tokenMatch[1];
  const initialCookie = parseCookies(loginCookies);

  const loginRes = await fetch(`${BASE_URL}/ads/Account/Login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15',
      'Cookie': initialCookie,
      'Referer': `${BASE_URL}/ads/Account/Login`,
    },
    body: new URLSearchParams({
      __RequestVerificationToken: loginToken,
      Username: username,
      Password: password,
      RememberMe: 'false',
    }),
    redirect: 'manual',
  });

  const statusCode = loginRes.status;
  const setCookies = loginRes.headers.raw()['set-cookie'] || [];

  if (statusCode !== 302 && statusCode !== 200) {
    throw new Error(`Login failed with status ${statusCode}`);
  }

  const sessionCookie = parseCookies([...loginCookies, ...setCookies]);

  if (!sessionCookie.includes('ASP.NET_SessionId')) {
    throw new Error('Login failed - no session cookie received. Check your ACGME username and password.');
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
