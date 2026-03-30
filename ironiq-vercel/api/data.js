/**
 * /api/data.js
 * Serves the full XLDATA payload (cast chemistry, slag, gas, MA sheets).
 * Protected by x-api-token header — never exposed in frontend source.
 */

const path = require('path');
const fs   = require('fs');
const { verifyToken } = require('./auth');

// Load once at cold-start (Vercel caches between invocations)
let _cache = null;
function getData() {
  if (!_cache) {
    const filePath = path.join(process.cwd(), 'data', 'xldata.json');
    _cache = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  }
  return _cache;
}

module.exports = function handler(req, res) {
  // ── CORS pre-flight
  res.setHeader('Access-Control-Allow-Origin',  process.env.ALLOWED_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'x-api-token');
  if (req.method === 'OPTIONS') return res.status(204).end();

  // ── Only GET allowed
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  // ── Token guard
  const token = req.headers['x-api-token'];
  const validSessionToken = process.env.JWT_SECRET && verifyToken(token, process.env.JWT_SECRET);
  const validApiSecret    = process.env.API_SECRET && token === process.env.API_SECRET;
  if (!token || (!validSessionToken && !validApiSecret)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // ── Security headers
  res.setHeader('Cache-Control',           'no-store, no-cache, must-revalidate');
  res.setHeader('X-Content-Type-Options',  'nosniff');
  res.setHeader('X-Frame-Options',         'DENY');
  res.setHeader('Content-Type',            'application/json');

  try {
    return res.status(200).json(getData());
  } catch (err) {
    console.error('[/api/data] Error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
