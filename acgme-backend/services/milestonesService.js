const fetch = require('node-fetch');
const XLSX = require('xlsx');
const { getSpecialty } = require('../config/specialties');

const ACGME_ORIGIN = 'https://apps.acgme.org';
const REPORT_LIST_URL = `${ACGME_ORIGIN}/ads/CaseLogs/Reports/GetReportList`;
const REPORT_INPUT_URL = `${ACGME_ORIGIN}/ads/CaseLogs/Reports/GetReportInput`;
const REPORT_NAME = 'minimum-report-dynamic';
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

function normalizeSpecialtySlug(specialty) {
  return cleanText(specialty || '').toLowerCase() || 'plastic-surgery';
}

function cacheReportNameForSpecialty(specialty) {
  return `${REPORT_NAME}:${normalizeSpecialtySlug(specialty).replace(/[^a-z0-9-]+/g, '-')}`;
}

function asNumber(v) {
  if (v == null || v === '') return null;
  const txt = String(v).replace(/,/g, '').trim();
  if (!txt) return null;
  const n = Number(txt);
  return Number.isFinite(n) ? n : null;
}

function statusBucket(completed, minimum) {
  if (completed >= minimum) return 'complete';
  const pct = minimum > 0 ? completed / minimum : 0;
  return pct < 0.5 ? 'at-risk' : 'in-progress';
}

function fetchHtml(url, cookieHeader, referer = `${ACGME_ORIGIN}/ads/CaseLogs`) {
  return fetch(url, {
    headers: {
      'User-Agent': UA,
      'Cookie': cookieHeader,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Referer': referer,
    },
    redirect: 'follow',
  });
}

async function fetchReportListPage(cookieHeader) {
  const res = await fetchHtml(REPORT_LIST_URL, cookieHeader, `${ACGME_ORIGIN}/ads/CaseLogs`);
  if (!res.ok) {
    throw new Error(`Could not load Milestones report list (${res.status})`);
  }
  return res.text();
}

function parseReportQuery(urlLike = '') {
  const normalized = decodeHtml(urlLike);
  const fullUrl = normalized.startsWith('http') ? normalized : `${ACGME_ORIGIN}${normalized.startsWith('/') ? '' : '/'}${normalized}`;
  const u = new URL(fullUrl);
  const reportName = cleanText(u.searchParams.get('reportName'));
  const reportTitle = cleanText(u.searchParams.get('reportTitle'));
  const reportDescription = cleanText(u.searchParams.get('reportDescription'));
  const hasParameters = cleanText(u.searchParams.get('hasParameters') || 'True') || 'True';
  const isArchiveReport = cleanText(u.searchParams.get('isArchiveReport') || 'False') || 'False';
  if (!reportName || !reportTitle) return null;
  return { reportName, reportTitle, reportDescription, hasParameters, isArchiveReport };
}

function parseAvailableReports(html) {
  const reports = [];
  const seen = new Set();

  const hrefMatches = html.matchAll(/href="([^"]*GetReportInput[^"]*)"/gi);
  for (const match of hrefMatches) {
    const report = parseReportQuery(match[1]);
    if (!report) continue;
    const key = `${report.reportName}|${report.reportTitle}`;
    if (seen.has(key)) continue;
    seen.add(key);
    reports.push(report);
  }

  const jsMatches = html.matchAll(/GetReportInput\?([^"'`<\s]+)/gi);
  for (const match of jsMatches) {
    const report = parseReportQuery(`${REPORT_INPUT_URL}?${match[1]}`);
    if (!report) continue;
    const key = `${report.reportName}|${report.reportTitle}`;
    if (seen.has(key)) continue;
    seen.add(key);
    reports.push(report);
  }

  return reports;
}

function specialtyNeedles(specialty) {
  const meta = getSpecialty(specialty);
  const base = [
    meta.label,
    meta.code.replace(/-/g, ' '),
    meta.code.replace(/-/g, ''),
  ];
  if (meta.code === 'physical-medicine-rehabilitation') {
    base.push('physical medicine', 'rehabilitation', 'pm&r', 'pmr', 'phys med rehab');
  }
  return base.map(s => cleanText(s).toLowerCase()).filter(Boolean);
}

function selectMilestonesReport(reports, specialty) {
  if (!reports.length) return null;
  const needles = specialtyNeedles(specialty);
  const scored = reports.map(report => {
    const title = cleanText(report.reportTitle).toLowerCase();
    const desc = cleanText(report.reportDescription).toLowerCase();
    const haystack = `${title} ${desc}`;
    let score = 0;
    if (/minimum|milestone/.test(haystack)) score += 8;
    if (/resminimum|minimumdef/i.test(report.reportName)) score += 6;
    for (const needle of needles) {
      if (needle && haystack.includes(needle)) score += needle.length >= 8 ? 6 : 3;
    }
    return { report, score };
  }).filter(item => item.score > 0);

  scored.sort((a, b) => b.score - a.score || a.report.reportTitle.localeCompare(b.report.reportTitle));
  return scored[0]?.report || null;
}

function buildReportInputUrl(reportMeta) {
  const q = new URLSearchParams({
    reportName: reportMeta.reportName,
    reportTitle: reportMeta.reportTitle,
    reportDescription: reportMeta.reportDescription || '',
    hasParameters: reportMeta.hasParameters || 'True',
    isArchiveReport: reportMeta.isArchiveReport || 'False',
  });
  return `${REPORT_INPUT_URL}?${q.toString()}`;
}

async function fetchReportInputPage(cookieHeader, reportMeta) {
  const reportInputUrl = buildReportInputUrl(reportMeta);
  const res = await fetchHtml(reportInputUrl, cookieHeader, REPORT_LIST_URL);
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

  const buffer = await res.buffer();
  if (!buffer || !buffer.length) {
    throw new Error('Milestones report returned an empty file');
  }
  return buffer;
}

function flattenRow(row) {
  return row.map(cleanText).filter(Boolean);
}

function inferHeaderSpec(rows) {
  for (let idx = 0; idx < rows.length; idx++) {
    const cells = rows[idx].map(cleanText);
    const normalized = cells.map(c => c.toLowerCase());
    const minimumCol = normalized.findIndex(c => /\bminimum\b|\brequired\b/.test(c));
    const completedCol = normalized.findIndex(c => /\bcompleted\b|\bcount\b|\bresident\b|\byour\b|\btotal\b/.test(c));
    if (minimumCol < 0 || completedCol < 0) continue;
    const labelCandidates = normalized
      .map((c, i) => ({ c, i }))
      .filter(({ c, i }) => i !== minimumCol && i !== completedCol && c && !/\bminimum\b|\brequired\b|\bcompleted\b|\bcount\b|\btotal\b/.test(c));
    const labelCol = labelCandidates.length ? labelCandidates[0].i : 0;
    return { headerRowIndex: idx, labelCol, minimumCol, completedCol };
  }
  return null;
}

function parseWorkbookMetadata(rows) {
  const allCells = rows.flat().map(cleanText).filter(Boolean);
  const reportTitle =
    allCells.find(c => /\bminimum\b|\bmilestone\b/i.test(c) && c.length > 12) ||
    'Milestones Report';
  const residentCell = allCells.find(c => /^resident:/i.test(c)) || '';
  const residentName = residentCell.replace(/^resident:\s*/i, '').trim() || 'Resident';
  const asOfCell = allCells.find(c => /^as of /i.test(c)) || '';
  const sourceAsOf = asOfCell.replace(/^as of\s*/i, '').trim();
  const programCell = allCells.find(c => /program\s*-\s*\d+/i.test(c)) || '';
  const specialtyCode = cleanText(programCell.match(/program\s*-\s*(\d+)/i)?.[1] || '');
  return { reportTitle, residentName, sourceAsOf, specialtyCode };
}

function parseMilestonesWorkbook(buffer) {
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) throw new Error('Milestones workbook had no sheets');

  const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, defval: '' });
  if (!rows.length) throw new Error('Milestones workbook had no rows');

  const metadata = parseWorkbookMetadata(rows);
  const headerSpec = inferHeaderSpec(rows);
  if (!headerSpec) {
    throw new Error('Milestones workbook did not contain recognizable milestone columns');
  }

  const categories = [];
  let section = '';
  const { headerRowIndex, labelCol, minimumCol, completedCol } = headerSpec;

  for (let i = headerRowIndex + 1; i < rows.length; i++) {
    const row = rows[i];
    const label = cleanText(row[labelCol]);
    const minimum = asNumber(row[minimumCol]);
    const completed = asNumber(row[completedCol]);
    const populated = flattenRow(row);
    if (!populated.length) continue;
    if (!label && minimum == null && completed == null) continue;
    if (label && /^total$/i.test(label)) continue;

    if (label && minimum == null && completed == null) {
      if (!/resident|surgeon|all patient types|as of|program/i.test(label)) {
        section = label;
      }
      continue;
    }

    if (!label || minimum == null || completed == null) continue;

    const minVal = Math.max(minimum, 0);
    const completedVal = Math.max(completed, 0);
    const remaining = Math.max(minVal - completedVal, 0);
    const completionPct = minVal > 0 ? Math.min((completedVal / minVal) * 100, 100) : (completedVal > 0 ? 100 : 0);
    categories.push({
      section,
      categoryName: label,
      completed: completedVal,
      minimumRequired: minVal,
      remaining,
      completionPct: Number(completionPct.toFixed(1)),
      status: statusBucket(completedVal, minVal),
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
    ...metadata,
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

async function generateMilestonesReport(cookieHeader, specialty = 'plastic-surgery') {
  const listHtml = await fetchReportListPage(cookieHeader);
  const reports = parseAvailableReports(listHtml);
  const reportMeta = selectMilestonesReport(reports, specialty);
  if (!reportMeta) {
    throw new Error(`Could not find a milestones/minimum report for ${getSpecialty(specialty).label}.`);
  }
  const { html, reportInputUrl } = await fetchReportInputPage(cookieHeader, reportMeta);
  const formSpec = parseFormSpec(html);
  const buffer = await runMilestonesReport(cookieHeader, formSpec, reportInputUrl);
  const parsed = parseMilestonesWorkbook(buffer);
  return {
    residentName: parsed.residentName,
    reportTitle: parsed.reportTitle,
    specialtyCode: parsed.specialtyCode,
    sourceAsOf: parsed.sourceAsOf,
    generatedAt: new Date().toISOString(),
    sourceFormat: 'EXCEL',
    sourceReportName: reportMeta.reportName,
    sourceReportTitle: reportMeta.reportTitle,
    summary: parsed.summary,
    categories: parsed.categories,
  };
}

module.exports = {
  REPORT_NAME,
  cacheReportNameForSpecialty,
  generateMilestonesReport,
};
