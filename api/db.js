/**
 * /api/db.js
 * Serves the DB payload: daily HM trends, burden calc, heat balance,
 * fuel optimisation, anomaly detection, THI history, charge sequence,
 * aerodynamics, Fe-balance, sinter data, and live param seeds.
 * Protected by x-api-token — logic & thresholds stay server-side.
 */

const path = require('path');
const fs   = require('fs');
const { verifyToken } = require('./auth');

let _cache = null;
function getDB() {
  if (!_cache) {
    const dbPath     = path.join(process.cwd(), 'data', 'db.json');
    const paramsPath = path.join(process.cwd(), 'data', 'params.json');
    const db         = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
    // Embed operational parameter thresholds so client gets them in one request
    // These are NOT the scoring thresholds (those stay in score.js) —
    // just the display definitions for the live 5s parameter table
    db.params = JSON.parse(fs.readFileSync(paramsPath, 'utf8'));
    _cache = db;
  }
  return _cache;
}

module.exports = function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  process.env.ALLOWED_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'x-api-token');
  if (req.method === 'OPTIONS') return res.status(204).end();

  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const token = req.headers['x-api-token'];
  const validSessionToken = process.env.JWT_SECRET && verifyToken(token, process.env.JWT_SECRET);
  const validApiSecret    = process.env.API_SECRET && token === process.env.API_SECRET;
  if (!token || (!validSessionToken && !validApiSecret)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  res.setHeader('Cache-Control',          'no-store, no-cache, must-revalidate');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options',        'DENY');
  res.setHeader('Content-Type',           'application/json');

  try {
    return res.status(200).json(getDB());
  } catch (err) {
    console.error('[/api/db] Error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
