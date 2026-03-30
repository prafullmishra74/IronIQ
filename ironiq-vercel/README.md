# 🔥 Iron-IQ BF Platform — Secured Vercel Deployment

## What this is

A production-secured deployment of the Iron-IQ Blast Furnace Intelligence Platform.
All proprietary data, scoring algorithms, and operational thresholds are moved to
server-side Vercel Serverless Functions. The client receives a hardcoded HTML shell
that fetches data only after authentication.

---

## What a client sees vs. what they cannot see

| | Client (browser) | Server (Vercel) |
|---|---|---|
| XLDATA (cast chemistry) | ❌ Never | ✅ xldata.json |
| DB (trends, heat balance, fuel opt) | ❌ Never | ✅ db.json |
| PARAM_DEFS (op thresholds) | ❌ Never | ✅ params.json + score.js |
| Scoring algorithm | ❌ Never | ✅ score.js |
| UI rendering code | ✅ Yes (CSS/HTML/JS) | — |

**View Source** on the deployed URL shows only a login screen and rendering code.
No data, no ranges, no business logic.

---

## Project Structure

```
ironiq-vercel/
│
├── api/                         ← Vercel Serverless Functions
│   ├── auth.js                  ← Login gate (issues session token)
│   ├── data.js                  ← Serves XLDATA (chemistry sheets)
│   ├── db.js                    ← Serves DB (trends, heat balance, etc.)
│   └── score.js                 ← Server-side scoring engine
│
├── data/                        ← Protected data (never sent to browser directly)
│   ├── xldata.json              ← Cast/ladle/slag/gas chemistry data
│   ├── db.json                  ← All analytics datasets
│   └── params.json              ← 33 operational parameter definitions
│
├── public/
│   └── index.html               ← Stripped frontend shell (no embedded data)
│
├── vercel.json                  ← Routing, headers, function config
├── package.json
└── README.md
```

---

## Prerequisites

- Node.js 18+
- A [Vercel](https://vercel.com) account (free tier works)
- Vercel CLI: `npm install -g vercel`

---

## Step-by-Step Deployment

### 1. Clone / prepare the project

```bash
# If you received this as a zip, extract it:
unzip ironiq-vercel.zip
cd ironiq-vercel
```

### 2. Install Vercel CLI

```bash
npm install -g vercel
```

### 3. Login to Vercel

```bash
vercel login
# Follow the browser prompt to authenticate
```

### 4. Generate your secrets

You need three random secrets. Run these in your terminal:

```bash
# Generate API_SECRET (the token the frontend sends with every API call)
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# Generate JWT_SECRET (signs the session token issued on login)
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# Pick a DEMO_PASSWORD your client will use (something memorable but not obvious)
# e.g.:  BF-Demo-2026!
```

Save these three values somewhere safe before proceeding.

### 5. Deploy to Vercel

```bash
cd ironiq-vercel
vercel --prod
```

During the first deploy, Vercel will ask:
- **Set up and deploy?** → Yes
- **Which scope?** → Your account
- **Link to existing project?** → No
- **Project name?** → `ironiq-bf-platform` (or any name)
- **In which directory is your code?** → `.` (current directory)

### 6. Set Environment Variables

After deployment, go to:
**Vercel Dashboard → Your Project → Settings → Environment Variables**

Add these three variables (select "Production" environment):

| Variable Name   | Value                                         |
|-----------------|-----------------------------------------------|
| `API_SECRET`    | (the hex string from step 4, first one)       |
| `JWT_SECRET`    | (the hex string from step 4, second one)      |
| `DEMO_PASSWORD` | (your chosen password, e.g. `BF-Demo-2026!`) |
| `ALLOWED_ORIGIN`| Your Vercel URL, e.g. `https://ironiq-bf-platform.vercel.app` |

### 7. Redeploy to apply env vars

```bash
vercel --prod
```

Or click **Redeploy** in the Vercel dashboard.

### 8. Test the deployment

```bash
# Your URL will look like:
# https://ironiq-bf-platform.vercel.app

# Test the login API directly:
curl -s -X POST https://YOUR-URL.vercel.app/api/auth \
  -H "Content-Type: application/json" \
  -d '{"password":"BF-Demo-2026!"}' | head -c 200

# Test that data is protected (should return 401):
curl -s https://YOUR-URL.vercel.app/api/data
# Expected: {"error":"Unauthorized"}

# Test that scoring works with a valid token:
TOKEN=$(curl -s -X POST https://YOUR-URL.vercel.app/api/auth \
  -H "Content-Type: application/json" \
  -d '{"password":"BF-Demo-2026!"}' | python3 -c "import sys,json; print(json.load(sys.stdin)['token'])")

curl -s -X POST https://YOUR-URL.vercel.app/api/score \
  -H "Content-Type: application/json" \
  -H "x-api-token: $TOKEN" \
  -d '{"type":"hm","values":{"C":4.1,"Si":0.5,"S":0.04,"P":0.11,"Ti":0.04,"Mn":0.28,"temp":1460}}'
```

### 9. Share with your client

Send them:
1. The Vercel URL: `https://ironiq-bf-platform.vercel.app`
2. The demo password: `BF-Demo-2026!` (or whatever you chose)

**That's it.** They cannot access your data or logic.

---

## Local Development

```bash
# Install deps (only vercel CLI needed)
npm install

# Run locally (requires .env.local file)
cat > .env.local << 'EOF'
API_SECRET=dev-secret-change-in-production
JWT_SECRET=dev-jwt-secret-change-in-production
DEMO_PASSWORD=dev-password
ALLOWED_ORIGIN=http://localhost:3000
EOF

vercel dev
# Opens at http://localhost:3000
```

---

## API Reference

### `POST /api/auth`
**Public** — no token required.

```json
Request:  { "password": "BF-Demo-2026!" }
Response: { "token": "eyJhbGc..." }
```

Token is valid for **24 hours**. Pass it in all subsequent requests as:
```
x-api-token: <token>
```

---

### `GET /api/data`
**Protected** — returns full XLDATA payload.

```
Headers: x-api-token: <token>
Returns: { data_sheet: {...}, today_hm: {...}, ma1: {...}, data1: {...}, ma2: [...] }
```

---

### `GET /api/db`
**Protected** — returns DB analytics payload.

```
Headers: x-api-token: <token>
Returns: { hm_daily: [...], hm_casts: [...], heat_balance: {...}, ... params: [...] }
```

---

### `POST /api/score`
**Protected** — server-side scoring. Thresholds never leave the server.

```json
Request:
{
  "type": "hm",
  "values": { "C": 4.1, "Si": 0.5, "S": 0.04, "P": 0.11, "Ti": 0.04, "Mn": 0.28, "temp": 1460 }
}

Response:
{
  "score": 87,
  "grade": "B",
  "color": "#00c9b1",
  "label": "Good",
  "flags": [],
  "recommendation": "All HM parameters within specification."
}
```

**Supported types:** `hm` | `slag` | `gas` | `params`

---

## Security Architecture

```
Browser                          Vercel Edge                    Vercel Functions
──────                           ──────────                     ────────────────
GET /                    ──→     → /public/index.html           (static shell)
                                   ↑ No data, no logic

POST /api/auth + pw      ──→     → auth.js                      Checks DEMO_PASSWORD env var
                         ←──     ← { token }                    Issues signed token

GET /api/data + token    ──→     → data.js                      Validates token
                         ←──     ← XLDATA JSON                  Reads xldata.json

GET /api/db + token      ──→     → db.js                        Validates token  
                         ←──     ← DB JSON                      Reads db.json + params.json

POST /api/score + token  ──→     → score.js                     Validates token
    + { type, values }           Runs scoring algo               Thresholds hardcoded
                         ←──     ← { score, grade, flags }      Never sent to client
```

**What cannot be reverse-engineered from the browser:**
- Historical plant chemistry data (XLDATA)
- Analytics/ML datasets (DB)
- Scoring thresholds and weights
- Operational parameter bounds (PARAM_DEFS)
- Business rules and recommendations logic

---

## Updating Data

When you have new plant data, update the JSON files and redeploy:

```bash
# Replace data files
cp new_xldata.json data/xldata.json
cp new_db.json     data/db.json

# Redeploy
vercel --prod
```

The serverless functions cache data in memory between invocations automatically.

---

## Troubleshooting

| Issue | Solution |
|-------|----------|
| Login says "Invalid password" | Check `DEMO_PASSWORD` env var in Vercel dashboard |
| Dashboard loads but shows no data | Check browser console for API errors; verify `API_SECRET` is set |
| API returns 500 | Check Vercel Function logs: Dashboard → Functions → Logs |
| `API_SECRET` not recognised | Redeploy after setting env vars |
| CORS errors in local dev | Set `ALLOWED_ORIGIN=http://localhost:3000` in `.env.local` |

---

## Rotating Secrets

If you need to revoke access (e.g., after demo ends):

1. Go to Vercel Dashboard → Settings → Environment Variables
2. Change `DEMO_PASSWORD` to a new value
3. Redeploy — all existing sessions instantly invalidated

To rotate API keys without invalidating sessions:
1. Change `API_SECRET` to a new value
2. Redeploy — the frontend will re-authenticate automatically on next page load

---

*Iron-IQ — Blast Furnace Intelligence Platform*  
*Secured deployment package — proprietary data and logic protected*
