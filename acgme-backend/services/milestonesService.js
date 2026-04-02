const fetch = require('node-fetch');
const XLSX = require('xlsx');

const ACGME_ORIGIN = 'https://apps.acgme.org';
const REPORT_INPUT_URL = `${ACGME_ORIGIN}/ads/CaseLogs/Reports/GetReportInput`;
const REPORT_NAME = 'ResMinimumDefCat360';
const REPORT_TITLE = 'Integrated-Plastic Surgery Minimum ';
const REPORT_DESCRIPTION = 'Tracks progress toward achieving the RRC-designated minimum expectations for graduation. The RRC only reviews procedures performed in the role of Surgeon.';
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

function asNumber(v) {
  if (v == null || v === '') return 0;
  const n = Number(String(v).replace(/,/g, '').trim());
  return Number.isFinite(n) ? n : 0;
}

function statusBucket(completed, minimum) {
  if (completed >= minimum) return 'complete';
  const pct = minimum > 0 ? completed / minimum : 0;
  return pct < 0.5 ? 'at-risk' : 'in-progress';
}

function buildReportInputUrl() {
  const q = new URLSearchParams({
    reportName: REPORT_NAME,
    reportTitle: REPORT_TITLE,
    reportDescription: REPORT_DESCRIPTION,
    hasParameters: 'True',
    isArchiveReport: 'False',
  });
  return `${REPORT_INPUT_URL}?${q.toString()}`;
}

async function fetchReportInputPage(cookieHeader) {
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
    throw new Error(`Could not load Milestones report input page (${res.status})`);
  }

  const html = await res.text();
  if (!/RunCaselogsReport/i.test(html)) {
    throw new Error('Milestones report input page did not contain the report form');
  }
  return { html, reportInputUrl };
}

function parseFormSpec(html) {
  const formMatch = html.match(/<form[^>]*action="([^"]*RunCaselogsReport[^"]*)"[^>]*>([\s\S]*?)<\/form>/i);
  if (!formMatch) {
    throw new Error('Could not find the Milestones report form');
  }

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

async function runMilestonesReport(cookieHeader, formSpec, reportInputUrl) {
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

  if (!res.ok) {
    throw new Error(`Milestones report generation failed (${res.status})`);
  }

  const contentType = String(res.headers.get('content-type') || '').toLowerCase();
  const buffer = await res.buffer();
  if (!buffer || !buffer.length) {
    throw new Error('Milestones report returned an empty file');
  }

  return { buffer, contentType };
}

function parseMilestonesWorkbook(buffer) {
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) throw new Error('Milestones workbook had no sheets');

  const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, defval: '' });
  if (!rows.length) throw new Error('Milestones workbook had no rows');

  const reportTitle = cleanText(rows.find(r => cleanText(r[2]).includes('Minimum'))?.[2] || REPORT_TITLE.trim());
  const residentLine = cleanText(rows.find(r => /^Resident:/i.test(cleanText(r[2])))?.[2] || '');
  const residentName = residentLine.replace(/^Resident:\s*/i, '').trim() || 'Resident';
  const asOfLine = cleanText(rows.find(r => /^As of /i.test(cleanText(r[2])))?.[2] || '');
  const sourceAsOf = asOfLine.replace(/^As of\s*/i, '').trim();
  const specialtyCode = cleanText((rows.find(r => /Program\s*-\s*\d+/.test(cleanText(r[2])))?.[2] || '').match(/Program\s*-\s*(\d+)/i)?.[1] || '');

  const categories = [];
  let section = '';

  for (const row of rows) {
    const label = cleanText(row[1]);
    const minimum = asNumber(row[3]);
    const completed = asNumber(row[4]);
    if (!label) continue;
    if (label === 'RECONSTRUCTIVE PROCEDURES' || label === 'AESTHETIC PROCEDURES' || label === 'OTHER PROCEDURES') continue;
    if (label === 'Total') continue;
    if (minimum === 0 && completed === 0) {
      if (!/resident|surgeon|all patient types|as of/i.test(label)) {
        section = label;
      }
      continue;
    }

    const remaining = Math.max(minimum - completed, 0);
    const completionPct = minimum > 0 ? Math.min((completed / minimum) * 100, 100) : (completed > 0 ? 100 : 0);
    categories.push({
      section,
      categoryName: label,
      completed,
      minimumRequired: minimum,
      remaining,
      completionPct: Number(completionPct.toFixed(1)),
      status: statusBucket(completed, minimum),
    });
  }

  if (!categories.length) {
    throw new Error('Milestones workbook did not contain any milestone categories');
  }

  const completeCount = categories.filter(c => c.status === 'complete').length;
  const incompleteCount = categories.length - completeCount;
  const atRiskCount = categories.filter(c => c.status === 'at-risk').length;
  const totalMinimum = categories.reduce((sum, c) => sum + c.minimumRequired, 0);
  const totalCompleted = categories.reduce((sum, c) => sum + Math.min(c.completed, c.minimumRequired || c.completed), 0);
  const totalRemaining = categories.reduce((sum, c) => sum + c.remaining, 0);
  const overallCompletionPct = totalMinimum > 0 ? Number(Math.min((totalCompleted / totalMinimum) * 100, 100).toFixed(1)) : 0;

  return {
    residentName,
    reportTitle,
    specialtyCode,
    sourceAsOf,
    categories,
    summary: {
      totalCategories: categories.length,
      completeCategories: completeCount,
      incompleteCategories: incompleteCount,
      atRiskCategories: atRiskCount,
      totalMinimum,
      totalCompleted,
      totalRemaining,
      overallCompletionPct,
    },
  };
}

async function generateMilestonesReport(cookieHeader) {
  const { html, reportInputUrl } = await fetchReportInputPage(cookieHeader);
  const formSpec = parseFormSpec(html);
  const { buffer } = await runMilestonesReport(cookieHeader, formSpec, reportInputUrl);
  const parsed = parseMilestonesWorkbook(buffer);
  return {
    residentName: parsed.residentName,
    reportTitle: parsed.reportTitle,
    specialtyCode: parsed.specialtyCode,
    sourceAsOf: parsed.sourceAsOf,
    generatedAt: new Date().toISOString(),
    sourceFormat: 'EXCEL',
    summary: parsed.summary,
    categories: parsed.categories,
  };
}

module.exports = {
  REPORT_NAME,
  generateMilestonesReport,
};
