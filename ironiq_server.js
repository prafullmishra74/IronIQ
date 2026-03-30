/**
 * BF IronIQ — Authentication Backend
 * Node.js / Express · Production-ready
 */

'use strict';

const express      = require('express');
const argon2       = require('argon2');
const jwt          = require('jsonwebtoken');
const speakeasy    = require('speakeasy');
const helmet       = require('helmet');
const cors         = require('cors');
const rateLimit    = require('express-rate-limit');
const cookieParser = require('cookie-parser');
const morgan       = require('morgan');
const { v4: uuidv4 } = require('uuid');
require('dotenv').config();

const CONFIG = {
  port:             process.env.PORT            || 3000,
  nodeEnv:          process.env.NODE_ENV         || 'development',
  jwtAccessSecret:  process.env.JWT_ACCESS_SECRET  || 'ironiq_access_secret_change_this_in_production',
  jwtRefreshSecret: process.env.JWT_REFRESH_SECRET || 'ironiq_refresh_secret_change_this_in_production',
  jwtAccessExpiry:  '15m',
  jwtRefreshExpiry: '8h',
  cookieDomain:     process.env.COOKIE_DOMAIN    || 'localhost',
  allowedOrigins:   (process.env.ALLOWED_ORIGINS || 'http://localhost:3000').split(','),
  anthropicApiKey:  process.env.ANTHROPIC_API_KEY || '',
  maxLoginAttempts: 5,
  lockoutMinutes:   15,
};

// ── In-memory user store ──────────────────────────────────────────────────────
const USERS_DB = {
  'admin': {
    userId:       'usr-001',
    username:     'admin',
    displayName:  'Plant Administrator',
    passwordHash: '$argon2id$v=19$m=65536,t=3,p=4$b46h5lCgheYColLU8rJ0Vw$NulXjfH2CuEIGbjfWBsuAyDjzFIRqNbr3IWAG5OKKck',
    role:         'admin',
    plant:        'BF-01',
    mfaEnabled:   false,
    mfaSecret:    process.env.ADMIN_MFA_SECRET || 'JBSWY3DPEHPK3PXP',
    active:       true,
  },
  'operator1': {
    userId:       'usr-002',
    username:     'operator1',
    displayName:  'Shift Operator A',
    passwordHash: '$argon2id$v=19$m=65536,t=3,p=4$naMi+YgQUYWhxMYBZpDNxQ$XBI6RlDkozzlnfpgCQaOZwn6eAkEDS2hphbkfzqwpqw',
    role:         'operator',
    plant:        'BF-01',
    mfaEnabled:   false,
    mfaSecret:    process.env.OP1_MFA_SECRET || 'JBSWY3DPEHPK3PXP',
    active:       true,
  },
};

const ROLE_PERMISSIONS = {
  viewer:   ['read:dashboard', 'read:trends', 'read:alarms'],
  operator: ['read:dashboard', 'read:trends', 'read:alarms', 'write:simulation', 'use:ai'],
  engineer: ['read:dashboard', 'read:trends', 'read:alarms', 'write:simulation', 'use:ai', 'write:params'],
  admin:    ['*'],
};

// ── Audit log ─────────────────────────────────────────────────────────────────
const auditLog = [];
function audit(eventType, data) {
  const entry = { id: uuidv4(), timestamp: new Date().toISOString(), event: eventType, ...data };
  auditLog.push(entry);
  console.log(`[AUDIT] ${entry.timestamp} | ${eventType} | user=${data.username||'-'} | ip=${data.ip||'-'}`);
  return entry;
}

// ── Failed attempt tracking ───────────────────────────────────────────────────
const failedAttempts = new Map();

function getAttemptKey(username, ip) { return `${username}|${ip}`; }

function recordFailure(username, ip) {
  const key = getAttemptKey(username, ip);
  const rec = failedAttempts.get(key) || { count: 0, lockedUntil: null };
  rec.count++;
  if (rec.count >= CONFIG.maxLoginAttempts) {
    rec.lockedUntil = Date.now() + CONFIG.lockoutMinutes * 60 * 1000;
  }
  failedAttempts.set(key, rec);
  return rec;
}

function isLocked(username, ip) {
  const key = getAttemptKey(username, ip);
  const rec = failedAttempts.get(key);
  if (!rec || !rec.lockedUntil) return false;
  if (Date.now() > rec.lockedUntil) { failedAttempts.delete(key); return false; }
  return rec;
}

function clearFailures(username, ip) { failedAttempts.delete(getAttemptKey(username, ip)); }

// ── JWT helpers ───────────────────────────────────────────────────────────────
function signAccessToken(payload) {
  return jwt.sign(payload, CONFIG.jwtAccessSecret, { expiresIn: CONFIG.jwtAccessExpiry, issuer: 'ironiq-auth', audience: 'ironiq-app' });
}
function signRefreshToken(payload) {
  return jwt.sign(payload, CONFIG.jwtRefreshSecret, { expiresIn: CONFIG.jwtRefreshExpiry, issuer: 'ironiq-auth', audience: 'ironiq-refresh' });
}
function verifyAccessToken(token) {
  return jwt.verify(token, CONFIG.jwtAccessSecret, { issuer: 'ironiq-auth', audience: 'ironiq-app' });
}
function verifyRefreshToken(token) {
  return jwt.verify(token, CONFIG.jwtRefreshSecret, { issuer: 'ironiq-auth', audience: 'ironiq-refresh' });
}

function cookieOpts(maxAgeMs) {
  return { httpOnly: true, secure: CONFIG.nodeEnv === 'production', sameSite: 'strict', domain: CONFIG.cookieDomain, maxAge: maxAgeMs, path: '/' };
}

function issueTokens(res, user) {
  const sessionId = uuidv4();
  const payload = { sub: user.userId, username: user.username, role: user.role, plant: user.plant, sessionId };
  res.cookie('ironiq_access',  signAccessToken(payload), cookieOpts(15 * 60 * 1000));
  res.cookie('ironiq_refresh', signRefreshToken({ sub: user.userId, sessionId }), cookieOpts(8 * 60 * 60 * 1000));
}

// ── Auth middleware ───────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  const token = req.cookies['ironiq_access'] ||
    (req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : null);
  if (!token) return res.status(401).json({ success: false, message: 'Not authenticated' });
  try { req.user = verifyAccessToken(token); next(); }
  catch (err) {
    if (err.name === 'TokenExpiredError')
      return res.status(401).json({ success: false, code: 'TOKEN_EXPIRED', message: 'Session expired' });
    return res.status(401).json({ success: false, message: 'Invalid token' });
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user?.role))
      return res.status(403).json({ success: false, message: 'Insufficient permissions' });
    next();
  };
}

function getIp(req) {
  return req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress;
}

// ── Express app ───────────────────────────────────────────────────────────────
const app = express();

app.use(helmet({
  contentSecurityPolicy: false,
  hsts: { maxAge: 31536000, includeSubDomains: true },
  frameguard: { action: 'deny' },
}));

app.use(cors({ origin: CONFIG.allowedOrigins, credentials: true, methods: ['GET','POST','PUT','DELETE'] }));

app.use('/api', rateLimit({
  windowMs: 15 * 60 * 1000, max: 200,
  message: { success: false, message: 'Too many requests.' },
}));

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 20,
  message: { success: false, code: 'RATE_LIMITED', message: 'Too many login attempts. Try again in 15 minutes.', lockoutSeconds: 900 },
});

app.use(express.json({ limit: '10kb' }));
app.use(cookieParser());
app.use(morgan('combined'));
app.use(express.static('public'));

// ── Dashboard route ───────────────────────────────────────────────────────────
app.get('/dashboard', (req, res) => {
  res.sendFile('dashboard.html', { root: 'public' });
});

// ── POST /api/auth/login ──────────────────────────────────────────────────────
app.post('/api/auth/login', loginLimiter, async (req, res) => {
  const ip = getIp(req);
  const { username, password } = req.body;

  if (!username || typeof username !== 'string' || username.length > 64)
    return res.status(400).json({ success: false, message: 'Invalid username.' });
  if (!password || typeof password !== 'string' || password.length > 128)
    return res.status(400).json({ success: false, message: 'Invalid password.' });

  const uname = username.trim().toLowerCase();
  const lockRec = isLocked(uname, ip);
  if (lockRec) {
    const secsLeft = Math.ceil((lockRec.lockedUntil - Date.now()) / 1000);
    audit('LOGIN_LOCKED', { username: uname, ip });
    return res.status(429).json({ success: false, code: 'LOCKED_OUT',
      message: `Account locked. Try again in ${Math.ceil(secsLeft/60)} min.`, lockoutSeconds: secsLeft });
  }

  const user = USERS_DB[uname];
  const dummyHash = '$argon2id$v=19$m=65536,t=3,p=4$c29tZXNhbHQ$RdescudvJCsgt3ub';
  const hashToCheck = user ? user.passwordHash : dummyHash;

  let passwordOk = false;
  try { passwordOk = await argon2.verify(hashToCheck, password); } catch {}

  if (!user || !passwordOk || !user.active) {
    const rec = recordFailure(uname, ip);
    audit('LOGIN_FAILURE', { username: uname, ip });
    const left = CONFIG.maxLoginAttempts - rec.count;
    return res.status(401).json({ success: false,
      message: left > 0 ? `Invalid credentials. ${left} attempt(s) remaining.` : 'Account locked.',
      attemptsLeft: Math.max(0, left) });
  }

  audit('LOGIN_PW_OK', { username: uname, ip, details: `Role: ${user.role}` });

  if (user.mfaEnabled) {
    const preAuthToken = jwt.sign(
      { sub: user.userId, username: uname, phase: 'mfa' },
      CONFIG.jwtAccessSecret, { expiresIn: '5m', issuer: 'ironiq-auth' }
    );
    res.cookie('ironiq_preauth', preAuthToken, cookieOpts(5 * 60 * 1000));
    return res.json({ success: true, requireMfa: true, username: uname });
  }

  clearFailures(uname, ip);
  issueTokens(res, user);
  audit('LOGIN_SUCCESS', { username: uname, ip, details: `Role: ${user.role}` });
  return res.json({ success: true, requireMfa: false, redirectUrl: '/dashboard' });
});

// ── POST /api/auth/verify-totp ────────────────────────────────────────────────
app.post('/api/auth/verify-totp', loginLimiter, async (req, res) => {
  const ip = getIp(req);
  const { username, otp } = req.body;

  if (!otp || !/^\d{6}$/.test(otp))
    return res.status(400).json({ success: false, message: 'OTP must be 6 digits.' });

  const preAuthToken = req.cookies['ironiq_preauth'];
  if (!preAuthToken)
    return res.status(401).json({ success: false, message: 'Session expired. Please log in again.' });

  let preAuth;
  try { preAuth = jwt.verify(preAuthToken, CONFIG.jwtAccessSecret, { issuer: 'ironiq-auth' }); }
  catch { return res.status(401).json({ success: false, message: 'Session expired.' }); }

  if (preAuth.phase !== 'mfa' || preAuth.username !== username?.trim().toLowerCase())
    return res.status(401).json({ success: false, message: 'Invalid session state.' });

  const user = USERS_DB[preAuth.username];
  if (!user || !user.active)
    return res.status(401).json({ success: false, message: 'User not found.' });

  const totpOk = speakeasy.totp.verify({
    token:    otp,
    secret:   user.mfaSecret,
    encoding: 'base32',
    window:   1,
  });

  if (!totpOk) {
    recordFailure(preAuth.username, ip);
    audit('MFA_FAILURE', { username: preAuth.username, ip });
    return res.status(403).json({ success: false, code: 'MFA_INVALID', message: 'Invalid authenticator code.' });
  }

  clearFailures(preAuth.username, ip);
  res.clearCookie('ironiq_preauth');
  issueTokens(res, user);
  audit('LOGIN_SUCCESS', { username: preAuth.username, ip, details: 'MFA verified' });
  return res.json({ success: true, requireMfa: false, redirectUrl: '/dashboard' });
});

// ── POST /api/auth/refresh ────────────────────────────────────────────────────
app.post('/api/auth/refresh', (req, res) => {
  const token = req.cookies['ironiq_refresh'];
  if (!token) return res.status(401).json({ success: false, message: 'No refresh token.' });
  try {
    const payload = verifyRefreshToken(token);
    const user = Object.values(USERS_DB).find(u => u.userId === payload.sub);
    if (!user || !user.active) throw new Error('User inactive');
    const newAccess = signAccessToken({ sub: user.userId, username: user.username, role: user.role, plant: user.plant, sessionId: payload.sessionId });
    res.cookie('ironiq_access', newAccess, cookieOpts(15 * 60 * 1000));
    return res.json({ success: true });
  } catch {
    res.clearCookie('ironiq_access'); res.clearCookie('ironiq_refresh');
    return res.status(401).json({ success: false, code: 'REFRESH_INVALID', message: 'Session expired.' });
  }
});

// ── POST /api/auth/logout ─────────────────────────────────────────────────────
app.post('/api/auth/logout', requireAuth, (req, res) => {
  audit('LOGOUT', { username: req.user.username, ip: getIp(req) });
  res.clearCookie('ironiq_access'); res.clearCookie('ironiq_refresh'); res.clearCookie('ironiq_preauth');
  return res.json({ success: true, message: 'Logged out successfully.' });
});

// ── GET /api/auth/me ──────────────────────────────────────────────────────────
app.get('/api/auth/me', requireAuth, (req, res) => {
  const user = Object.values(USERS_DB).find(u => u.userId === req.user.sub);
  if (!user) return res.status(404).json({ success: false, message: 'User not found.' });
  return res.json({ success: true, userId: user.userId, username: user.username,
    displayName: user.displayName, role: user.role, plant: user.plant,
    permissions: ROLE_PERMISSIONS[user.role] || [] });
});

// ── POST /api/ai/chat (Anthropic proxy) ───────────────────────────────────────
app.post('/api/ai/chat', requireAuth, requireRole('operator','engineer','admin'), async (req, res) => {
  if (!CONFIG.anthropicApiKey)
    return res.status(503).json({ success: false, message: 'AI service not configured.' });

  const { messages, system } = req.body;
  if (!messages || !Array.isArray(messages))
    return res.status(400).json({ success: false, message: 'messages array required.' });

  audit('AI_QUERY', { username: req.user.username, ip: getIp(req) });

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': CONFIG.anthropicApiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens: 2048,
        system: system || 'You are an expert blast furnace process assistant.', messages }),
    });
    const data = await response.json();
    if (!response.ok) return res.status(response.status).json({ success: false, message: data.error?.message || 'AI error.' });
    return res.json({ success: true, content: data.content });
  } catch (err) {
    return res.status(502).json({ success: false, message: 'AI service unavailable.' });
  }
});

// ── GET /api/admin/audit-log ──────────────────────────────────────────────────
app.get('/api/admin/audit-log', requireAuth, requireRole('admin'), (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 100, 500);
  return res.json({ success: true, entries: auditLog.slice(-limit).reverse() });
});

// ── GET /api/health ───────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  return res.json({ status: 'ok', service: 'ironiq-auth', timestamp: new Date().toISOString() });
});

// ── Error handler ─────────────────────────────────────────────────────────────
app.use((err, req, res, _next) => {
  console.error('[ERROR]', err);
  return res.status(500).json({ success: false, message: 'Internal server error.' });
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(CONFIG.port, () => {
  console.log(`\n🏭 BF IronIQ Auth Server`);
  console.log(`   Port    : ${CONFIG.port}`);
  console.log(`   Env     : ${CONFIG.nodeEnv}`);
  console.log(`   Origins : ${CONFIG.allowedOrigins.join(', ')}`);
  console.log(`   Ready   ✓\n`);
});

module.exports = app;