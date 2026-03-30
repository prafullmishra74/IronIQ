/**
 * /api/score.js
 * Server-side scoring engine for Hot Metal and Slag quality.
 * Thresholds, weights, and business logic NEVER reach the client.
 *
 * POST /api/score
 * Body: { type: "hm" | "slag" | "gas", values: { ... } }
 * Returns: { score, grade, flags, recommendation }
 */

const path    = require('path');
const fs      = require('fs');
const crypto  = require('crypto');
const { verifyToken } = require('./auth');

// ── Load operational parameter thresholds (server-side only)
let _params = null;
function getParams() {
  if (!_params) {
    const fp = path.join(process.cwd(), 'data', 'params.json');
    _params = JSON.parse(fs.readFileSync(fp, 'utf8'));
  }
  return _params;
}

// ── Chemical specification ranges (embedded server-side — never sent to browser)
const HM_RANGES = {
  C:    { lo: 3.5,   hi: 4.8,   wt: 1.5, label: 'Carbon %'         },
  Si:   { lo: 0.05,  hi: 1.3,   wt: 1.2, label: 'Silicon %'        },
  S:    { lo: 0.015, hi: 0.09,  wt: 2.0, label: 'Sulphur %'        },
  P:    { lo: 0.1,   hi: 0.13,  wt: 1.8, label: 'Phosphorus %'     },
  Ti:   { lo: 0.005, hi: 0.085, wt: 1.0, label: 'Titanium %'       },
  Mn:   { lo: 0.2,   hi: 0.35,  wt: 1.0, label: 'Manganese %'      },
  temp: { lo: 1400,  hi: 1500,  wt: 2.5, label: 'HM Temperature °C'},
};

const SLAG_RANGES = {
  CaO:   { lo: 26,   hi: 40,   wt: 1.5, label: 'CaO %'    },
  SiO2:  { lo: 26,   hi: 40,   wt: 1.5, label: 'SiO₂ %'   },
  Al2O3: { lo: 16,   hi: 19,   wt: 1.2, label: 'Al₂O₃ %'  },
  MgO:   { lo: 6.5,  hi: 10,   wt: 1.0, label: 'MgO %'    },
  FeO:   { lo: 0.5,  hi: 1.5,  wt: 1.8, label: 'FeO %'    },
  S:     { lo: 0.5,  hi: 1.0,  wt: 1.6, label: 'S %'      },
  B2:    { lo: 0.75, hi: 1.15, wt: 2.0, label: 'B2 Ratio'  },
};

const GAS_RANGES = {
  CO:     { lo: 20,   hi: 25,   wt: 1.5, label: 'CO %'        },
  CO2:    { lo: 17,   hi: 19,   wt: 1.5, label: 'CO₂ %'       },
  H2:     { lo: 2.1,  hi: 5.0,  wt: 1.0, label: 'H₂ %'        },
  O2:     { lo: 0.5,  hi: 1.2,  wt: 1.2, label: 'O₂ %'        },
  ratio:  { lo: 1.05, hi: 1.40, wt: 2.0, label: 'CO/CO₂ Ratio'},
};

// ── Grade mapping
function getGrade(score) {
  if (score >= 90) return { grade: 'A', color: '#00e676', label: 'Excellent' };
  if (score >= 75) return { grade: 'B', color: '#00c9b1', label: 'Good'      };
  if (score >= 60) return { grade: 'C', color: '#ffc642', label: 'Marginal'  };
  if (score >= 40) return { grade: 'D', color: '#ff9100', label: 'Poor'      };
  return                  { grade: 'F', color: '#ff5252', label: 'Critical'  };
}

// ── Core scoring engine
function scoreValues(values, ranges) {
  const flags = [];
  let totalWeight = 0;
  let weightedScore = 0;

  for (const [key, spec] of Object.entries(ranges)) {
    const raw = values[key];
    if (raw === undefined || raw === null || raw === '') continue;
    const v = parseFloat(raw);
    if (isNaN(v)) continue;

    totalWeight += spec.wt;

    if (v < spec.lo) {
      const pctLow = ((spec.lo - v) / (spec.hi - spec.lo)) * 100;
      const penalty = Math.min(100, pctLow * spec.wt);
      weightedScore += Math.max(0, spec.wt * 100 - penalty) ;
      flags.push({
        param: key, label: spec.label, value: v,
        low: spec.lo, high: spec.hi,
        status: 'LOW', severity: pctLow > 20 ? 'critical' : pctLow > 10 ? 'warning' : 'minor',
        message: `${spec.label} (${v}) is below target range [${spec.lo}–${spec.hi}]`
      });
    } else if (v > spec.hi) {
      const pctHigh = ((v - spec.hi) / (spec.hi - spec.lo)) * 100;
      const penalty = Math.min(100, pctHigh * spec.wt);
      weightedScore += Math.max(0, spec.wt * 100 - penalty);
      flags.push({
        param: key, label: spec.label, value: v,
        low: spec.lo, high: spec.hi,
        status: 'HIGH', severity: pctHigh > 20 ? 'critical' : pctHigh > 10 ? 'warning' : 'minor',
        message: `${spec.label} (${v}) is above target range [${spec.lo}–${spec.hi}]`
      });
    } else {
      // In range — score by proximity to centre
      const centre = (spec.lo + spec.hi) / 2;
      const halfRange = (spec.hi - spec.lo) / 2;
      const centrality = 1 - Math.abs(v - centre) / halfRange;
      weightedScore += spec.wt * (80 + centrality * 20); // 80-100 if in range
    }
  }

  const rawScore = totalWeight > 0 ? weightedScore / totalWeight : 0;
  const score    = Math.round(Math.max(0, Math.min(100, rawScore)));
  return { score, flags };
}

// ── Generate recommendation text
function buildRecommendation(type, flags, score) {
  if (flags.length === 0) return `All ${type.toUpperCase()} parameters within specification. Process is stable.`;

  const critical = flags.filter(f => f.severity === 'critical');
  const warnings = flags.filter(f => f.severity === 'warning');

  const lines = [];
  if (critical.length) {
    lines.push(`⚠️ CRITICAL: ${critical.map(f => f.label).join(', ')} requires immediate attention.`);
  }
  if (warnings.length) {
    lines.push(`⚡ WARNING: ${warnings.map(f => f.label).join(', ')} trending out of spec.`);
  }

  // Type-specific advice
  if (type === 'hm') {
    const s = flags.find(f => f.param === 'S' && f.status === 'HIGH');
    if (s) lines.push('💡 High sulphur — check burden composition and blast moisture.');
    const t = flags.find(f => f.param === 'temp' && f.status === 'LOW');
    if (t) lines.push('💡 Low HM temp — consider increasing PCI rate or reducing burden moisture.');
  }
  if (type === 'slag') {
    const b2 = flags.find(f => f.param === 'B2');
    if (b2) lines.push(`💡 B2 ratio ${b2.status === 'LOW' ? 'too low — increase limestone addition' : 'too high — reduce flux addition'}.`);
  }
  if (type === 'gas') {
    const ratio = flags.find(f => f.param === 'ratio' && f.status === 'LOW');
    if (ratio) lines.push('💡 Low CO/CO₂ — indirect reduction efficiency declining. Check burden distribution.');
  }

  return lines.join(' ');
}

// ── Params scoring (for live 5-second parameter OOR check)
function scoreParams(values) {
  const params  = getParams();
  const flags   = [];
  let oor       = 0;

  for (const p of params) {
    const v = parseFloat(values[p.sno]);
    if (isNaN(v)) continue;
    if (v < p.lower || v > p.upper) {
      oor++;
      flags.push({
        sno: p.sno, param: p.param, unit: p.unit,
        value: v, lower: p.lower, upper: p.upper,
        status: v < p.lower ? 'LOW' : 'HIGH'
      });
    }
  }

  const total = params.filter(p => values[p.sno] !== undefined).length;
  const score = total > 0 ? Math.round(((total - oor) / total) * 100) : 100;
  return { score, flags, oor, total };
}

// ── Main handler
module.exports = function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  process.env.ALLOWED_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,x-api-token');
  if (req.method === 'OPTIONS') return res.status(204).end();

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Token guard
  const token = req.headers['x-api-token'];
  const validSessionToken = process.env.JWT_SECRET && verifyToken(token, process.env.JWT_SECRET);
  const validApiSecret    = process.env.API_SECRET && token === process.env.API_SECRET;
  if (!token || (!validSessionToken && !validApiSecret)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  res.setHeader('Cache-Control',          'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { return res.status(400).json({ error: 'Invalid JSON' }); }
  }

  const { type, values } = body || {};
  if (!type || !values) return res.status(400).json({ error: 'Missing type or values' });

  try {
    let result;
    const RANGE_MAP = { hm: HM_RANGES, slag: SLAG_RANGES, gas: GAS_RANGES };

    if (type === 'params') {
      const { score, flags, oor, total } = scoreParams(values);
      const gradeInfo = getGrade(score);
      result = { score, oor, total, ...gradeInfo, flags,
        recommendation: `${oor} of ${total} parameters out of range.` };
    } else if (RANGE_MAP[type]) {
      const { score, flags } = scoreValues(values, RANGE_MAP[type]);
      const gradeInfo        = getGrade(score);
      const recommendation   = buildRecommendation(type, flags, score);
      result = { score, ...gradeInfo, flags, recommendation };
    } else {
      return res.status(400).json({ error: `Unknown type: ${type}. Use hm | slag | gas | params` });
    }

    return res.status(200).json(result);
  } catch (err) {
    console.error('[/api/score] Error:', err);
    return res.status(500).json({ error: 'Scoring engine error' });
  }
};
