const db = require('../db');

function safeContext(context) {
  if (!context || typeof context !== 'object') return {};
  const clone = { ...context };
  // Avoid storing secrets if callers accidentally pass them.
  delete clone.password;
  delete clone.acgmePassword;
  delete clone.token;
  delete clone.authorization;
  return clone;
}

async function logError({
  userId = null,
  userEmail = null,
  source = 'server',
  severity = 'error',
  message,
  stack = null,
  route = null,
  method = null,
  context = {},
}) {
  if (!message) return;
  try {
    await db.query(
      `INSERT INTO error_logs
         (user_id, user_email, source, severity, message, stack, route, method, context_json, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,NOW())`,
      [
        userId,
        userEmail,
        source,
        severity,
        String(message).slice(0, 4000),
        stack ? String(stack).slice(0, 12000) : null,
        route ? String(route).slice(0, 255) : null,
        method ? String(method).slice(0, 16) : null,
        JSON.stringify(safeContext(context)),
      ]
    );
  } catch (err) {
    console.error('[logService] logError failed:', err.message);
  }
}

async function logActivity({
  userId = null,
  userEmail = null,
  eventType,
  message = null,
  context = {},
}) {
  if (!eventType) return;
  try {
    await db.query(
      `INSERT INTO activity_logs
         (user_id, user_email, event_type, message, context_json, created_at)
       VALUES ($1,$2,$3,$4,$5::jsonb,NOW())`,
      [
        userId,
        userEmail,
        String(eventType).slice(0, 80),
        message ? String(message).slice(0, 2000) : null,
        JSON.stringify(safeContext(context)),
      ]
    );
  } catch (err) {
    console.error('[logService] logActivity failed:', err.message);
  }
}

module.exports = {
  logError,
  logActivity,
};
