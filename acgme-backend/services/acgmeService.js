const crypto = require('crypto');
const fetch = require('node-fetch');
const { URLSearchParams } = require('url');
const AbortController = require('abort-controller');

const BASE_URL    = 'https://apps.acgme.org';
/** Desktop “Add Cases” form — matches DevTools HAR; Mobile Insert uses different model binding. */
const ACGME_INSERT_URL = `${BASE_URL}/ads/CaseLogs/CaseEntry/Insert`;
const B2C_TENANT  = 'acgmeras.b2clogin.com';
const B2C_POLICY  = 'b2c_1a_signup_signin';
const B2C_CLIENT  = 'dcdddbd1-2b64-4940-9983-6a6442c526aa';
const B2C_REDIRECT= 'https://apps.acgme.org/ads/';
const B2C_BASE    = `https://${B2C_TENANT}/acgmeras.onmicrosoft.com/${B2C_POLICY}`;
// Must match Playwright browser UA — ACGME ASP.NET binds sessions to the UA string
const UA          = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/** ADS Insert Case ID field uses bootstrap-maxlength (25) on the resident form — keep POST length aligned. */
const ADS_CASE_ID_MAX_LEN = 25;

/**
 * Whether to include CaseId in the Insert POST.
 * Any non-empty CaseId should be posted to ADS unless explicitly disabled by env.
 * ACGME_POST_CASE_ID=never|0|false|off → never post CaseId; Comments only.
 */
function shouldPostCaseIdToAds(raw) {
  const env = String(process.env.ACGME_POST_CASE_ID || '').trim().toLowerCase();
  if (env === '0' || env === 'false' || env === 'off' || env === 'never') return false;
  const s = String(raw || '').trim();
  return !!s;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Merge arrays of Set-Cookie strings; later entries override earlier by name */
function mergeCookies(...arrays) {
  const map = {};
  const flat = []
    .concat(...arrays)
    .filter(c => c != null && c !== '')
    .map(c => (typeof c === 'string' ? c : String(c)));
  flat.forEach((c) => {
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
  if (!html || typeof html !== 'string') return null;
  let h = html;
  if (h.charCodeAt(0) === 0xfeff) h = h.slice(1);

  const patterns = [
    // Some layouts expose the token only in a meta tag
    /<meta\s+name=["']__RequestVerificationToken["']\s+content=["']([^"']+)["']/is,
    // name then value (double quotes)
    /name=["']__RequestVerificationToken["'][^>]*?\bvalue=["']([^"']*)["']/is,
    // value then name (common on mobile views)
    /\bvalue=["']([^"']+)["'][^>]*name=["']__RequestVerificationToken["']/is,
    // Single-quoted value after name
    /name=["']__RequestVerificationToken["'][^>]*?\bvalue='([^']*)'/is,
    // Unquoted name (HTML5)
    /name\s*=\s*__RequestVerificationToken\b[^>]*\bvalue\s*=\s*["']([^"']*)["']/is,
    // Hidden input: type before name
    /<input[^>]*\btype\s*=\s*["']hidden["'][^>]*\bname\s*=\s*["']__RequestVerificationToken["'][^>]*\bvalue\s*=\s*["']([^"']*)["']/is,
    /<input[^>]*\bname\s*=\s*["']__RequestVerificationToken["'][^>]*\btype\s*=\s*["']hidden["'][^>]*\bvalue\s*=\s*["']([^"']*)["']/is,
    // ASP.NET Core alternate token name
    /name=["']RequestVerificationToken["'][^>]*?\bvalue=["']([^"']+)["']/is,
  ];
  for (const re of patterns) {
    const m = h.match(re);
    if (m && m[1] !== undefined && String(m[1]).trim() !== '') return m[1].trim();
  }
  // Broader: full <input> tag scan (multiline-safe within tag)
  const inputRe = /<input\b[^>]*\bname\s*=\s*["']__RequestVerificationToken["'][^>]*>/gi;
  let im;
  while ((im = inputRe.exec(h)) !== null) {
    const tag = im[0];
    const vm = tag.match(/\bvalue\s*=\s*["']([^"']*)["']/i) || tag.match(/\bvalue\s*=\s*([^\s>]+)/i);
    if (vm && vm[1] !== undefined && String(vm[1]).trim() !== '') return vm[1].trim();
  }
  // Last resort: window around the marker (handles odd minification / attribute order)
  const marker = '__RequestVerificationToken';
  let pos = 0;
  while ((pos = h.indexOf(marker, pos)) !== -1) {
    const slice = h.slice(Math.max(0, pos - 120), pos + 500);
    const vm = slice.match(/value\s*=\s*["']([^"']+)["']/i);
    if (vm && vm[1] && vm[1].length > 4) return vm[1].trim();
    pos += marker.length;
  }
  return null;
}

function looksLikeLoginHtml(html) {
  return /sign\s*in|log\s*on|b2clogin|oauth2\/v2\.0\/authorize/i.test(html);
}

/** Merge existing Cookie header with Set-Cookie lines from a response (name=value only). */
function mergeCookieHeaderWithSetCookies(cookieHeader, setCookieArray) {
  if (!setCookieArray || !setCookieArray.length) return cookieHeader || '';
  const existing = cookieHeader
    ? cookieHeader.split(';').map(s => s.trim()).filter(s => s.includes('='))
    : [];
  // mergeCookies expects parallel arrays of string lines — do NOT wrap `existing` in an extra
  // array or [].concat flattens to one element that is still an array → c.split is not a function.
  const lines = Array.isArray(setCookieArray) ? setCookieArray : [setCookieArray];
  return mergeCookies(existing, lines);
}

function resolveRedirectUrl(location, currentUrl) {
  if (!location) return '';
  const trimmed = location.trim();
  if (trimmed.startsWith('http')) return trimmed;
  return new URL(trimmed, currentUrl).href;
}

/**
 * GET Case Entry Insert with same-origin redirect handling.
 * ACGME often responds 302 → /ads/ with Set-Cookie before the app session is bound; node-fetch
 * with redirect:manual used to treat that as failure. Follow apps.acgme.org hops and merge cookies.
 */
async function fetchInsertHtmlWithRedirects(initialCookie) {
  const insertUrl = ACGME_INSERT_URL;
  let url = insertUrl;
  let cookieHdr = initialCookie || '';
  let referer = `${BASE_URL}/ads/`;
  /** One-time GET /ads/ when Insert returns 200 without a parseable token (session stitch). */
  let triedAdsWarmup = false;

  const baseHeaders = {
    'User-Agent': UA,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Upgrade-Insecure-Requests': '1',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'same-origin',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-User': '?1',
  };

  for (let hop = 0; hop < 12; hop++) {
    const res = await fetchT(
      url,
      {
        headers: {
          ...baseHeaders,
          Cookie: cookieHdr,
          Referer: referer,
        },
        redirect: 'manual',
      },
      20000
    );

    const sc = res.headers.raw()['set-cookie'] || [];
    if (sc.length) {
      cookieHdr = mergeCookieHeaderWithSetCookies(cookieHdr, sc);
    }

    if (res.status === 301 || res.status === 302 || res.status === 303 || res.status === 307 || res.status === 308) {
      const loc = res.headers.get('location') || '';
      const abs = resolveRedirectUrl(loc, url);
      if (!abs) {
        throw new Error(`ACGME Insert redirect with empty Location (hop ${hop})`);
      }
      if (/b2clogin|microsoftonline|oauth|signin|authorize|login\.microsoft/i.test(abs)) {
        throw new Error(
          'ACGME session expired or not authenticated — open Settings and reconnect your ACGME account.'
        );
      }
      if (!abs.includes('apps.acgme.org')) {
        throw new Error(`ACGME Insert returned cross-origin redirect to ${abs.slice(0, 160)}`);
      }
      referer = url;
      url = abs;
      continue;
    }

    if (!res.ok) {
      throw new Error(`Failed to load ACGME Insert page: ${res.status}`);
    }

    const html = await res.text();
    if (extractRequestVerificationToken(html)) {
      return { html, cookieHeader: cookieHdr };
    }
    if (looksLikeLoginHtml(html)) {
      throw new Error(
        'ACGME session expired or not authenticated — open Settings and reconnect your ACGME account.'
      );
    }
    // e.g. 200 on /ads/ shell — retry Insert with cookies we just collected
    if (!url.includes('CaseEntry/Insert')) {
      referer = url;
      url = insertUrl;
      continue;
    }

    // Insert URL returned 200 but no antiforgery token in HTML — load /ads/ once then retry Insert
    if (url.includes('CaseEntry/Insert') && !triedAdsWarmup) {
      triedAdsWarmup = true;
      referer = url;
      url = `${BASE_URL}/ads/`;
      continue;
    }

    const title = html.match(/<title[^>]*>([^<]{0,120})/i);
    console.warn(
      `[ACGME] Insert probe: no token — hop=${hop} len=${html.length} ` +
        `title=${title && title[1] ? title[1].trim().slice(0, 80) : 'n/a'} ` +
        `hasMarker=${html.includes('__RequestVerificationToken')}`
    );

    throw new Error(
      'Could not find __RequestVerificationToken on Insert page (ACGME page layout may have changed).'
    );
  }

  throw new Error('Too many redirects loading ACGME Insert page');
}

async function getInsertPageData(sessionCookie) {
  const { html, cookieHeader } = await fetchInsertHtmlWithRedirects(sessionCookie);
  const token = extractRequestVerificationToken(html);
  if (!token) {
    throw new Error(
      'Could not find __RequestVerificationToken on Insert page (ACGME page layout may have changed).'
    );
  }
  const hidden = scrapeHiddenFields(html);
  // Residents is usually a <select>, not type=hidden — ADS requires it for "resident program detail" validation (see Insert HAR).
  const residentsSel = parseSelectSelectedValue(html, 'Residents');
  if (residentsSel) {
    hidden.Residents = residentsSel;
  }
  return { token, hidden, cookieHeader, insertHtml: html };
}

/**
 * Resolve the Case ID field name from the ACGME Insert page HTML.
 *
 * ACGME obfuscates visible input field names as 64-char hex hashes (anti-bot).
 * The form renders fields in DOM order: Case ID is the FIRST hash-named text input
 * (before Case Date). We detect by:
 *   1. Plain name match (/caseid/i) — non-obfuscated portals
 *   2. Label association (<label for="HASH">Case ID</label>)
 *   3. First hash-named visible text input (64-char hex) — obfuscated portal
 *   4. Known name candidates fallback
 */
function extractCaseIdFieldNameFromInsertHtml(html) {
  if (!html || typeof html !== 'string') return '';

  // 1. Name contains "caseid" — works if portal is not obfuscated
  const tagRe = /<(input|textarea)\b([^>]*)>/gi;
  let m;
  while ((m = tagRe.exec(html)) !== null) {
    const tag = m[1].toLowerCase();
    const attrs = m[2];
    if (tag === 'input' && /type\s*=\s*["']hidden["']/i.test(attrs)) continue;
    const nameM = attrs.match(/\bname\s*=\s*["']([^"']+)["']/i);
    if (!nameM) continue;
    const name = nameM[1];
    if (/caseid/i.test(name.replace(/[\s._-]/g, ''))) return name;
  }

  // 2. Label-based: <label for="ID">...Case ID...</label> → input[id="ID"].name
  const labelRe = /<label\b[^>]*\bfor\s*=\s*["']([^"']+)["'][^>]*>([\s\S]{0,200}?)<\/label>/gi;
  let lm;
  while ((lm = labelRe.exec(html)) !== null) {
    const labelText = lm[2].replace(/<[^>]+>/g, ''); // strip inner tags
    if (!/case\s*id/i.test(labelText)) continue;
    const forId = lm[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const inputRe2 = new RegExp(`<input\\b[^>]*\\bid\\s*=\\s*["']${forId}["'][^>]*>`, 'i');
    const im = inputRe2.exec(html);
    if (im) {
      const nm = im[0].match(/\bname\s*=\s*["']([^"']+)["']/i);
      if (nm) return nm[1];
    }
  }

  // 3. First hash-named visible text input (ACGME obfuscated portal).
  // ACGME uses 64-char lowercase hex as field names. Case ID is the first such
  // field in DOM order (confirmed from Insert page field list: hash1=CaseId, hash2=CaseDate).
  const hashRe = /<input\b([^>]*)>/gi;
  let hm;
  while ((hm = hashRe.exec(html)) !== null) {
    const attrs = hm[1];
    if (/type\s*=\s*["']hidden["']/i.test(attrs)) continue;
    const nm = attrs.match(/\bname\s*=\s*["']([^"']+)["']/i);
    if (!nm) continue;
    const name = nm[1];
    if (/^[0-9a-f]{32,}$/i.test(name)) return name;
  }

  // 4. Known candidate fallbacks
  for (const candidate of ['CaseId', 'CaseID', 'LocalCaseId', 'ResidentCaseId']) {
    if (new RegExp(`<input\\b[^>]*\\bname\\s*=\\s*["']${candidate}["'][^>]*>`, 'i').test(html)) {
      return candidate;
    }
  }

  return '';
}

/**
 * Resolve the Case Date field name from the ACGME Insert page HTML.
 *
 * On the obfuscated portal, the visible text inputs are hash-named and ordered:
 *   1. Case ID
 *   2. Case Date
 * The HAR in date3.har confirms the second hash field carries the submitted date.
 */
function extractCaseDateFieldNameFromInsertHtml(html) {
  if (!html || typeof html !== 'string') return '';

  // 1. Non-obfuscated name match.
  const tagRe = /<(input|textarea)\b([^>]*)>/gi;
  let m;
  while ((m = tagRe.exec(html)) !== null) {
    const tag = m[1].toLowerCase();
    const attrs = m[2];
    if (tag === 'input' && /type\s*=\s*["']hidden["']/i.test(attrs)) continue;
    const nameM = attrs.match(/\bname\s*=\s*["']([^"']+)["']/i);
    if (!nameM) continue;
    const name = nameM[1];
    if (/case\s*date|procedure\s*date/i.test(name.replace(/[\s._-]/g, ' '))) return name;
  }

  // 2. Label-based association.
  const labelRe = /<label\b[^>]*\bfor\s*=\s*["']([^"']+)["'][^>]*>([\s\S]{0,200}?)<\/label>/gi;
  let lm;
  while ((lm = labelRe.exec(html)) !== null) {
    const labelText = lm[2].replace(/<[^>]+>/g, ' ');
    if (!/case\s*date|procedure\s*date/i.test(labelText)) continue;
    const forId = lm[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const inputRe2 = new RegExp(`<input\\b[^>]*\\bid\\s*=\\s*["']${forId}["'][^>]*>`, 'i');
    const im = inputRe2.exec(html);
    if (im) {
      const nm = im[0].match(/\bname\s*=\s*["']([^"']+)["']/i);
      if (nm) return nm[1];
    }
  }

  // 3. Obfuscated portal: second hash-named visible input = Case Date.
  const hashNames = [];
  const hashRe = /<input\b([^>]*)>/gi;
  let hm;
  while ((hm = hashRe.exec(html)) !== null) {
    const attrs = hm[1];
    if (/type\s*=\s*["']hidden["']/i.test(attrs)) continue;
    const nm = attrs.match(/\bname\s*=\s*["']([^"']+)["']/i);
    if (!nm) continue;
    const name = nm[1];
    if (/^[0-9a-f]{32,}$/i.test(name)) hashNames.push(name);
  }
  if (hashNames.length >= 2) return hashNames[1];

  // 4. Known candidate fallbacks.
  for (const candidate of ['CaseDate', 'ProcedureDate', 'Date']) {
    if (new RegExp(`<input\\b[^>]*\\bname\\s*=\\s*["']${candidate}["'][^>]*>`, 'i').test(html)) {
      return candidate;
    }
  }

  return '';
}

/** Value for the CaseId POST field (only called when shouldPostCaseIdToAds — ref already has a letter). */
function caseIdForAdsInsertForm(raw) {
  return String(raw || '').trim().slice(0, ADS_CASE_ID_MAX_LEN);
}

/**
 * ADS `Comments` — clinical / free text from CaseFlow (`comments` or `notes`).
 * CaseId is now posted directly to the ADS CaseId field; do not duplicate it in Comments.
 */
function mergeLocalCaseIdIntoComments(caseData) {
  const base =
    caseData.comments != null && String(caseData.comments).trim() !== ''
      ? String(caseData.comments)
      : caseData.notes != null
        ? String(caseData.notes)
        : '';
  return base;
}

/**
 * ADS Insert expects SelectedCodes as an internal tuple (e.g. "P,4780,1118932,1,1;"), not a bare CPT.
 * CaseFlow sends CPT from the local index — resolve via GetCodes before POST.
 */
function looksLikeAdsSelectedCodesTuple(s) {
  const t = String(s || '').trim().replace(/;+$/, '');
  if (!t.includes(',')) return false;
  const parts = t.split(',');
  // Typical ADS tuple: "P,4780,1118932,1,1;" — several segments; often starts with a short letter prefix
  if (parts.length >= 4) return true;
  if (parts[0].length <= 4 && /^[A-Za-z]/.test(parts[0])) return true;
  return false;
}

function specialtyIdFromInsertHidden(hidden) {
  const h = hidden || {};
  for (const k of ['SpecialtyId', 'specialtyId', 'SpecialtyID', 'ProgramSpecialtyId', 'RRClassId']) {
    const v = h[k];
    if (v != null && String(v).trim() !== '') return String(v).trim();
  }
  const env = process.env.ACGME_SPECIALTY_ID;
  if (env && String(env).trim() !== '') return String(env).trim();
  return null;
}

/**
 * Scrape specialty ID from Insert page HTML directly.
 * Checks hidden inputs + select options for any field that looks like a specialty/program ID.
 */
function scrapeSpecialtyIdFromHtml(html) {
  // Try hidden inputs first
  const hiddenRe = /<input\b([^>]*)>/gi;
  let m;
  while ((m = hiddenRe.exec(html))) {
    const attrs = m[1];
    const type = (attrs.match(/\btype="([^"]+)"/i)?.[1] || '').toLowerCase();
    if (type !== 'hidden') continue;
    const name = attrs.match(/\bname="([^"]+)"/i)?.[1] || '';
    if (/specialty|rrclass|program/i.test(name)) {
      const value = attrs.match(/\bvalue="([^"]*)"/i)?.[1] || '';
      if (value && /^\d+$/.test(value.trim())) return value.trim();
    }
  }
  // Try select options — look for a select named like Specialty, RRClass, etc.
  const selectRe = /<select\b([^>]*)>([\s\S]*?)<\/select>/gi;
  while ((m = selectRe.exec(html))) {
    const name = m[1].match(/\bname="([^"]+)"/i)?.[1] || '';
    if (!/specialty|rrclass/i.test(name)) continue;
    const selectedOpt = m[2].match(/<option\b[^>]*\bselected(?:="selected")?\b[^>]*\bvalue="(\d+)"/i);
    if (selectedOpt) return selectedOpt[1];
  }
  return null;
}

/**
 * ADS Insert SelectedCodes tuple from GetCodes Payload row (matches browser / HAR).
 * Example: P,4780,1118932,1,1; for CodeId 4780, TypeToCodeId 1118932, Quantity 1.
 */
function buildAdsSelectedCodesTupleFromPayloadRow(row) {
  if (!row || row.CodeId == null || row.TypeToCodeId == null) return '';
  const q = row.Quantity != null ? Number(row.Quantity) : 1;
  // HAR: SelectedCodes ends with `;` (e.g. P,4780,1118932,1,1;) — ADS model expects this delimiter.
  return `P,${row.CodeId},${row.TypeToCodeId},${q},1;`;
}

/** Ensure tuple ends with `;` (legacy / manual paste may omit it). */
function normalizeSelectedCodesForAdsInsert(codes) {
  const c = String(codes || '').trim();
  if (!c) return c;
  const body = c.replace(/;+$/, '');
  if (!looksLikeAdsSelectedCodesTuple(body)) return c;
  return `${body};`;
}

/** First Payload row whose CodeValue matches CPT (MVP when multiple Area/Type rows exist). */
function pickFirstPayloadRowForCpt(payload, cptWant) {
  if (!Array.isArray(payload) || !payload.length) return null;
  const want = String(cptWant || '').trim();
  const wantDigits = want.replace(/\D/g, '');
  for (const r of payload) {
    const cv = String(r.CodeValue != null ? r.CodeValue : '').trim();
    const cd = cv.replace(/\D/g, '');
    if (cv === want || (wantDigits && cd === wantDigits)) return r;
  }
  return null;
}

/**
 * GET /ads/CaseLogs/Code/GetCodes — same contract as desktop Insert search (HAR).
 * Retries once with desktop Referer if Mobile returns 404 (session may match either surface).
 */
async function fetchCodeSearchGetCodes(sessionCookie, { specialtyId, codeDesc, activeAsOfDate }) {
  const qs = new URLSearchParams({
    specialtyId: String(specialtyId),
    codeDesc: String(codeDesc),
    areaId: '',
    typeId: '',
    defCategoryId: '',
    activeAsOfDate: String(activeAsOfDate || ''),
    classId: '',
    _: String(Date.now()),
  });
  const url = `${BASE_URL}/ads/CaseLogs/Code/GetCodes?${qs.toString()}`;

  async function getWithReferer(refererPath) {
    return fetchT(url, {
      headers: {
        Cookie: sessionCookie,
        'User-Agent': UA,
        Accept: 'application/json, text/javascript, */*; q=0.01',
        'X-Requested-With': 'XMLHttpRequest',
        Referer: `${BASE_URL}${refererPath}`,
        Origin: BASE_URL,
      },
    }, 20000);
  }

  let res = await getWithReferer('/ads/CaseLogs/CaseEntry/Insert');
  if (res.status === 404) {
    console.warn('[ACGME] GetCodes 404 with desktop Insert Referer; retrying with CaseEntryMobile/Insert');
    res = await getWithReferer('/ads/CaseLogs/CaseEntryMobile/Insert');
  }
  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    throw new Error(`Lookup failed: ${res.status}${errBody ? ` ${errBody.slice(0, 160)}` : ''}`);
  }
  return res.json();
}

/**
 * ADS POSTs this with the full GetCodes Payload row when the user clicks "Add" on a code.
 * Some server paths require it before Insert accepts SelectedCodes.
 */
async function postGetSelectedCodePartial(sessionCookie, row) {
  const url = `${BASE_URL}/ads/CaseLogs/Code/GetSelectedCodePartial`;
  const res = await fetchT(
    url,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=UTF-8',
        Cookie: sessionCookie,
        'User-Agent': UA,
        Accept: '*/*',
        'X-Requested-With': 'XMLHttpRequest',
        Referer: ACGME_INSERT_URL,
        Origin: BASE_URL,
      },
      body: JSON.stringify(row),
    },
    30000
  );
  const sc = res.headers.raw()['set-cookie'] || [];
  let merged = sessionCookie;
  if (sc.length) {
    merged = mergeCookieHeaderWithSetCookies(sessionCookie, sc);
  }
  const text = await res.text().catch(() => '');
  if (!res.ok) {
    throw new Error(`GetSelectedCodePartial ${res.status}: ${text.slice(0, 400)}`);
  }
  return merged;
}

/**
 * Prefer Success + Payload[] tuple + row; fall back to legacy tree walk (no row for partial).
 */
function resolveTupleAndPayloadRowFromGetCodesJson(data, cptWant) {
  if (data && data.Success === false) return { tuple: '', payloadRow: null };
  const row = pickFirstPayloadRowForCpt(data && data.Payload, cptWant);
  if (row) {
    const tuple = buildAdsSelectedCodesTupleFromPayloadRow(row);
    if (tuple) return { tuple, payloadRow: row };
  }
  const legacy = pickSelectedCodesFromGetCodesResponseLegacy(data, cptWant);
  return { tuple: legacy || '', payloadRow: null };
}

/** @returns {string} tuple only — exported for tests */
function resolveSelectedCodesFromGetCodesJson(data, cptWant) {
  return resolveTupleAndPayloadRowFromGetCodesJson(data, cptWant).tuple;
}

/**
 * Walk GetCodes JSON (including ASP.NET { d: [...] } / double-encoded d) and find SelectedCodes for CPT.
 */
function pickSelectedCodesFromGetCodesResponseLegacy(data, cptWant) {
  const want = String(cptWant || '').trim();
  if (!want) return '';
  const wantDigits = want.replace(/\D/g, '');

  let root = data;
  if (root && typeof root === 'object' && typeof root.d === 'string') {
    try {
      root = JSON.parse(root.d);
    } catch (_) {
      /* ignore */
    }
  }
  if (root && typeof root === 'object' && root.d != null && typeof root.d !== 'string') {
    root = root.d;
  }

  const rows = [];

  function consider(obj) {
    if (!obj || typeof obj !== 'object') return;
    const sel =
      obj.SelectedCodes ||
      obj.selectedCodes ||
      obj.SelectedCode ||
      obj.CodeValue ||
      obj.Value;
    const cpt =
      obj.CptCode ||
      obj.CPTCode ||
      obj.Cpt ||
      obj.cptCode ||
      obj.ProcedureCode ||
      obj.Code ||
      obj.code;
    if (typeof sel === 'string' && sel.includes(',')) {
      rows.push({ sel, cpt: cpt != null ? String(cpt).trim() : '' });
    }
  }

  function visit(node, depth) {
    if (depth > 14 || node == null) return;
    if (Array.isArray(node)) {
      node.forEach((n) => visit(n, depth + 1));
      return;
    }
    if (typeof node === 'object') {
      consider(node);
      for (const v of Object.values(node)) {
        if (v && typeof v === 'object') visit(v, depth + 1);
      }
    }
  }

  visit(root, 0);

  const score = (r) => {
    const c = r.cpt.replace(/\D/g, '');
    if (r.cpt === want) return 100;
    if (c && wantDigits && c === wantDigits) return 90;
    if (r.cpt && wantDigits && r.cpt.includes(want)) return 70;
    return 0;
  };

  let best = '';
  let bestScore = 0;
  for (const r of rows) {
    const s = score(r);
    if (s > bestScore) {
      bestScore = s;
      best = r.sel;
    }
  }
  return best;
}

/**
 * Resolve a single bare CPT to ADS tuple via GetCodes.
 */
async function resolveOneCpt(sessionCookie, specialtyId, cpt, procedureDate) {
  let data;
  try {
    data = await fetchCodeSearchGetCodes(sessionCookie, {
      specialtyId,
      codeDesc: cpt,
      activeAsOfDate: procedureDate || '',
    });
  } catch (e) {
    throw new Error(
      `Could not look up procedure code "${cpt}" in ACGME (${e.message || e}). ` +
        'Confirm your case date and that this CPT is valid for your program in ADS.'
    );
  }

  if (process.env.ACGME_DEBUG_SUBMIT === '1') {
    try {
      console.warn('[ACGME] DEBUG GetCodes response (truncated):', JSON.stringify(data).slice(0, 2500));
    } catch (_) {
      console.warn('[ACGME] DEBUG GetCodes: (unserializable)');
    }
  }

  if (data && data.Success === false) {
    const msg = (data.Message && String(data.Message).trim()) || 'Success=false';
    throw new Error(`ACGME GetCodes rejected the request: ${msg}. Check procedure date and specialty.`);
  }

  const { tuple: resolved, payloadRow } = resolveTupleAndPayloadRowFromGetCodesJson(data, cpt);
  if (!resolved) {
    throw new Error(
      `ACGME has no matching procedure row for code "${cpt}" (specialty ${specialtyId}). ` +
        'Try another code or enter the case manually in ADS once, then compare Network → GetCodes in DevTools. ' +
        'If your program uses a non-default specialty, set ACGME_SPECIALTY_ID on the Railway service.'
    );
  }

  console.warn(`[ACGME] Resolved CPT "${cpt}" → SelectedCodes tuple (len=${resolved.length}b)`);
  return { tuple: resolved, payloadRow, codeValue: payloadRow ? String(payloadRow.CodeValue || '').trim() : cpt };
}

/**
 * If selectedCodes is a raw CPT or comma-separated CPTs, resolve each via GetCodes and replace
 * with concatenated ADS tuples (e.g. "P,4780,1118932,1,1;P,9440,100733,1,1;").
 */
async function resolveSelectedCodesIfNeeded(sessionCookie, hidden, caseData) {
  const raw = String(caseData.selectedCodes || '').trim();
  if (!raw) return caseData;
  if (looksLikeAdsSelectedCodesTuple(raw)) return caseData;

  const specialtyId = specialtyIdFromInsertHidden(hidden);

  // Split by comma to support multi-code submissions (e.g. "30410,19325")
  const parts = raw.split(',').map(s => s.trim()).filter(Boolean);

  const tuples = [];
  const payloadRows = [];
  let lastCodeValue = '';

  for (const cpt of parts) {
    const { tuple, payloadRow, codeValue } = await resolveOneCpt(
      sessionCookie, specialtyId, cpt, caseData.procedureDate
    );
    tuples.push(tuple);
    if (payloadRow) payloadRows.push(payloadRow);
    lastCodeValue = codeValue;
  }

  const out = {
    ...caseData,
    selectedCodes: tuples.join(''),   // "P,a,b,1,1;P,c,d,1,1;"
    _adsCodeValueForInsert: lastCodeValue,
  };
  if (payloadRows.length === 1) {
    out._adsPayloadRow = payloadRows[0];
  } else if (payloadRows.length > 1) {
    out._adsPayloadRows = payloadRows;
  }
  return out;
}

/**
 * Build POST body: server hidden fields first, then antiforgery token, then explicit case
 * fields (so programmatic values override any duplicate names from hidden).
 */

/** Remove hidden inputs named like CaseId so our posted value is not overridden by an empty scraped duplicate. */
function stripHiddenCaseIdKeys(hidden) {
  const out = { ...hidden };
  for (const k of Object.keys(out)) {
    if (/(\.|^)caseid$/i.test(k.trim())) delete out[k];
  }
  return out;
}

/** Remove hidden/default date keys so the visible submitted Case Date wins. */
function stripHiddenDateKeys(hidden, keepFieldName = '') {
  const out = { ...hidden };
  const keep = String(keepFieldName || '').trim();
  for (const k of Object.keys(out)) {
    const key = k.trim();
    if (keep && key === keep) continue;
    if (/(\.|^)(case|procedure)?date$/i.test(key) || /date/i.test(key)) {
      delete out[k];
    }
  }
  return out;
}

function buildInsertFormPayload(token, hidden, caseData, insertHtml) {
  const codes = normalizeSelectedCodesForAdsInsert(caseData.selectedCodes || '');
  // Successful browser HAR: HoldSelectedCodes=False, SelectedCodes=P,codeId,typeToCodeId,q,1;
  // CodeDescription=CPT digits (e.g. 19325), not long prose — see after succesful submission2.har
  const tupleLike = looksLikeAdsSelectedCodesTuple(codes);
  const codeDesc =
    caseData._adsCodeValueForInsert != null && String(caseData._adsCodeValueForInsert).trim() !== ''
      ? String(caseData._adsCodeValueForInsert).trim()
      : (caseData.codeDescription || '');
  const residentsVal =
    caseData.residentsId != null && String(caseData.residentsId).trim() !== ''
      ? String(caseData.residentsId).trim()
      : (hidden.Residents || '');
  const postCaseId = shouldPostCaseIdToAds(caseData.caseId);
  const caseIdFieldName = extractCaseIdFieldNameFromInsertHtml(insertHtml || '') || 'CaseId';
  const caseDateFieldName = extractCaseDateFieldNameFromInsertHtml(insertHtml || '');
  console.warn('[ACGME] CaseId field name resolved:', caseIdFieldName.slice(0, 20), '| will post:', postCaseId, '| raw:', String(caseData.caseId || '').slice(0, 8));
  console.warn('[ACGME] CaseDate field name resolved:', caseDateFieldName ? caseDateFieldName.slice(0, 20) : '(none)', '| value:', String(caseData.procedureDate || '').slice(0, 12));
  const cid = postCaseId ? caseIdForAdsInsertForm(caseData.caseId) : '';
  let hiddenClean = stripHiddenDateKeys(hidden, caseDateFieldName);
  hiddenClean = postCaseId ? stripHiddenCaseIdKeys(hiddenClean) : hiddenClean;
  if (!postCaseId && String(caseData.caseId || '').trim()) {
    const s = String(caseData.caseId).trim();
    const env = String(process.env.ACGME_POST_CASE_ID || '').trim().toLowerCase();
    if (env === '0' || env === 'false' || env === 'off' || env === 'never') {
      console.warn('[ACGME] CaseId field not posted (ACGME_POST_CASE_ID=never); ref in Comments only.');
    } else if (!/[a-zA-Z]/.test(s)) {
      console.warn(
        '[ACGME] CaseId not posted for digits-only (ADS Insert HTTP 500). Ref in Comments as "Case ID: …". Use a letter, e.g. C12345, for the Case ID field.'
      );
    }
  }
  const body = {
    ...hiddenClean,
    __RequestVerificationToken: token,
    Residents:       residentsVal,
    ProcedureDate:   caseData.procedureDate,
    ProcedureYear:   caseData.procedureYear,
    ResidentRoles:   caseData.residentRoleId,
    Institutions:    caseData.institutionId,
    Attendings:      caseData.attendingId,
    PatientTypes:    caseData.patientTypeId,
    HoldSelectedCodes: tupleLike ? 'False' : codes,
    SelectedCodes:     codes,
    CodeDescription: codeDesc,
    Comments:        mergeLocalCaseIdIntoComments(caseData),
    SearchTerm:      'False',
  };
  if (caseData.extraFields && typeof caseData.extraFields === 'object') {
    for (const [fieldName, value] of Object.entries(caseData.extraFields)) {
      if (!fieldName) continue;
      if (value == null) continue;
      const normalized = Array.isArray(value) ? value.join(',') : String(value).trim();
      if (normalized === '') continue;
      body[fieldName] = normalized;
    }
  }
  if (caseDateFieldName) {
    body[caseDateFieldName] = caseData.procedureDate;
  }
  if (cid) {
    body[caseIdFieldName] = cid;
  }
  return new URLSearchParams(body);
}

/**
 * Log form field names and value lengths only (no secrets) — compare to browser DevTools
 * → Network → Insert POST → Form Data when debugging 500s without ACGME support.
 */
function logSubmitPayloadDiagnostics(payload, hidden, caseData) {
  try {
    const hiddenKeys = Object.keys(hidden || {});
    const pairs = [];
    for (const [k, v] of payload.entries()) {
      const n = String(v).length;
      pairs.push(`${k}=${n}b`);
    }
    console.warn('[ACGME] submit form keys (value byte-lengths only):', pairs.join(', '));
    console.warn('[ACGME] Insert hidden field count:', hiddenKeys.length, 'names:', hiddenKeys.sort().join(',') || '(none)');
    if (caseData) {
      console.warn(
        '[ACGME] caseData snapshot (lengths): date=%s yr=%s roleId=%s siteId=%s attId=%s ptId=%s codes=%sb desc=%sb caseId=%sb',
        String(caseData.procedureDate || '').length,
        String(caseData.procedureYear || '').length,
        String(caseData.residentRoleId || '').length,
        String(caseData.institutionId || '').length,
        String(caseData.attendingId || '').length,
        String(caseData.patientTypeId || '').length,
        String(caseData.selectedCodes || '').length,
        String(caseData.codeDescription || '').length,
        String(caseData.caseId || '').length
      );
      const cid = String(caseData.caseId || '').trim();
      if (cid) {
        if (shouldPostCaseIdToAds(caseData.caseId)) {
          const posted = caseIdForAdsInsertForm(caseData.caseId);
          console.warn('[ACGME] CaseId POST: raw %sb → posted %sb', `${cid.length}`, `${String(posted).length}`);
        } else {
          console.warn('[ACGME] CaseId POST disabled by env; Comments contain ref; raw %sb', `${cid.length}`);
        }
      }
      const scLen = String(caseData.selectedCodes || '').length;
      const scRaw = String(caseData.selectedCodes || '').trim();
      if (scLen > 0 && scLen < 12 && !scRaw.includes(',')) {
        console.warn(
          '[ACGME] hint: SelectedCodes is very short and has no commas — likely bare CPT only. ' +
            'Redeploy backend with GetCodes resolution, or expect ADS 500. After deploy you should see log line "[ACGME] Resolved CPT …".'
        );
      }
    }
  } catch (e) {
    console.warn('[ACGME] payload diagnostics failed:', e.message);
  }
}

function logSubmitErrorResponse(status, html) {
  const len = (html || '').length;
  const hash = html
    ? crypto.createHash('sha256').update(html, 'utf8').digest('hex').slice(0, 16)
    : 'none';
  const hint = extractAcgmeSubmitErrorHint(html || '');
  console.warn(
    `[ACGME] submit POST ${status} len=${len} bodySha256prefix=${hash} extractedHint=${hint ? hint.slice(0, 220).replace(/\s+/g, ' ') : '(none)'}`
  );
  const snippet = (html || '').replace(/\s+/g, ' ').slice(0, 4000);
  console.warn('[ACGME] submit body snippet (4k):', snippet);
  if (process.env.ACGME_DEBUG_SUBMIT === '1' && html) {
    console.warn('[ACGME] DEBUG full response body:', html);
  }
}

async function submitCaseOnce(sessionCookie, caseData) {
  const { token, hidden, cookieHeader: mergedCookie, insertHtml } = await getInsertPageData(sessionCookie);
  const cookie = mergedCookie || sessionCookie;

  if (process.env.ACGME_DEBUG_SUBMIT === '1') {
    console.warn('[ACGME] DEBUG Insert hidden field names:', Object.keys(hidden || {}));
  }

  if (!hidden.Residents) {
    console.warn(
      '[ACGME] No Residents id on Insert page (hidden/select parse). If submit fails with "bad resident program detail Id", reconnect ACGME or pass residentsId from GET /api/lookups/user-profile.'
    );
  }

  const caseDataResolved = await resolveSelectedCodesIfNeeded(cookie, hidden, caseData);

  const caseDataForInsert = { ...caseDataResolved };
  const payloadRow = caseDataForInsert._adsPayloadRow;
  const payloadRows = caseDataForInsert._adsPayloadRows;
  delete caseDataForInsert._adsPayloadRow;
  delete caseDataForInsert._adsPayloadRows;

  let cookieForSubmit = cookie;
  if (payloadRows && payloadRows.length > 1) {
    // Multi-code: call GetSelectedCodePartial for each resolved row in sequence
    for (const row of payloadRows) {
      cookieForSubmit = await postGetSelectedCodePartial(cookieForSubmit, row);
    }
    if (process.env.ACGME_DEBUG_SUBMIT === '1') {
      console.warn(`[ACGME] DEBUG GetSelectedCodePartial completed for ${payloadRows.length} codes`);
    }
  } else if (payloadRow) {
    cookieForSubmit = await postGetSelectedCodePartial(cookie, payloadRow);
    if (process.env.ACGME_DEBUG_SUBMIT === '1') {
      console.warn('[ACGME] DEBUG GetSelectedCodePartial completed before Insert');
    }
  }

  const payload = buildInsertFormPayload(token, hidden, caseDataForInsert, insertHtml);

  const res = await fetchT(ACGME_INSERT_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Cookie': cookieForSubmit,
      'User-Agent': UA,
      'Referer': ACGME_INSERT_URL,
      'Origin': BASE_URL,
      'Sec-Fetch-Site': 'same-origin',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-User': '?1',
      'Sec-Fetch-Dest': 'document',
    },
    body: payload,
    redirect: 'manual',
  }, 60000);

  const html = await res.text();
  const loc = res.headers.get('location') || '';

  if (res.status >= 300 && res.status < 400) {
    if (
      loc.includes('Insert') ||
      loc.includes('CaseLogs') ||
      loc.includes('CaseEntry') ||
      /\/ads\/CaseLogs\//i.test(loc)
    ) {
      return { success: true, message: 'Case submitted successfully' };
    }
    if (/b2clogin|microsoftonline|oauth|signin|authorize|login\.microsoft/i.test(loc)) {
      throw new Error(
        'ACGME session expired or not authenticated — open Settings and reconnect your ACGME account.'
      );
    }
    const hint = extractAcgmeSubmitErrorHint(html);
    throw new Error(
      hint
        ? `ACGME redirect (${res.status}) to ${loc.slice(0, 120)} — ${hint}`
        : `ACGME unexpected redirect (${res.status}): ${loc.slice(0, 200) || '(no Location header)'}`
    );
  }

  if (res.status === 200 && looksLikeAcgmeSubmitSuccess(html)) {
    return { success: true, message: 'Case submitted successfully' };
  }

  if (res.status === 200) {
    const err = html.match(/class="[^"]*error[^"]*"[^>]*>([^<]+)</i);
    if (err) throw new Error(`ACGME error: ${err[1].trim()}`);
    const hint = extractAcgmeSubmitErrorHint(html);
    if (hint) throw new Error(`ACGME: ${hint}`);
    console.warn('[ACGME] submit 200 unrecognized:', (html || '').slice(0, 900).replace(/\s+/g, ' '));
    throw new Error(
      'ACGME returned the form again (200) with no clear success — check required fields or ACGME Case Log.'
    );
  }

  if (res.status >= 400) {
    logSubmitPayloadDiagnostics(payload, hidden, caseDataForInsert);
    logSubmitErrorResponse(res.status, html);
    const hint = extractAcgmeSubmitErrorHint(html);
    throw new Error(
      hint
        ? `ACGME server error (${res.status}): ${hint}`
        : `ACGME server error (${res.status}) — no parseable message in HTML. See Railway logs for body snippet. Check procedure/codes/IDs.`
    );
  }

  throw new Error(`Unexpected submission response: ${res.status}`);
}

/**
 * POST case to ACGME Insert. On HTTP 500, retry once with a fresh Insert GET (new token/hidden).
 */
async function submitCase(sessionCookie, caseData) {
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await submitCaseOnce(sessionCookie, caseData);
    } catch (err) {
      lastErr = err;
      const msg = String(err.message || '');
      const is500 =
        /\b500\b/.test(msg) ||
        /server error \(500\)/i.test(msg) ||
        /returned 500/i.test(msg);
      if (attempt === 0 && is500) {
        console.warn('[ACGME] submitCase: retrying once after 500 with fresh Insert GET');
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

// ── User Profile (sites + attendings) ─────────────────────────────────────────

/**
 * Value of the selected <option> for a named <select> (visible fields not scraped as hidden inputs).
 * Used for Residents on Insert — required with institution/role for ADS resident-program validation.
 */
function parseSelectSelectedValue(html, selectName) {
  const esc = selectName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const blockRe = new RegExp(
    `<select\\b[^>]*\\b(?:name|id)=["']${esc}["'][^>]*>([\\s\\S]*?)<\\/select>`,
    'i'
  );
  const selectMatch = html.match(blockRe);
  if (!selectMatch) return '';
  const inner = selectMatch[1];
  const optRe = /<option\b([^>]*)>([\s\S]*?)<\/option>/gi;
  let m;
  let firstVal = '';
  while ((m = optRe.exec(inner)) !== null) {
    const attrs = m[1];
    let vm = attrs.match(/\bvalue\s*=\s*(["'])([^"']*)\1/i);
    if (!vm) vm = attrs.match(/\bvalue\s*=\s*([^\s>]+)/i);
    const id = vm ? (vm[2] != null ? vm[2] : vm[1]).trim() : '';
    if (!id) continue;
    if (!firstVal) firstVal = id;
    if (/\bselected\b/i.test(attrs)) return id;
  }
  return firstVal;
}

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

function decodeHtmlLite(str = '') {
  return String(str)
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

function humanizeFieldName(name = '') {
  return decodeHtmlLite(
    String(name || '')
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/[_-]+/g, ' ')
  );
}

function standardFieldKeyFromName(name = '') {
  const n = String(name || '').trim().toLowerCase();
  if (n === 'residentroles' || n === 'residentrole') return 'role';
  if (n === 'institutions' || n === 'institution') return 'site';
  if (n === 'attendings' || n === 'attending') return 'attending';
  if (n === 'patienttypes' || n === 'patienttype') return 'patientType';
  if (n === 'procedureyear') return 'caseYear';
  if (n === 'rotations' || n === 'rotation') return 'rotation';
  if (n === 'residents' || n === 'resident') return 'resident';
  if (n === 'caseid') return 'caseId';
  return null;
}

function standardFieldKeyFromLabel(label = '') {
  const l = String(label || '').replace(/\*+/g, '').trim().toLowerCase();
  if (!l) return null;
  if (l === 'date' || l === 'case date' || l === 'procedure date') return 'date';
  if (l === 'case year' || l === 'procedure year' || l === 'resident year of case') return 'caseYear';
  if (l === 'role' || l === 'resident role') return 'role';
  if (l === 'site' || l === 'institution') return 'site';
  if (l === 'attending') return 'attending';
  if (l === 'patient age' || l === 'patient type') return 'patientType';
  if (l === 'case id' || l === 'patient id') return 'caseId';
  if (l === 'setting' || l === 'rotation') return 'rotation';
  return null;
}

function shouldIgnoreSchemaField(name = '') {
  const n = String(name || '').trim();
  if (!n) return true;
  if (/^(?:__RequestVerificationToken|SelectedCodes|SelectedCodeAttributes|Comments|CodeDescription|CodeIdToAddToFavList|TypeToCodeIdToAddToFavList|FavoriteLists|FavoriteListIdToAddCode|CategoriesShortLabel|GetSelectedCodePartial|GetYearOptionsUrl|UrlGetLastFive|UrlGetLastCase|SearchTerm|HoldSelectedCodes|HiddenUrls|Areas|Types|Categories|CategoryCodeDescription|NewFavoriteListName|NewFavListIds|NewFavListNames|SelectedCodesTab|MaxProcedureCaseTemplate|CountProcedureCaseTemplate|ResidentProcedureCaseTemplateId|TemplateNewName|TemplateSaveType|ProgramId|SpecialtyCode|SpecialtyId|SpecialtyTypeId|CPTBasedCase|TypeBasedCase|SpecialtyUsesPrimaryCredit|IsOrthopaedicSubspecialty|IsProcedureCaseTemplateEnabled|IsSpecialtyContainsCodeMessage|PatientIdDisplayName|DefaultInstitutions|DefaultAttendings|DefaultResidentRoles|DefaultRotations|DefaultGenders|DefaultPatientTypes|DefaultProcedureYear)$/i.test(n)) {
    return true;
  }
  if (/^Favorite/i.test(n) || /^HiddenUrls$/i.test(n)) return true;
  return false;
}

function inferLabelForControl(html, controlName, controlId = '') {
  const escName = String(controlName || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const escId = String(controlId || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const attrsRe = new RegExp(
    `<label\\b[^>]*?(?:for=["']${escId}["']|for=["']${escName}["'])[^>]*>([\\s\\S]*?)<\\/label>`,
    'i'
  );
  const explicit = html.match(attrsRe);
  if (explicit && explicit[1]) {
    return decodeHtmlLite(explicit[1].replace(/<[^>]+>/g, ' ')).trim();
  }

  const controlRe = new RegExp(
    `<(?:select|input)\\b[^>]*?(?:name=["']${escName}["']|id=["']${escId || escName}["'])[^>]*>`,
    'i'
  );
  const m = controlRe.exec(html);
  if (!m) return '';
  const start = Math.max(0, m.index - 600);
  const windowHtml = html.slice(start, m.index);
  const labels = [...windowHtml.matchAll(/<label\b[^>]*>([\s\S]*?)<\/label>/gi)];
  if (labels.length) {
    const last = labels[labels.length - 1][1];
    return decodeHtmlLite(last.replace(/<[^>]+>/g, ' ')).trim();
  }
  return '';
}

function scrapeVisibleFormFields(html) {
  const fields = [];
  const seen = new Set();

  const selectRe = /<select\b([^>]*)>([\s\S]*?)<\/select>/gi;
  let m;
  while ((m = selectRe.exec(html)) !== null) {
    const attrs = m[1];
    const name = attrs.match(/\bname="([^"]+)"/i)?.[1] || attrs.match(/\bid="([^"]+)"/i)?.[1] || '';
    const id = attrs.match(/\bid="([^"]+)"/i)?.[1] || '';
    if (!name || shouldIgnoreSchemaField(name) || seen.has(`select:${name}`)) continue;
    seen.add(`select:${name}`);
    const label = inferLabelForControl(html, name, id) || humanizeFieldName(name);
    const options = parseSelectOptions(html, name);
    if (!options.length) continue;
    const standardKey = standardFieldKeyFromName(name) || standardFieldKeyFromLabel(label);
    fields.push({
      key: standardKey || `field:${name}`,
      name,
      label,
      type: 'select',
      required: /\*/.test(label) || /required/i.test(attrs),
      options,
      standardKey,
    });
  }

  const inputRe = /<input\b([^>]*)>/gi;
  while ((m = inputRe.exec(html)) !== null) {
    const attrs = m[1];
    const type = (attrs.match(/\btype="([^"]+)"/i)?.[1] || 'text').toLowerCase();
    if (type === 'hidden' || type === 'checkbox' || type === 'radio' || type === 'submit' || type === 'button') continue;
    const name = attrs.match(/\bname="([^"]+)"/i)?.[1] || attrs.match(/\bid="([^"]+)"/i)?.[1] || '';
    const id = attrs.match(/\bid="([^"]+)"/i)?.[1] || '';
    if (!name || shouldIgnoreSchemaField(name) || seen.has(`input:${name}`)) continue;
    seen.add(`input:${name}`);
    const label = inferLabelForControl(html, name, id) || humanizeFieldName(name);
    if (!label) continue;
    const standardKey = standardFieldKeyFromName(name) || standardFieldKeyFromLabel(label) || (type === 'date' ? 'date' : null);
    fields.push({
      key: standardKey || `field:${name}`,
      name,
      label,
      type: type === 'date' ? 'date' : 'text',
      required: /\*/.test(label) || /required/i.test(attrs),
      standardKey,
    });
  }

  return fields;
}

/**
 * Fetches the ACGME Insert page and returns program-specific selects as {id, label} arrays.
 * Same GET as getInsertPageData (manual redirect) so profile matches submit auth.
 */
async function getUserProfile(sessionCookie) {
  const { html } = await fetchInsertHtmlWithRedirects(sessionCookie);

  // Hoist hidden-field scrape so all AJAX fallbacks can share it
  const hidden = scrapeHiddenFields(html);

  let sites = parseSelectOptions(html, 'Institutions');
  if (!sites.length) sites = parseSelectOptions(html, 'Institution');
  if (!sites.length) sites = parseSelectOptions(html, 'institutions');
  let attendings = parseSelectOptions(html, 'Attendings');
  if (!attendings.length) attendings = parseSelectOptions(html, 'Attending');
  if (!attendings.length) attendings = parseSelectOptions(html, 'attendings');
  let roles = parseSelectOptions(html, 'ResidentRoles');
  if (!roles.length) roles = parseSelectOptions(html, 'ResidentRole');
  if (!roles.length) roles = parseSelectOptions(html, 'residentRoles');

  // Roles are often loaded via AJAX (GetResidentRoles) and not in the page HTML.
  // Fall back to hitting the endpoint directly using today's date.
  if (!roles.length) {
    try {
      const today = new Date().toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' });
      const spId = specialtyIdFromInsertHidden(hidden) || scrapeSpecialtyIdFromHtml(html) || '158';
      const rolesUrl = `${BASE_URL}/ads/CaseLogs/Code/GetResidentRoles?specialtyId=${spId}&activeAsOfDate=${encodeURIComponent(today)}&_=${Date.now()}`;
      const rolesResp = await fetchT(rolesUrl, {
        headers: { 'Cookie': sessionCookie, 'User-Agent': UA, 'Accept': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
      }, 10000);
      if (rolesResp.ok) {
        const rolesJson = await rolesResp.json();
        const payload = rolesJson.Payload || rolesJson.payload || rolesJson;
        if (Array.isArray(payload)) {
          roles = payload.map(r => ({ id: String(r.ID || r.id || r.Value || r.value || ''), label: String(r.ShortName || r.shortName || r.Text || r.label || '') })).filter(r => r.id);
        }
      }
    } catch (e) {
      console.warn('[profile] GetResidentRoles fallback failed:', e.message);
    }
  }

  let patientTypes = parseSelectOptions(html, 'PatientTypes');
  if (!patientTypes.length) patientTypes = parseSelectOptions(html, 'PatientType');
  if (!patientTypes.length) patientTypes = parseSelectOptions(html, 'patientTypes');
  let rotations = parseSelectOptions(html, 'Rotations');
  if (!rotations.length) rotations = parseSelectOptions(html, 'Rotation');
  if (!rotations.length) rotations = parseSelectOptions(html, 'rotations');

  // Patient types are also AJAX-loaded for some programs — fall back to GetPatientTypes endpoint.
  if (!patientTypes.length) {
    try {
      const today = new Date().toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' });
      const spId = specialtyIdFromInsertHidden(hidden) || scrapeSpecialtyIdFromHtml(html) || '158';
      const ptUrl = `${BASE_URL}/ads/CaseLogs/Code/GetPatientTypes?specialtyId=${spId}&activeAsOfDate=${encodeURIComponent(today)}&_=${Date.now()}`;
      const ptResp = await fetchT(ptUrl, {
        headers: { 'Cookie': sessionCookie, 'User-Agent': UA, 'Accept': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
      }, 10000);
      if (ptResp.ok) {
        const ptJson = await ptResp.json();
        const payload = ptJson.Payload || ptJson.payload || ptJson;
        if (Array.isArray(payload)) {
          patientTypes = payload
            .map(p => ({ id: String(p.ID || p.id || ''), label: String(p.ShortName || p.shortName || p.Text || p.text || '') }))
            .filter(p => p.id && p.label);
        }
      }
    } catch (e) {
      console.warn('[profile] GetPatientTypes fallback failed:', e.message);
    }
  }

  const residentsId = parseSelectSelectedValue(html, 'Residents');
  const procedureYearSelected = parseSelectSelectedValue(html, 'ProcedureYear');
  const formFields = scrapeVisibleFormFields(html).map(field => {
    if ((field.standardKey === 'site' || field.name === 'Institutions') && sites.length) return { ...field, options: sites };
    if ((field.standardKey === 'attending' || field.name === 'Attendings') && attendings.length) return { ...field, options: attendings };
    if ((field.standardKey === 'role' || field.name === 'ResidentRoles') && roles.length) return { ...field, options: roles };
    if ((field.standardKey === 'patientType' || field.name === 'PatientTypes') && patientTypes.length) return { ...field, options: patientTypes };
    if ((field.standardKey === 'rotation' || field.name === 'Rotations') && rotations.length) return { ...field, options: rotations };
    if (field.standardKey === 'caseYear' && procedureYearSelected) return { ...field, selectedId: procedureYearSelected };
    return field;
  });

  // specialtyId already scraped above (hidden hoisted)
  const specialtyId = specialtyIdFromInsertHidden(hidden) || scrapeSpecialtyIdFromHtml(html);

  console.log(
    `[profile] sites: ${sites.length}, attendings: ${attendings.length}, roles: ${roles.length}, patientTypes: ${patientTypes.length}, rotations: ${rotations.length}, schemaFields: ${formFields.length}` +
      (residentsId ? `, residentsId: set` : `, residentsId: (none)`) +
      (specialtyId ? `, specialtyId: ${specialtyId}` : `, specialtyId: (not found)`)
  );
  return { sites, attendings, roles, patientTypes, rotations, residentsId, specialtyId, procedureYearSelected, formFields };
}

async function getLookupData(sessionCookie, type, params = {}) {
  if (type === 'codes') {
    const specialtyId =
      params.specialtyId || params.specialtyid || specialtyIdFromInsertHidden({}) || '158'; // fallback to plastic surgery
    const codeDesc =
      params.codeDesc || params.codedesc || params.searchTerm || params.searchterm || '';
    const activeAsOfDate = params.activeAsOfDate || params.activeasofdate || '';
    return fetchCodeSearchGetCodes(sessionCookie, {
      specialtyId: String(specialtyId),
      codeDesc: String(codeDesc),
      activeAsOfDate: String(activeAsOfDate),
    });
  }

  const endpoints = {
    cptCodes:  '/ads/CaseLogs/CaseEntryMobile/GetCptTypeToAreaInfosBySpecialtyActiveDate',
    types:     '/ads/CaseLogs/CaseEntryMobile/GetTypesBySpecialtyIdOrRRClassId',
    roles:     '/ads/CaseLogs/CaseEntryMobile/GetResidentRoles',
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
    if (!nameM) continue;
    const name = nameM[1];
    if (name === '__RequestVerificationToken') continue;
    const valM =
      attrs.match(/\bvalue\s*=\s*["']([^"']*)["']/i) ||
      attrs.match(/\bvalue\s*=\s*'([^']*)'/i) ||
      attrs.match(/\bvalue\s*=\s*([^\s>]+)/i);
    fields[name] = valM ? valM[1] : '';
  }
  return fields;
}

/** Skip default ADS product title — not a real error message */
function isGenericAdsTitleOrBoilerplate(s) {
  if (!s || typeof s !== 'string') return true;
  const t = s.trim().toLowerCase();
  if (t.length < 4) return true;
  if (/^acgme\s*[-–]\s*accreditation data system/i.test(t)) return true;
  if (/accreditation data system\s*\(ads\)/i.test(t) && t.length < 120) return true;
  if (t === 'acgme' || t === 'ads' || t === 'case log') return true;
  return false;
}

/**
 * Best-effort parse of ACGME POST error HTML (ASP.NET, Bootstrap/ADS shells).
 * Order: validation + alerts first; generic `<title>` last (often just "ACGME - ADS").
 */
function extractAcgmeSubmitErrorHint(html) {
  if (!html || typeof html !== 'string') return '';
  const t = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ');

  const patterns = [
    // ADS generic error page — primary user-visible line (see body.errorLayout)
    /<span[^>]*\bid=["']errorMessage["'][^>]*>([^<]+)<\/span>/i,
    /\bid=["']errorMessage["'][^>]*>([^<]+)</i,
    /<div[^>]*class="[^"]*validation-summary-errors[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
    /<ul[^>]*class="[^"]*validation-summary-errors[^"]*"[^>]*>([\s\S]*?)<\/ul>/i,
    /<div[^>]*class="[^"]*alert[^"]*danger[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
    /<div[^>]*class="[^"]*alert-danger[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
    /<div[^>]*class="[^"]*panel[^"]*(?:danger|error)[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
    /<div[^>]*class="[^"]*(?:has-error|error)[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
    /<[^>]+role="alert"[^>]*>([\s\S]*?)<\/[^>]+>/i,
    /<p[^>]*class="[^"]*text-danger[^"]*"[^>]*>([\s\S]*?)<\/p>/i,
    /<span[^>]*class="[^"]*field-validation-error[^"]*"[^>]*>([^<]+)/i,
    /<h1[^>]*>([^<]{5,400})<\/h1>/i,
    /<h2[^>]*>([^<]{5,400})<\/h2>/i,
    /<h3[^>]*>([^<]{5,400})<\/h3>/i,
    /Exception Message:\s*([^<\n]{10,400})/i,
    /System\.[\w.]+\s*:\s*([^<\n]{15,400})/i,
  ];

  for (const re of patterns) {
    const m = t.match(re);
    if (!m || !m[1]) continue;
    let s = m[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    if (s.length < 8 || /^case log$/i.test(s)) continue;
    if (isGenericAdsTitleOrBoilerplate(s)) continue;
    return s.slice(0, 500);
  }

  const tm = t.match(/<title[^>]*>([^<]{5,300})<\/title>/i);
  if (tm && tm[1]) {
    const s = tm[1].replace(/<[^>]+>/g, ' ').trim();
    if (s.length >= 8 && !isGenericAdsTitleOrBoilerplate(s)) return s.slice(0, 500);
  }

  const plain = t.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  if (plain.length > 40 && plain.length < 4000) {
    const slice = plain.slice(0, 600);
    if (!isGenericAdsTitleOrBoilerplate(slice) && !/^[\s\-—]*acgme[\s\-—]*accreditation/i.test(slice)) {
      return slice;
    }
  }
  return '';
}

function looksLikeAcgmeSubmitSuccess(html) {
  if (!html) return false;
  const h = html.toLowerCase();
  return (
    h.includes('submitted successfully') ||
    h.includes('case was submitted') ||
    h.includes('successfully submitted') ||
    h.includes('submission complete') ||
    h.includes('case log entry') && h.includes('success')
  );
}

module.exports = {
  loginToACGME,
  getInsertPageData,
  submitCase,
  getLookupData,
  getUserProfile,
  // test / tooling: pure helpers for GetCodes Payload → SelectedCodes tuple
  buildAdsSelectedCodesTupleFromPayloadRow,
  pickFirstPayloadRowForCpt,
  resolveSelectedCodesFromGetCodesJson,
};
