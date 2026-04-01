const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/authenticate');
const { logError, logActivity } = require('../services/logService');

router.post('/client', authenticate, async (req, res) => {
  const {
    message,
    stack,
    source = 'client',
    severity = 'error',
    context = {},
  } = req.body || {};

  if (!message) {
    return res.status(400).json({ error: 'message is required' });
  }

  await logError({
    userId: req.userId,
    userEmail: req.userEmail,
    source,
    severity,
    message,
    stack,
    route: req.headers['x-client-route'] || null,
    method: 'CLIENT',
    context,
  });

  return res.json({ success: true });
});

router.post('/feedback', authenticate, async (req, res) => {
  const { note, context = {} } = req.body || {};
  const trimmed = String(note || '').trim();
  if (!trimmed) return res.status(400).json({ error: 'Feedback note is required.' });

  await logActivity({
    userId: req.userId,
    userEmail: req.userEmail,
    eventType: 'feedback.reported',
    message: trimmed,
    context,
  });
  await logError({
    userId: req.userId,
    userEmail: req.userEmail,
    source: 'client-feedback',
    severity: 'info',
    message: trimmed,
    context,
  });

  return res.json({ success: true });
});

module.exports = router;
