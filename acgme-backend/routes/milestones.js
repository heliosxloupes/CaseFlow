const express = require('express');
const router = express.Router();
const db = require('../db');
const pw = require('../services/playwrightService');
const { generateMilestonesReport, REPORT_NAME, cacheReportNameForSpecialty } = require('../services/milestonesService');
const { logActivity } = require('../services/logService');

async function getMilestonesSession(userId) {
  const cookieHeader = await pw.getValidCookieHeader(userId);
  if (cookieHeader) return cookieHeader;
  throw new Error(
    'No active ACGME session. Open Settings → ACGME Account, save credentials, and complete verification — then try again.'
  );
}

async function getUserSpecialty(userId) {
  const { rows } = await db.query('SELECT specialty FROM users WHERE id = $1 LIMIT 1', [userId]);
  return rows[0]?.specialty || 'plastic-surgery';
}

router.get('/latest', async (req, res, next) => {
  try {
    const specialty = await getUserSpecialty(req.userId);
    const reportCacheKey = cacheReportNameForSpecialty(specialty);
    const { rows } = await db.query(
      `SELECT report_data, generated_at, report_name
       FROM user_milestones_cache
        WHERE user_id = $1 AND report_name = $2
        LIMIT 1`,
      [req.userId, reportCacheKey]
    );

    if (!rows.length || !rows[0].report_data) {
      return res.status(404).json({ error: 'No Milestones report generated yet' });
    }

    const data = rows[0].report_data;
    if (!data.generatedAt && rows[0].generated_at) data.generatedAt = rows[0].generated_at;
    res.json(data);
  } catch (err) {
    next(err);
  }
});

router.post('/generate', async (req, res, next) => {
  try {
    const specialty = await getUserSpecialty(req.userId);
    const reportCacheKey = cacheReportNameForSpecialty(specialty);
    const cookieHeader = await getMilestonesSession(req.userId);
    const report = await generateMilestonesReport(cookieHeader, specialty);

    await db.query(
      `INSERT INTO user_milestones_cache (user_id, report_name, report_data, generated_at, updated_at)
       VALUES ($1, $2, $3::jsonb, NOW(), NOW())
       ON CONFLICT (user_id, report_name)
       DO UPDATE SET report_data = EXCLUDED.report_data, generated_at = NOW(), updated_at = NOW()`,
      [req.userId, reportCacheKey, JSON.stringify(report)]
    );

    await logActivity({
      userId: req.userId,
      userEmail: req.userEmail,
      eventType: 'milestones.generate',
      message: 'Generated milestones report',
      context: {
        reportName: reportCacheKey,
        sourceReportName: report.sourceReportName || REPORT_NAME,
        specialty,
        categoryCount: Array.isArray(report.categories) ? report.categories.length : 0,
      },
    });

    res.json(report);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
