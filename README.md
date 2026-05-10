# Reacher UI — Self-Hosted Bulk Email Verifier

A production-ready Next.js UI for [check-if-email-exists](https://github.com/reacherhq/check-if-email-exists) (Reacher backend). Upload a CSV, verify in bulk, and download results split by Safe / Risky / Invalid / Unknown.

## ✨ Features

- 📤 CSV upload with drag-and-drop (`email`, `name` columns)
- ⚡ Concurrent verification (3 parallel requests by default)
- 📊 Live progress bar with real-time status counts
- 🔍 Expandable rows with full Reacher JSON details
- 📥 Download all results OR filtered CSVs (safe / risky / invalid / unknown)
- 🌐 Works with Gmail, Yahoo, Outlook, and all other providers
- 🐳 One-command Docker Compose setup

---

## 🚀 Quick Start

### Prerequisites
- Docker + Docker Compose installed
- **Port 25 open on your server** (required for SMTP checks)
  - ⚠️ Most home ISPs block port 25. Use a VPS (DigitalOcean, Hetzner, Vultr, etc.)
  - ⚠️ AWS EC2 also blocks port 25 by default — request removal via AWS support

### 1. Configure the backend

Edit `backend_config.toml` — set your domain in `from_email` and `hello_name`:

```toml
[backend_config]
from_email = "verify@yourdomain.com"   # ← change this
hello_name = "yourdomain.com"          # ← change this
```

These are used in the SMTP handshake. Use a domain you own for best results.

### 2. Start everything

```bash
docker compose up -d
```

Then open **http://localhost:3000** in your browser.

### 3. Upload your CSV

Your CSV needs at minimum an `email` column. A `name` column is optional:

```csv
email,name
john@example.com,John Doe
jane@gmail.com,Jane Smith
bob@yahoo.com,Bob Jones
```

---

## 🔧 Configuration

### Gmail & Yahoo

Gmail and Yahoo block SMTP verification from most cloud IPs. If you're getting
`unknown` results for Gmail/Yahoo, you have two options:

**Option A — Use a clean IP/VPS**
Some providers (Hetzner, Contabo) have clean port-25 IPs that work fine.

**Option B — Use an SMTP proxy**
Uncomment the proxy section in `backend_config.toml`:

```toml
[overrides.proxies]
proxy1 = { host = "my.proxy.com", port = 1080, username = "user", password = "pass" }

[overrides.gmail]
type = "smtp"
proxy = "proxy1"
hello_name = "yourdomain.com"
from_email = "verify@yourdomain.com"

[overrides.yahoo]
type = "smtp"
proxy = "proxy1"
```

Recommended SMTP proxy providers: [proxy25.com](https://proxy25.com)

### Concurrency

Edit `CONCURRENCY` in `app/page.tsx` (default: 3). Higher values = faster, but
more likely to get rate-limited by Gmail/Yahoo:

```ts
const CONCURRENCY = 3; // increase to 5-10 for non-Gmail lists
```

### Reacher Backend URL

If running separately (not via Docker Compose), set in `.env.local`:
```
REACHER_BACKEND_URL=http://your-server:8080
```

---

## 📁 Project Structure

```
reacher-ui/
├── app/
│   ├── api/verify/route.ts   # Next.js proxy → Reacher backend
│   ├── page.tsx              # Main UI
│   ├── layout.tsx
│   └── globals.css
├── backend_config.toml       # Reacher backend config (Gmail, Yahoo, proxies)
├── docker-compose.yml        # Reacher + UI together
├── Dockerfile                # UI container
└── README.md
```

---

## 📊 Understanding Results

| Status | Meaning |
|--------|---------|
| ✅ **Safe** | Email exists, inbox is active, deliverable |
| ⚠️ **Risky** | Email may exist but has issues (catch-all, full inbox) |
| ❌ **Invalid** | Email doesn't exist or is disabled |
| ❓ **Unknown** | Couldn't determine (IP blocked, timeout, catch-all domain) |

**Note on Unknown**: Unknown doesn't mean the email is bad — it means the SMTP
server didn't give a clear answer (common with Gmail/Yahoo on blocked IPs).

---

## 🛠️ Development (without Docker)

```bash
npm install
# In one terminal: run Reacher backend
docker run -p 8080:8080 -v ./backend_config.toml:/app/backend_config.toml reacherhq/backend:latest
# In another: run the UI
REACHER_BACKEND_URL=http://localhost:8080 npm run dev
```

---

## ⚖️ License

The Reacher backend (`check-if-email-exists`) is licensed under **AGPL-3.0** for
open-source use, or a commercial license for proprietary use.
See [reacher.email/pricing](https://reacher.email/pricing) for commercial licensing.

This UI code is MIT licensed — use freely.
