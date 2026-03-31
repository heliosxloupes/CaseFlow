const express = require('express');
const router = express.Router();
const db = require('../db');
const pw = require('../services/playwrightService');
const { generateMilestonesReport, REPORT_NAME } = require('../services/milestonesService');

async function getMilestonesSession(userId) {
  const cookieHeader = await pw.getValidCookieHeader(userId);
  if (cookieHeader) return cookieHeader;
  throw new Error(
    'No active ACGME session. Open Settings → ACGME Account, save credentials, and complete verification — then try again.'
  );
}

router.get('/latest', async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT report_data, generated_at, report_name
       FROM user_milestones_cache
       WHERE user_id = $1 AND report_name = $2
       LIMIT 1`,
      [req.userId, REPORT_NAME]
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
    const cookieHeader = await getMilestonesSession(req.userId);
    const report = await generateMilestonesReport(cookieHeader);

    await db.query(
      `INSERT INTO user_milestones_cache (user_id, report_name, report_data, generated_at, updated_at)
       VALUES ($1, $2, $3::jsonb, NOW(), NOW())
       ON CONFLICT (user_id, report_name)
       DO UPDATE SET report_data = EXCLUDED.report_data, generated_at = NOW(), updated_at = NOW()`,
      [req.userId, REPORT_NAME, JSON.stringify(report)]
    );

    res.json(report);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
