/**
 * CaseFlow — Auth endpoint
 *
 * POST /api/auth   { email, password }
 *   → 200 { token }   — JWT valid for 30 days
 *   → 401 { error }   — wrong credentials
 *   → 500 { error }   — env vars not set
 *
 * Required Vercel env vars:
 *   AUTH_EMAIL   — your login email
 *   AUTH_PASS    — your login password
 *   JWT_SECRET   — any long random string (openssl rand -hex 32)
 */

const jwt = require('jsonwebtoken');

module.exports = function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { email = '', password = '' } = req.body || {};
  const validEmail  = process.env.AUTH_EMAIL;
  const validPass   = process.env.AUTH_PASS;
  const secret      = process.env.JWT_SECRET || 'caseflow-dev-secret-change-me';

  if (!validEmail || !validPass) {
    return res.status(500).json({
      error: 'Auth not configured. Add AUTH_EMAIL, AUTH_PASS, and JWT_SECRET to your Vercel environment variables.'
    });
  }

  if (email.toLowerCase() !== validEmail.toLowerCase() || password !== validPass) {
    return res.status(401).json({ error: 'Incorrect email or password.' });
  }

  const token = jwt.sign({ email: validEmail }, secret, { expiresIn: '30d' });
  return res.status(200).json({ token });
};
