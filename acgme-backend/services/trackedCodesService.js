'use strict';

const fetch = require('node-fetch');
const XLSX = require('xlsx');

const ACGME_ORIGIN = 'https://apps.acgme.org';
const REPORT_INPUT_URL = `${ACGME_ORIGIN}/ads/CaseLogs/Reports/GetReportInput`;
const REPORT_NAME = 'AvailableCodesByAreaAndType';
const REPORT_TITLE = 'Tracked Codes ';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function decodeHtml(str = '') {
  return String(str)
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/\r/g, '');
}

function cleanText(v) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
}

function buildReportInputUrl() {
  const q = new URLSearchParams({
    reportName: REPORT_NAME,
    reportTitle: REPORT_TITLE,
    hasParameters: 'True',
    isArchiveReport: 'False',
  });
  return `${REPORT_INPUT_URL}?${q.toString()}`;
}

async function fetchTrackedCodesInputPage(cookieHeader) {
  const reportInputUrl = buildReportInputUrl();
  const res = await fetch(reportInputUrl, {
    headers: {
      'User-Agent': UA,
      'Cookie': cookieHeader,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Referer': `${ACGME_ORIGIN}/ads/CaseLogs/Reports/GetReportList`,
    },
    redirect: 'follow',
  });

  if (!res.ok) {
    throw new Error(`Could not load Tracked Codes report input page (${res.status})`);
  }

  const html = await res.text();
  if (!/RunCaselogsReport/i.test(html)) {
    throw new Error('Tracked Codes report input page did not contain the report form — ACGME session may be expired');
  }
  return { html, reportInputUrl };
}

function parseFormSpec(html) {
  const formMatch = html.match(/<form[^>]*action="([^"]*RunCaselogsReport[^"]*)"[^>]*>([\s\S]*?)<\/form>/i);
  if (!formMatch) throw new Error('Could not find the Tracked Codes report form');

  const action = decodeHtml(formMatch[1]);
  const formHtml = formMatch[2];
  const fields = {};

  const inputRe = /<input\b([^>]*)>/gi;
  let m;
  while ((m = inputRe.exec(formHtml))) {
    const attrs = m[1];
    const name = attrs.match(/\bname="([^"]+)"/i)?.[1];
    if (!name) continue;
    const type = (attrs.match(/\btype="([^"]+)"/i)?.[1] || 'text').toLowerCase();
    const value = decodeHtml(attrs.match(/\bvalue="([^"]*)"/i)?.[1] || '');
    const checked = /\bchecked(?:="checked")?\b/i.test(attrs);
    if ((type === 'radio' || type === 'checkbox') && !checked) continue;
    fields[name] = value;
  }

  const selectRe = /<select\b([^>]*)>([\s\S]*?)<\/select>/gi;
  while ((m = selectRe.exec(formHtml))) {
    const attrs = m[1];
    const name = attrs.match(/\bname="([^"]+)"/i)?.[1];
    if (!name) continue;
    const optionsHtml = m[2];
    const opts = [...optionsHtml.matchAll(/<option\b([^>]*)>([\s\S]*?)<\/option>/gi)];
    if (!opts.length) continue;
    const selected = opts.find(o => /\bselected(?:="selected")?\b/i.test(o[1])) || opts[0];
    const value = decodeHtml(selected[1].match(/\bvalue="([^"]*)"/i)?.[1] || '');
    fields[name] = value;
  }

  fields.ReportFormat = 'EXCEL';
  return {
    actionUrl: action.startsWith('http') ? action : `${ACGME_ORIGIN}${action}`,
    fields,
  };
}

async function runTrackedCodesReport(cookieHeader, formSpec, reportInputUrl) {
  const body = new URLSearchParams();
  Object.entries(formSpec.fields).forEach(([k, v]) => body.set(k, v == null ? '' : String(v)));

  const res = await fetch(formSpec.actionUrl, {
    method: 'POST',
    headers: {
      'User-Agent': UA,
      'Cookie': cookieHeader,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'application/vnd.ms-excel,application/octet-stream,*/*',
      'Origin': ACGME_ORIGIN,
      'Referer': reportInputUrl,
    },
    body: body.toString(),
    redirect: 'follow',
  });

  if (!res.ok) throw new Error(`Tracked Codes report generation failed (${res.status})`);

  const buffer = await res.buffer();
  if (!buffer || !buffer.length) throw new Error('Tracked Codes report returned an empty file');

  return buffer;
}

/**
 * Parse the Tracked Codes Excel workbook.
 * Returns [{ code, description, area }] — one entry per tracked CPT code.
 * Column layout (0-indexed): varies; we detect by header row.
 */
function parseTrackedCodesWorkbook(buffer) {
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) throw new Error('Tracked Codes workbook had no sheets');

  const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, defval: '' });
  if (!rows.length) throw new Error('Tracked Codes workbook had no rows');

  // Find the header row — look for a row containing "Code" and "Description"
  let headerIdx = -1;
  let codeCol = -1, descCol = -1, areaCol = -1;

  for (let i = 0; i < Math.min(rows.length, 20); i++) {
    const row = rows[i].map(c => cleanText(c).toLowerCase());
    const codeI = row.findIndex(c => c === 'code' || c === 'cpt code' || c === 'procedure code');
    const descI = row.findIndex(c => c.includes('description') || c === 'procedure name');
    const areaI = row.findIndex(c => c.includes('area') || c.includes('type') || c.includes('category'));
    if (codeI >= 0 && descI >= 0) {
      headerIdx = i;
      codeCol = codeI;
      descCol = descI;
      areaCol = areaI >= 0 ? areaI : -1;
      break;
    }
  }

  // Fallback: assume columns 0=area, 1=code, 2=description (common ACGME layout)
  if (headerIdx < 0) {
    headerIdx = 0;
    areaCol = 0;
    codeCol = 1;
    descCol = 2;
  }

  const codes = [];
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const row = rows[i];
    const code = cleanText(row[codeCol]);
    const description = cleanText(row[descCol]);
    if (!code || !description || !/^\d{4,5}[A-Z]?$/.test(code)) continue;
    const area = areaCol >= 0 ? cleanText(row[areaCol]) : '';
    codes.push({ code, description, area });
  }

  return codes;
}

/**
 * Full orchestration: fetch → parse form → POST → parse Excel.
 * Returns [{ code, description, area }].
 */
async function generateTrackedCodes(cookieHeader) {
  const { html, reportInputUrl } = await fetchTrackedCodesInputPage(cookieHeader);
  const formSpec = parseFormSpec(html);
  const buffer = await runTrackedCodesReport(cookieHeader, formSpec, reportInputUrl);
  return parseTrackedCodesWorkbook(buffer);
}

module.exports = { generateTrackedCodes };
