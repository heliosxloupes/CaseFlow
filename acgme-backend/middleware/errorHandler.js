const { logError } = require('../services/logService');

function errorHandler(err, req, res, next) {
  console.error(`[${new Date().toISOString()}] Error:`, err.message);
  logError({
    userId: req && req.userId ? req.userId : null,
    userEmail: req && req.userEmail ? req.userEmail : null,
    source: 'server',
    severity: 'error',
    message: err.message,
    stack: err.stack,
    route: req ? req.originalUrl : null,
    method: req ? req.method : null,
    context: {
      name: err.name || null,
    },
  });

  if (err.message.includes('Login failed') || err.message.includes('credentials')) {
    return res.status(401).json({ error: err.message });
  }
  if (err.message.includes('No active ACGME session') || err.message.includes('not authenticated')) {
    return res.status(401).json({ error: err.message });
  }
  if (err.message.includes('Missing required')) {
    return res.status(400).json({ error: err.message });
  }

  res.status(500).json({ error: err.message });
}

module.exports = { errorHandler };
