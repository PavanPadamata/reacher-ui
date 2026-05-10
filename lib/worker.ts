import { prisma } from "./prisma";
import { resolveMx } from "node:dns/promises";

const REACHER_URL = process.env.REACHER_BACKEND_URL || "http://localhost:8080";

// ── Concurrency presets ────────────────────────────────────────────────────
export const CONCURRENCY_PRESETS = {
  safe:     { total: 8,  perDomain: 1, cooldownMs: 1000 },
  balanced: { total: 15, perDomain: 2, cooldownMs: 500  },
  fast:     { total: 30, perDomain: 3, cooldownMs: 200  },
  maximum:  { total: 50, perDomain: 3, cooldownMs: 0    },
} as const;

export type ConcurrencyPreset = keyof typeof CONCURRENCY_PRESETS;

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

// ── DNS caches ─────────────────────────────────────────────────────────────
const mxCache = new Map<string, boolean>();
const domainMxCache = new Map<string, string>();

async function getDomainMx(domain: string): Promise<string> {
  if (domainMxCache.has(domain)) return domainMxCache.get(domain)!;
  try {
    const records = await resolveMx(domain);
    const mx = records.sort((a, b) => a.priority - b.priority)[0]?.exchange || domain;
    domainMxCache.set(domain, mx);
    return mx;
  } catch {
    domainMxCache.set(domain, domain);
    return domain;
  }
}

async function isUnverifiableDomain(email: string): Promise<boolean> {
  const domain = email.split("@")[1]?.toLowerCase();
  if (!domain) return false;
  if (mxCache.has(domain)) return mxCache.get(domain)!;
  try {
    const records = await resolveMx(domain);
    const isEnterprise = records.some((r) =>
      UNVERIFIABLE_MX_PATTERNS.some((p) => r.exchange.toLowerCase().includes(p))
    );
    mxCache.set(domain, isEnterprise);
    return isEnterprise;
  } catch {
    mxCache.set(domain, false);
    return false;
  }
}

// ── Job control ────────────────────────────────────────────────────────────
// Each job has a control state: running | paused | stopped
type JobControl = "running" | "paused" | "stopped";
const jobControl = new Map<string, JobControl>();

export function signalJob(jobId: string, signal: "pause" | "stop" | null) {
  if (signal === "pause")  jobControl.set(jobId, "paused");
  else if (signal === "stop")   jobControl.set(jobId, "stopped");
  else                          jobControl.set(jobId, "running");
}

export function getJobSignal(jobId: string) {
  return jobControl.get(jobId) ?? null;
}

// Wait until job is unpaused or stopped — called before processing each email
async function waitIfPaused(jobId: string): Promise<boolean> {
  const state = jobControl.get(jobId);
  if (state === "stopped") return false; // signal caller to stop
  if (state !== "paused") return true;  // running, proceed

  // Update DB status to PAUSED
  await prisma.job.update({ where: { id: jobId }, data: { status: "PAUSED" } });

  // Poll every 500ms until resumed or stopped
  while (jobControl.get(jobId) === "paused") {
    await new Promise((r) => setTimeout(r, 500));
  }

  if (jobControl.get(jobId) === "stopped") return false;

  // Resumed — update DB back to RUNNING
  await prisma.job.update({ where: { id: jobId }, data: { status: "RUNNING" } });
  return true;
}

// ── Reacher call ───────────────────────────────────────────────────────────
async function verifyEmail(email: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${REACHER_URL}/v0/check_email`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ to_email: email.trim().toLowerCase() }),
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
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

  const presetMap: Record<number, ConcurrencyPreset> = {
    1: "safe", 2: "balanced", 3: "fast", 4: "maximum",
  };
  const config = CONCURRENCY_PRESETS[presetMap[job.concurrency] || "safe"];

  // ── Semaphore for total + per-domain concurrency ───────────────────────
  let totalActive = 0;
  const mxActive = new Map<string, number>();
  const mxLastProbe = new Map<string, number>();

  const getMxActive  = (mx: string) => mxActive.get(mx) || 0;
  const incMxActive  = (mx: string) => mxActive.set(mx, getMxActive(mx) + 1);
  const decMxActive  = (mx: string) => mxActive.set(mx, Math.max(0, getMxActive(mx) - 1));

  // Process one email — returns false if job should stop
  async function processOne(item: { id: string; email: string; name: string }, mx: string): Promise<void> {
    try {
      const unverifiable = await isUnverifiableDomain(item.email);

      if (unverifiable) {
        await prisma.result.update({
          where: { id: item.id },
          data: { status: "unverifiable", isReachable: "unverifiable" },
        });
        await prisma.job.update({
          where: { id: jobId },
          data: { processed: { increment: 1 }, unverifiable: { increment: 1 } },
        });
      } else {
        const data = await verifyEmail(item.email);
        const status = classifyResult(data);
        const smtp = (data.smtp as Record<string, unknown>) || {};
        const misc = (data.misc as Record<string, unknown>) || {};
        const mx2  = (data.mx   as Record<string, unknown>) || {};

        await prisma.result.update({
          where: { id: item.id },
          data: {
            status,
            isReachable:     (data.is_reachable as string)   || "",
            isDisposable:    (misc.is_disposable as boolean)  || false,
            isRoleAccount:   (misc.is_role_account as boolean)|| false,
            isCatchAll:      (smtp.is_catch_all as boolean)   || false,
            mxAcceptsMail:   (mx2.accepts_mail as boolean)    || false,
            smtpDeliverable: (smtp.is_deliverable as boolean) || false,
            smtpDisabled:    (smtp.is_disabled as boolean)    || false,
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
          },
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "error";
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
      decMxActive(mx);
    }
  }

  // ── Main scheduling loop ───────────────────────────────────────────────
  let idx = 0;
  const queue = [...allResults];

  while (idx < queue.length || totalActive > 0) {
    // Check stop signal
    if (jobControl.get(jobId) === "stopped") {
      // Wait for active requests to finish
      while (totalActive > 0) await new Promise((r) => setTimeout(r, 200));
      await prisma.job.update({ where: { id: jobId }, data: { status: "STOPPED" } });
      jobControl.delete(jobId);
      mxCache.clear(); domainMxCache.clear();
      return;
    }

    // Check pause signal — wait until resumed
    if (jobControl.get(jobId) === "paused") {
      const ok = await waitIfPaused(jobId);
      if (!ok) {
        while (totalActive > 0) await new Promise((r) => setTimeout(r, 200));
        await prisma.job.update({ where: { id: jobId }, data: { status: "STOPPED" } });
        jobControl.delete(jobId);
        mxCache.clear(); domainMxCache.clear();
        return;
      }
      continue;
    }

    // Try to schedule next eligible email
    if (idx < queue.length && totalActive < config.total) {
      const item = queue[idx];
      const domain = item.email.split("@")[1]?.toLowerCase() || "";
      const mx = await getDomainMx(domain);

      // Check per-domain limit
      if (getMxActive(mx) >= config.perDomain) {
        // Can't send to this MX right now — try next item
        // Simple round: move to end and increment
        queue.push(queue.splice(idx, 1)[0]);
        // Avoid infinite spin if all items are blocked
        await new Promise((r) => setTimeout(r, 50));
        continue;
      }

      // Check cooldown
      const lastProbe = mxLastProbe.get(mx) || 0;
      const timeSince = Date.now() - lastProbe;
      if (config.cooldownMs > 0 && timeSince < config.cooldownMs) {
        await new Promise((r) => setTimeout(r, config.cooldownMs - timeSince));
        continue;
      }

      // Schedule this item
      idx++;
      totalActive++;
      incMxActive(mx);
      mxLastProbe.set(mx, Date.now());
      processOne(item, mx); // fire and forget — tracking via totalActive
    } else {
      // Either at concurrency limit or waiting for active to finish
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  // All done
  await prisma.job.update({
    where: { id: jobId },
    data: { status: "COMPLETED", finishedAt: new Date() },
  });

  jobControl.delete(jobId);
  mxCache.clear();
  domainMxCache.clear();
}
