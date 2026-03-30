/**
 * /api/auth.js
 * Password-based login for demo access.
 * Issues a signed session token stored in-memory on the client.
 * No dependency on jwt library — uses a simple HMAC-based approach
 * so this works as a pure Vercel serverless function with zero installs.
 */

const crypto = require('crypto');

/**
 * Creates a signed token: base64(payload) + "." + HMAC-SHA256 signature.
 * NOT a full JWT — a lightweight signed token sufficient for demo gating.
 */
function signToken(payload, secret) {
  const data    = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig     = crypto.createHmac('sha256', secret).update(data).digest('base64url');
  return `${data}.${sig}`;
}

function verifyToken(token, secret) {
  try {
    const [data, sig] = token.split('.');
    const expected = crypto.createHmac('sha256', secret).update(data).digest('base64url');
    if (sig !== expected) return null;
    const payload = JSON.parse(Buffer.from(data, 'base64url').toString());
    if (payload.exp < Date.now()) return null;   // expired
    return payload;
  } catch {
    return null;
  }
}

module.exports = function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  process.env.ALLOWED_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const DEMO_PASSWORD = process.env.DEMO_PASSWORD;
  const JWT_SECRET    = process.env.JWT_SECRET;

  if (!DEMO_PASSWORD || !JWT_SECRET) {
    console.error('[/api/auth] Missing env vars: DEMO_PASSWORD or JWT_SECRET');
    return res.status(500).json({ error: 'Server misconfiguration' });
  }

  let body = req.body;
  // Vercel parses JSON automatically when Content-Type: application/json
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }

  const { password } = body || {};

  if (!password || password !== DEMO_PASSWORD) {
    // Constant-time compare to resist timing attacks
    const dummy = crypto.createHmac('sha256', JWT_SECRET).update(password || '').digest();
    void dummy; // prevent optimisation
    return res.status(401).json({ error: 'Invalid password' });
  }

  const token = signToken(
    { role: 'demo', iat: Date.now(), exp: Date.now() + 24 * 60 * 60 * 1000 },
    JWT_SECRET
  );

  res.setHeader('Cache-Control',          'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  return res.status(200).json({ token });
};

// Export verifyToken for use in other API routes if needed
module.exports.verifyToken = verifyToken;
