function errorHandler(err, req, res, next) {
  console.error(`[${new Date().toISOString()}] Error:`, err.message);

  if (err.message.includes('Login failed') || err.message.includes('credentials')) {
    return res.status(401).json({ error: err.message });
  }
  if (err.message.includes('Missing required')) {
    return res.status(400).json({ error: err.message });
  }

  res.status(500).json({ error: err.message });
}

module.exports = { errorHandler };
