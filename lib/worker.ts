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

// ── Per-job caches ─────────────────────────────────────────────────────────
const mxCache = new Map<string, boolean>();
// Track MX exchange per domain for per-domain limiting
const domainMxCache = new Map<string, string>();
// Per-job, per-MX active connection count
const domainActive = new Map<string, number>();

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

// ── Job signals ────────────────────────────────────────────────────────────
const jobSignals = new Map<string, "pause" | "stop" | null>();

export function signalJob(jobId: string, signal: "pause" | "stop" | null) {
  jobSignals.set(jobId, signal);
}

export function getJobSignal(jobId: string) {
  return jobSignals.get(jobId) ?? null;
}

// ── Reacher verification ───────────────────────────────────────────────────
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
  if (r === "safe") return "safe";
  if (r === "risky") return "risky";
  if (r === "invalid") return "invalid";
  return "unknown";
}

// ── Main job runner ────────────────────────────────────────────────────────
export async function runJob(jobId: string) {
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

  // Get preset config — stored as preset name in concurrency field
  // We store preset index: 1=safe, 2=balanced, 3=fast, 4=maximum
  const presetMap: Record<number, ConcurrencyPreset> = {
    1: "safe", 2: "balanced", 3: "fast", 4: "maximum",
  };
  const preset = presetMap[job.concurrency] || "safe";
  const config = CONCURRENCY_PRESETS[preset];

  const queue = [...allResults];
  let totalActive = 0;
  let stopped = false;
  let paused = false;

  // Per-MX active count for this job
  const mxActive = new Map<string, number>();
  const getMxActive = (mx: string) => mxActive.get(mx) || 0;
  const incMxActive = (mx: string) => mxActive.set(mx, getMxActive(mx) + 1);
  const decMxActive = (mx: string) => mxActive.set(mx, Math.max(0, getMxActive(mx) - 1));

  // Last probe time per MX for cooldown
  const mxLastProbe = new Map<string, number>();

  await new Promise<void>((resolve) => {
    async function processNext() {
      const signal = jobSignals.get(jobId);
      if (signal === "stop") { stopped = true; resolve(); return; }

      if (signal === "pause") {
        paused = true;
        await prisma.job.update({ where: { id: jobId }, data: { status: "PAUSED" } });
        while (jobSignals.get(jobId) === "pause") {
          await new Promise((r) => setTimeout(r, 1000));
        }
        if (jobSignals.get(jobId) === "stop") { stopped = true; resolve(); return; }
        paused = false;
        await prisma.job.update({ where: { id: jobId }, data: { status: "RUNNING" } });
      }

      // Try to fill up to total concurrency
      let scheduled = false;
      for (let i = 0; i < queue.length && totalActive < config.total; i++) {
        const item = queue[i];
        const domain = item.email.split("@")[1]?.toLowerCase() || "";
        const mx = await getDomainMx(domain);

        // Check per-domain limit
        if (getMxActive(mx) >= config.perDomain) continue;

        // Check cooldown
        const lastProbe = mxLastProbe.get(mx) || 0;
        const timeSince = Date.now() - lastProbe;
        if (config.cooldownMs > 0 && timeSince < config.cooldownMs) continue;

        // This item is eligible — remove from queue and process
        queue.splice(i, 1);
        totalActive++;
        incMxActive(mx);
        mxLastProbe.set(mx, Date.now());
        scheduled = true;

        // Process in background
        (async () => {
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
              const mx2 = (data.mx as Record<string, unknown>) || {};

              await prisma.result.update({
                where: { id: item.id },
                data: {
                  status,
                  isReachable: (data.is_reachable as string) || "",
                  isDisposable: (misc.is_disposable as boolean) || false,
                  isRoleAccount: (misc.is_role_account as boolean) || false,
                  isCatchAll: (smtp.is_catch_all as boolean) || false,
                  mxAcceptsMail: (mx2.accepts_mail as boolean) || false,
                  smtpDeliverable: (smtp.is_deliverable as boolean) || false,
                  smtpDisabled: (smtp.is_disabled as boolean) || false,
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
            if (queue.length === 0 && totalActive === 0) {
              resolve();
            } else {
              // Small delay then try to schedule more
              setTimeout(processNext, config.cooldownMs > 0 ? 100 : 0);
            }
          }
        })();

        // Break out to re-evaluate queue after scheduling one
        break;
      }

      // If nothing was scheduled but queue has items, retry after cooldown
      if (!scheduled && queue.length > 0 && totalActive < config.total) {
        setTimeout(processNext, 200);
      }

      // If queue empty and nothing active, we're done
      if (queue.length === 0 && totalActive === 0) {
        resolve();
      }
    }

    // Kick off initial batch
    for (let i = 0; i < config.total; i++) {
      setTimeout(processNext, i * 50);
    }
  });

  if (stopped) {
    await prisma.job.update({ where: { id: jobId }, data: { status: "STOPPED" } });
  } else if (!paused) {
    await prisma.job.update({
      where: { id: jobId },
      data: { status: "COMPLETED", finishedAt: new Date() },
    });
  }

  jobSignals.delete(jobId);
  mxCache.clear();
  domainMxCache.clear();
  domainActive.clear();
}
