# Reacher UI

Self-hosted bulk email verification dashboard powered by [check-if-email-exists](https://github.com/reacherhq/check-if-email-exists).

## What It Does

Upload a CSV of emails, run verification jobs, and download results in 3 clean buckets — Valid, Review, and Invalid. Built for scale — handles 1M+ emails with persistent jobs, smart concurrency, and enterprise domain detection.

## Features

- **Job-based verification** — each CSV upload is an independent job with its own controls
- **Start / Pause / Resume / Stop / Delete** — full control over every job
- **Smart concurrency presets** — Safe / Balanced / Fast / Maximum with per-domain rate limiting to protect your IP reputation
- **Auto-split large lists** — CSVs over 500k emails are automatically split into two jobs of ~500k each
- **Merged downloads** — download combined results from split jobs with one click
- **Enterprise domain detection** — detects Microsoft 365, Mimecast, Proofpoint, Barracuda and other enterprise mail gateways before probing, marks them as unverifiable instead of false invalid
- **3 output buckets** — Valid (safe to send), Review (test batch first), Invalid (discard)
- **Persistent** — jobs survive browser closes and server restarts (PostgreSQL backed)
- **Stuck job recovery** — jobs interrupted by server restart auto-recover to Paused on next startup
- **Live progress** — real-time speed, ETA, and per-bucket counts
- **Admin login** — email + password protected dashboard with JWT sessions
- **Light / Dark theme** — toggle in the navbar

## Stack

- **Next.js 16** — frontend + API routes
- **PostgreSQL** — persistent job and result storage
- **Prisma** — type-safe database ORM
- **Reacher** (`reacherhq/backend`) — SMTP verification engine written in Rust
- **Docker Compose** — one command to run everything

## Requirements

- Docker + Docker Compose
- A VPS with **port 25 open** (required for SMTP verification)
- Do NOT run on the same server as your cold email sending tool

## Quick Start

**Step 1** — Clone the repo:
```bash
git clone https://github.com/PavanPadamata/reacher-ui.git
cd reacher-ui
```

**Step 2** — Edit `backend_config.toml` with your server details:
```toml
from_email = "verify@yourdomain.com"
hello_name = "yourdomain.com"
```
If you have no domain, use your VPS IP:
```toml
from_email = "verify@YOUR_VPS_IP"
hello_name = "YOUR_VPS_IP"
```

**Step 3** — Set a strong `AUTH_SECRET` in `docker-compose.yml`:
```yaml
AUTH_SECRET=your-random-secret-min-32-chars
```
Generate one with:
```bash
openssl rand -base64 32
```

**Step 4** — Start everything:
```bash
docker compose up -d --build
```

**Step 5** — Open the app:
```
http://YOUR_VPS_IP:3000
```
First visit redirects to `/setup` — create your admin account. You're in.

## CSV Format

Your CSV must have an `email` column. A `name` column is optional:

```csv
email,name
john@example.com,John Doe
jane@gmail.com,Jane Smith
```

## Large Lists (500k+)

When you upload a CSV with more than 500,000 emails, the app will prompt you to split it into two jobs of ~500k each. This is recommended because:

- Each job is independently recoverable if the server restarts
- Half the RAM usage per job
- You can start sending from part 1 while part 2 is still verifying
- A **Merged Download** bar appears between the two jobs once both are done

You can also choose to upload as a single job if you prefer.

## Output Buckets

All downloads contain only `email` and `name` columns — clean and ready to upload to your sending tool.

| Download | Contains | What to do |
|----------|----------|------------|
| **Valid** | Safe + Risky catch-all + Enterprise/unverifiable | Send confidently |
| **Review** | Unknown + Errors | Test batch of 200 first, check bounce rate |
| **Invalid** | Bounced / fake / disabled emails | Discard |

## Speed Presets

| Preset | Total | Per Domain | Cooldown | Best For |
|--------|-------|------------|----------|----------|
| 🐢 Safe | 8 | 1 | 1s | Gmail/Yahoo heavy lists |
| ⚡ Balanced | 15 | 2 | 500ms | Mixed lists |
| 🚀 Fast | 30 | 3 | 200ms | Corporate/B2B domains |
| ⚠️ Maximum | 50 | 3 | None | Use with SMTP proxies only |

Per-domain limiting means even at Maximum, no single mail server receives more than 3 simultaneous connections from your IP — protecting your reputation automatically.

## Enterprise Domains

Domains using Microsoft 365, Mimecast, Proofpoint, Barracuda, and similar enterprise mail gateways actively block SMTP probing. The tool detects these via MX record lookup before attempting verification and marks them as `unverifiable` — they appear in the **Valid** bucket since the emails are almost certainly real, just unverifiable by SMTP.

Known unverifiable providers detected automatically:
- Microsoft 365 (`mail.protection.outlook.com`)
- Mimecast (`mimecast.com`)
- Proofpoint (`proofpoint.com`, `pphosted.com`)
- Barracuda (`barracudanetworks.com`)
- Sophos (`hydra.sophos.com`)
- Symantec/Broadcom (`messagelabs.com`)
- Trend Micro (`trendmicro.com`)

## Gmail & Yahoo

Both providers block SMTP verification from unknown IPs. If you get high Review counts for Gmail/Yahoo:

**Option A** — Use a VPS with clean port-25 IPs (Hetzner, Contabo work well).

**Option B** — Add an SMTP proxy in `backend_config.toml`:
```toml
[overrides.proxies]
proxy1 = { host = "my.proxy.com", port = 1080, username = "user", password = "pass" }

[overrides.gmail]
type = "smtp"
proxy = "proxy1"

[overrides.yahoo]
type = "smtp"
proxy = "proxy1"
```

Recommended SMTP proxy provider: [proxy25.com](https://proxy25.com)

## Useful Commands

```bash
# Start everything
docker compose up -d

# Stop everything
docker compose down

# View logs
docker compose logs -f

# View UI logs only
docker compose logs -f ui

# Rebuild after code changes
docker compose up -d --build
```

## Password Reset

See [`notes/password-reset.md`](notes/password-reset.md) for full instructions.

Quick nuclear reset (deletes admin account, all jobs and data are kept):
```bash
docker exec -it reacher-db psql -U reacher -d reacher -c 'DELETE FROM "Admin";'
```
Then open the app — redirects to `/setup` automatically.

## Architecture

```
Browser
    ↓
Next.js UI (port 3000)
    │
    ├── Auth middleware (proxy.ts) — JWT cookie validation
    ├── Upload API — parses CSV, creates job(s) in PostgreSQL
    ├── Worker (lib/worker.ts)
    │   ├── DNS MX lookup → enterprise domain? → mark unverifiable
    │   └── Reacher SMTP probe → safe / risky / invalid / unknown
    ├── Download API — streams results by bucket
    └── Jobs API — CRUD + start/pause/resume/stop signals
    │
PostgreSQL (port 5432) — jobs, results, admin account
Reacher Backend (port 8080) — Rust SMTP engine
```

## License

UI code: MIT

Reacher backend (`check-if-email-exists`): AGPL-3.0 for open-source use. Commercial license available at [reacher.email/pricing](https://reacher.email/pricing).
