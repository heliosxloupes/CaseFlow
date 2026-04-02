const express = require('express');
const router = express.Router();
const db = require('../db');
const { authenticate } = require('../middleware/authenticate');
const { requireAdmin } = require('../middleware/requireAdmin');

router.use(authenticate, requireAdmin);

router.get('/overview', async (req, res, next) => {
  try {
    const usersQ = db.query(
      `SELECT
         u.id,
         u.name,
         u.email,
         u.created_at,
         u.last_login_at,
         u.beta_key_label,
         u.tos_accepted_at,
         COALESCE(err.error_count, 0) AS error_count,
         err.last_error_at,
         COALESCE(act.activity_count, 0) AS activity_count,
         act.last_activity_at
       FROM users u
       LEFT JOIN (
         SELECT user_id, COUNT(*) AS error_count, MAX(created_at) AS last_error_at
         FROM error_logs
         GROUP BY user_id
       ) err ON err.user_id = u.id
       LEFT JOIN (
         SELECT user_id, COUNT(*) AS activity_count, MAX(created_at) AS last_activity_at
         FROM activity_logs
         GROUP BY user_id
       ) act ON act.user_id = u.id
       ORDER BY u.created_at DESC`
    );

    const recentErrorsQ = db.query(
      `SELECT id, user_id, user_email, source, severity, message, route, method, created_at, context_json
         FROM error_logs
        ORDER BY created_at DESC
        LIMIT 100`
    );

    const inviteQ = db.query(
      `SELECT id, invite_key, label, allowed_email, claimed_email, used_at, is_active, expires_at, notes
         FROM beta_invites
        ORDER BY created_at DESC`
    );

    const [usersR, errorsR, invitesR] = await Promise.all([usersQ, recentErrorsQ, inviteQ]);
    res.json({
      users: usersR.rows,
      recentErrors: errorsR.rows,
      invites: invitesR.rows,
    });
  } catch (err) {
    next(err);
  }
});

router.get('/users/:userId/logs', async (req, res, next) => {
  try {
    const userId = Number(req.params.userId);
    if (!Number.isFinite(userId)) {
      return res.status(400).json({ error: 'Invalid user id' });
    }

    const [userR, errorR, activityR] = await Promise.all([
      db.query('SELECT id, name, email, beta_key_label, created_at, last_login_at FROM users WHERE id = $1 LIMIT 1', [userId]),
      db.query(
        `SELECT id, source, severity, message, stack, route, method, context_json, created_at
           FROM error_logs
          WHERE user_id = $1 OR (user_id IS NULL AND user_email = (SELECT email FROM users WHERE id = $1))
          ORDER BY created_at DESC
          LIMIT 300`,
        [userId]
      ),
      db.query(
        `SELECT id, event_type, message, context_json, created_at
           FROM activity_logs
          WHERE user_id = $1 OR (user_id IS NULL AND user_email = (SELECT email FROM users WHERE id = $1))
          ORDER BY created_at DESC
          LIMIT 300`,
        [userId]
      ),
    ]);

    if (!userR.rows.length) return res.status(404).json({ error: 'User not found' });
    res.json({
      user: userR.rows[0],
      errors: errorR.rows,
      activity: activityR.rows,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
