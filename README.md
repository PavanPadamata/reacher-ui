# Reacher UI

Self-hosted bulk email verification dashboard powered by [check-if-email-exists](https://github.com/reacherhq/check-if-email-exists).

## What It Does

Upload a CSV of emails, run verification jobs, and download results split by Safe / Risky / Invalid / Unknown. Built for scale — handles 1M+ emails with persistent jobs that survive browser closes.

## Features

- **Job-based verification** — each CSV upload is an independent job with its own controls
- **Start / Pause / Resume / Stop / Delete** — full control over every job
- **Per-job concurrency** — set 1–50 parallel verifications per job
- **Persistent** — jobs survive browser closes and server restarts (PostgreSQL backed)
- **Live progress** — real-time speed, ETA, and per-category counts
- **Downloads** — separate CSVs for Safe, Risky, Invalid, Unknown at any point during or after verification
- **Gmail & Yahoo support** — SMTP verification with proxy support
- **Admin login** — email + password protected dashboard
- **Light / Dark theme** — toggle in the navbar

## Stack

- **Next.js 16** — frontend + API routes
- **PostgreSQL** — persistent job and result storage
- **Prisma** — database ORM
- **Reacher** (`reacherhq/backend`) — SMTP verification engine (Rust)
- **Docker Compose** — one command to run everything

## Requirements

- Docker + Docker Compose
- A VPS with **port 25 open** (required for SMTP verification)
- Do NOT run on the same server as your cold email tool

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

**Step 3** — Edit `docker-compose.yml` and set a strong `AUTH_SECRET`:
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

## Output CSVs

Downloads contain only `email`, `name`, and `status` columns:

```csv
email,name,status
john@example.com,John Doe,safe
jane@gmail.com,Jane Smith,risky
```

| Status | Meaning |
|--------|---------|
| `safe` | Email exists, inbox active, deliverable |
| `risky` | May exist but has issues (catch-all, role account) |
| `invalid` | Does not exist or disabled |
| `unknown` | Could not determine (IP blocked, timeout) |

## Gmail & Yahoo

Both providers block SMTP probing from unknown IPs. If you get `unknown` results for Gmail/Yahoo:

**Option A** — Use a VPS provider with clean port-25 IPs (Hetzner, Contabo work well).

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

## Concurrency Guide

| Concurrency | Per Hour | Per Day | Risk |
|-------------|----------|---------|------|
| 5 | ~22,500 | ~540,000 | Low |
| 10 | ~45,000 | ~1,080,000 | Medium |
| 20 | ~90,000 | ~2,160,000 | High for Gmail/Yahoo |
| 50 | ~225,000 | ~5,400,000 | Needs clean proxy IPs |

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

Quick reset (deletes admin account, jobs are kept):
```bash
docker exec -it reacher-db psql -U reacher -d reacher -c 'DELETE FROM "Admin";'
```

Then open the app — redirects to `/setup` automatically.

## License

UI code: MIT

Reacher backend (`check-if-email-exists`): AGPL-3.0 for open-source use. Commercial license available at [reacher.email/pricing](https://reacher.email/pricing).
