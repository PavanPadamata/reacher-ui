import { prisma } from "./prisma";
import { resolveMx } from "node:dns/promises";
import {
  waitForBackendForDomain,
  reserveBackend,
  recordVerification,
  releaseBackend,
  getRequestDelay,
  startHealthChecks,
} from "./backends";

// Start health checks when worker loads
startHealthChecks();

// ── Concurrency config ─────────────────────────────────────────────────────
export function getConcurrencyConfig(total: number) {
  const clamped = Math.max(1, Math.min(50, total));
  const perDomain = Math.max(1, Math.floor(clamped / 5));
  const cooldownMs =
    clamped <= 10 ? 1000 :
    clamped <= 20 ? 500  :
    clamped <= 35 ? 200  : 0;
  return { total: clamped, perDomain, cooldownMs };
}

// ── Enterprise MX patterns ─────────────────────────────────────────────────
const UNVERIFIABLE_MX_PATTERNS = [
  "mail.protection.outlook.com",
  "outlook.com",
  "mimecast.com",
  "proofpoint.com",
  "pphosted.com",
  "barracudanetworks.com",
  "messagelabs.com",
  "spamh.com",
  "ppe-hosted.com",
  "hydra.sophos.com",
  "trendmicro.com",
];

// ── DNS caches — in-memory L1 + PostgreSQL L2 ─────────────────────────────
const MAX_CACHE_SIZE = 50000;
const mxCache = new Map<string, boolean>();        // domain → isEnterprise
const domainMxCache = new Map<string, string>();   // domain → mxHost

function pruneCacheIfNeeded() {
  if (mxCache.size > MAX_CACHE_SIZE) {
    [...mxCache.keys()].slice(0, 10000).forEach((k) => mxCache.delete(k));
  }
  if (domainMxCache.size > MAX_CACHE_SIZE) {
    [...domainMxCache.keys()].slice(0, 10000).forEach((k) => domainMxCache.delete(k));
  }
}

async function getDomainMxWithCache(domain: string): Promise<{ mxHost: string; isEnterprise: boolean }> {
  // L1 — in-memory
  if (domainMxCache.has(domain) && mxCache.has(domain)) {
    return { mxHost: domainMxCache.get(domain)!, isEnterprise: mxCache.get(domain)! };
  }

  // L2 — PostgreSQL cache
  try {
    const cached = await prisma.mxCache.findUnique({ where: { domain } });
    if (cached) {
      domainMxCache.set(domain, cached.mxHost);
      mxCache.set(domain, cached.isEnterprise);
      return { mxHost: cached.mxHost, isEnterprise: cached.isEnterprise };
    }
  } catch { /* ignore DB errors, fall through to DNS */ }

  // L3 — real DNS lookup
  pruneCacheIfNeeded();
  try {
    const records = await resolveMx(domain);
    const mxHost = records.sort((a, b) => a.priority - b.priority)[0]?.exchange || domain;
    const isEnterprise = records.some((r) =>
      UNVERIFIABLE_MX_PATTERNS.some((p) => r.exchange.toLowerCase().includes(p))
    );

    // Store in memory
    domainMxCache.set(domain, mxHost);
    mxCache.set(domain, isEnterprise);

    // Store in PostgreSQL (non-blocking)
    prisma.mxCache.upsert({
      where: { domain },
      create: { domain, mxHost, isEnterprise },
      update: { mxHost, isEnterprise, cachedAt: new Date() },
    }).catch(() => {});

    return { mxHost, isEnterprise };
  } catch {
    const fallback = { mxHost: domain, isEnterprise: false };
    domainMxCache.set(domain, domain);
    mxCache.set(domain, false);
    return fallback;
  }
}

// ── Job control ────────────────────────────────────────────────────────────
type JobControl = "running" | "paused" | "stopped";
const jobControl = new Map<string, JobControl>();

export function signalJob(jobId: string, signal: "pause" | "stop" | null) {
  if (signal === "pause")     jobControl.set(jobId, "paused");
  else if (signal === "stop") jobControl.set(jobId, "stopped");
  else                        jobControl.set(jobId, "running");
}

export function getJobSignal(jobId: string) {
  return jobControl.get(jobId) ?? null;
}

async function waitIfPaused(jobId: string): Promise<boolean> {
  const state = jobControl.get(jobId);
  if (state === "stopped") return false;
  if (state !== "paused") return true;

  await prisma.job.update({ where: { id: jobId }, data: { status: "PAUSED" } });
  while (jobControl.get(jobId) === "paused") {
    await new Promise((r) => setTimeout(r, 500));
  }
  if (jobControl.get(jobId) === "stopped") return false;
  await prisma.job.update({ where: { id: jobId }, data: { status: "RUNNING" } });
  return true;
}

// ── Reacher call ───────────────────────────────────────────────────────────
async function verifyEmail(email: string, mxHost: string): Promise<Record<string, unknown>> {
  // Wait for a backend that hasn't recently probed this MX host
  const backend = await waitForBackendForDomain(mxHost);
  if (!backend) throw new Error("No backends available — all offline or daily limit reached");

  reserveBackend(backend.url);

  const body: Record<string, unknown> = {
    to_email: email.trim().toLowerCase(),
    from_email: process.env.REACHER_FROM_EMAIL || "verify@nyelizabeth.net",
    hello_name: process.env.REACHER_HELLO_NAME || "verify.nyelizabeth.net",
  };

  try {
    const res = await fetch(`${backend.url}/v0/check_email`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    recordVerification(backend.url);
    return data;
  } catch (err) {
    const msg = err instanceof Error ? err.message : "error";
    releaseBackend(backend.url, msg);
    throw err;
  }
}

function classifyResult(data: Record<string, unknown>): string {
  const r = data.is_reachable as string;
  if (r === "safe")    return "safe";
  if (r === "risky")   return "risky";
  if (r === "invalid") return "invalid";
  return "unknown";
}

// ── Main job runner ────────────────────────────────────────────────────────
export async function runJob(jobId: string) {
  jobControl.set(jobId, "running");

  await prisma.job.update({
    where: { id: jobId },
    data: { status: "RUNNING", startedAt: new Date() },
  });

  const job = await prisma.job.findUnique({ where: { id: jobId } });
  if (!job) return;

  const allResults = await prisma.result.findMany({
    where: { jobId, status: "pending" },
    select: { id: true, email: true, name: true },
  });

  if (allResults.length === 0) {
    await prisma.job.update({
      where: { id: jobId },
      data: { status: "COMPLETED", finishedAt: new Date() },
    });
    return;
  }

  const config = getConcurrencyConfig(job.concurrency);

  let totalActive = 0;
  const mxActive = new Map<string, number>();
  const mxLastProbe = new Map<string, number>();

  const getMxActive  = (mx: string) => mxActive.get(mx) || 0;
  const incMxActive  = (mx: string) => mxActive.set(mx, getMxActive(mx) + 1);
  const decMxActive  = (mx: string) => mxActive.set(mx, Math.max(0, getMxActive(mx) - 1));

  async function processOne(item: { id: string; email: string; name: string }, mxHost: string): Promise<void> {
    try {
      const domain = item.email.split("@")[1]?.toLowerCase() || "";
      const { isEnterprise } = await getDomainMxWithCache(domain);

      if (isEnterprise) {
        await prisma.result.update({
          where: { id: item.id },
          data: { status: "unverifiable", isReachable: "unverifiable" },
        });
        await prisma.job.update({
          where: { id: jobId },
          data: { processed: { increment: 1 }, unverifiable: { increment: 1 } },
        });
      } else {
        // Human-like delay before each request
        await new Promise((r) => setTimeout(r, getRequestDelay()));

        const data = await verifyEmail(item.email, mxHost);
        const status = classifyResult(data);
        const smtp = (data.smtp as Record<string, unknown>) || {};
        const misc = (data.misc as Record<string, unknown>) || {};
        const mx2  = (data.mx   as Record<string, unknown>) || {};

        await prisma.result.update({
          where: { id: item.id },
          data: {
            status,
            isReachable:     (data.is_reachable as string)    || "",
            isDisposable:    (misc.is_disposable as boolean)   || false,
            isRoleAccount:   (misc.is_role_account as boolean) || false,
            isCatchAll:      (smtp.is_catch_all as boolean)    || false,
            mxAcceptsMail:   (mx2.accepts_mail as boolean)     || false,
            smtpDeliverable: (smtp.is_deliverable as boolean)  || false,
            smtpDisabled:    (smtp.is_disabled as boolean)     || false,
          },
        });

        await prisma.job.update({
          where: { id: jobId },
          data: {
            processed: { increment: 1 },
            ...(status === "safe"    && { safe:    { increment: 1 } }),
            ...(status === "risky"   && { risky:   { increment: 1 } }),
            ...(status === "invalid" && { invalid: { increment: 1 } }),
            ...(status === "unknown" && { unknown: { increment: 1 } }),
            ...((smtp.is_catch_all as boolean) && { catchAll: { increment: 1 } }),
          },
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "error";

      // If no backends available due to daily limit — pause job until tomorrow
      if (msg.includes("daily limit")) {
        await prisma.job.update({
          where: { id: jobId },
          data: { status: "DAILY_LIMIT_REACHED" as never },
        });
        jobControl.set(jobId, "stopped");
        return;
      }

      await prisma.result.update({
        where: { id: item.id },
        data: { status: "error", rawError: msg },
      });
      await prisma.job.update({
        where: { id: jobId },
        data: { processed: { increment: 1 }, unknown: { increment: 1 } },
      });
    } finally {
      totalActive--;
      decMxActive(mxHost);
    }
  }

  // ── Main scheduling loop ───────────────────────────────────────────────
  const queue = [...allResults];
  let idx = 0;

  while (idx < queue.length || totalActive > 0) {
    // Check stop
    if (jobControl.get(jobId) === "stopped") {
      while (totalActive > 0) await new Promise((r) => setTimeout(r, 200));
      await prisma.job.update({ where: { id: jobId }, data: { status: "STOPPED" } });
      jobControl.delete(jobId);
      return;
    }

    // Check pause
    if (jobControl.get(jobId) === "paused") {
      const ok = await waitIfPaused(jobId);
      if (!ok) {
        while (totalActive > 0) await new Promise((r) => setTimeout(r, 200));
        await prisma.job.update({ where: { id: jobId }, data: { status: "STOPPED" } });
        jobControl.delete(jobId);
        return;
      }
      continue;
    }

    if (idx < queue.length && totalActive < config.total) {
      const item = queue[idx];
      const domain = item.email.split("@")[1]?.toLowerCase() || "";
      const { mxHost: mx } = await getDomainMxWithCache(domain);

      if (getMxActive(mx) >= config.perDomain) {
        if (idx < queue.length - 1) { idx++; continue; }
        await new Promise((r) => setTimeout(r, 100));
        continue;
      }

      const lastProbe = mxLastProbe.get(mx) || 0;
      const timeSince = Date.now() - lastProbe;
      if (config.cooldownMs > 0 && timeSince < config.cooldownMs) {
        await new Promise((r) => setTimeout(r, Math.min(config.cooldownMs - timeSince, 100)));
        continue;
      }

      queue.splice(idx, 1);
      totalActive++;
      incMxActive(mx);
      mxLastProbe.set(mx, Date.now());
      processOne(item, mx);
    } else {
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  await prisma.job.update({
    where: { id: jobId },
    data: { status: "COMPLETED", finishedAt: new Date() },
  });

  jobControl.delete(jobId);
}
