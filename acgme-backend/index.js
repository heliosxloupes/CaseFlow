const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
require('dotenv').config();

const authRoutes = require('./routes/auth');
const caseRoutes = require('./routes/cases');
const lookupRoutes = require('./routes/lookups');
const { errorHandler } = require('./middleware/errorHandler');
const { authenticate } = require('./middleware/authenticate');

const app = express();

app.use(cors({ origin: '*' }));
app.use(express.json());

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
});
app.use(limiter);

app.use('/api/auth', authRoutes);
app.use('/api/cases', authenticate, caseRoutes);
app.use('/api/lookups', authenticate, lookupRoutes);

app.get('/health', (req, res) => res.json({
  status: 'ok',
  jwtConfigured: !!process.env.JWT_SECRET,
  dbConfigured: !!process.env.DATABASE_URL,
  encryptionConfigured: !!process.env.ENCRYPTION_KEY,
}));

// Debug: verify a token without needing a DB — helps diagnose JWT_SECRET mismatches
app.post('/debug/verify-token', (req, res) => {
  const { token } = req.body || {};
  if (!token) return res.status(400).json({ error: 'token required' });
  try {
    const jwt = require('jsonwebtoken');
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    res.json({ valid: true, payload: decoded });
  } catch (err) {
    res.status(401).json({ valid: false, error: err.message });
  }
});

app.use(errorHandler);

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`ACGME backend running on port ${PORT}`));
