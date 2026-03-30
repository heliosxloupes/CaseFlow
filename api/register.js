/**
 * CaseFlow — Registration proxy
 * POST /api/register  { name, email, password }
 * Proxies to the Railway backend for multi-user registration.
 */

const BACKEND = process.env.ACGME_BACKEND_URL || 'https://caseflow-production.up.railway.app';

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const upstream = await fetch(`${BACKEND}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body),
    });
    const data = await upstream.json();
    return res.status(upstream.status).json(data);
  } catch (err) {
    return res.status(502).json({ error: 'Registration service unavailable. Please try again.' });
  }
};
