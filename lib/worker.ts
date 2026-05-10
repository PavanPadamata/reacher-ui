import { prisma } from "./prisma";

const REACHER_URL = process.env.REACHER_BACKEND_URL || "http://localhost:8080";

// In-memory job control signals
const jobSignals = new Map<string, "pause" | "stop" | null>();

export function signalJob(jobId: string, signal: "pause" | "stop" | null) {
  jobSignals.set(jobId, signal);
}

export function getJobSignal(jobId: string) {
  return jobSignals.get(jobId) ?? null;
}

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

export async function runJob(jobId: string) {
  // Mark running
  await prisma.job.update({
    where: { id: jobId },
    data: { status: "RUNNING", startedAt: new Date() },
  });

  const job = await prisma.job.findUnique({ where: { id: jobId } });
  if (!job) return;

  // Get all unprocessed emails (no result yet)
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

  const concurrency = job.concurrency;
  const queue = [...allResults];
  let active = 0;
  let stopped = false;
  let paused = false;

  await new Promise<void>((resolve) => {
    async function processNext() {
      // Check signals
      const signal = jobSignals.get(jobId);
      if (signal === "stop") {
        stopped = true;
        resolve();
        return;
      }
      if (signal === "pause") {
        paused = true;
        await prisma.job.update({ where: { id: jobId }, data: { status: "PAUSED" } });
        // Poll until resumed
        while (jobSignals.get(jobId) === "pause") {
          await new Promise((r) => setTimeout(r, 1000));
        }
        if (jobSignals.get(jobId) === "stop") {
          stopped = true;
          resolve();
          return;
        }
        paused = false;
        await prisma.job.update({ where: { id: jobId }, data: { status: "RUNNING" } });
      }

      while (active < concurrency && queue.length > 0) {
        const item = queue.shift()!;
        active++;

        (async () => {
          try {
            const data = await verifyEmail(item.email);
            const status = classifyResult(data);
            const smtp = data.smtp as Record<string, unknown> || {};
            const misc = data.misc as Record<string, unknown> || {};
            const mx = data.mx as Record<string, unknown> || {};

            await prisma.result.update({
              where: { id: item.id },
              data: {
                status,
                isReachable: (data.is_reachable as string) || "",
                isDisposable: (misc.is_disposable as boolean) || false,
                isRoleAccount: (misc.is_role_account as boolean) || false,
                isCatchAll: (smtp.is_catch_all as boolean) || false,
                mxAcceptsMail: (mx.accepts_mail as boolean) || false,
                smtpDeliverable: (smtp.is_deliverable as boolean) || false,
                smtpDisabled: (smtp.is_disabled as boolean) || false,
              },
            });

            // Increment counters
            await prisma.job.update({
              where: { id: jobId },
              data: {
                processed: { increment: 1 },
                ...(status === "safe" && { safe: { increment: 1 } }),
                ...(status === "risky" && { risky: { increment: 1 } }),
                ...(status === "invalid" && { invalid: { increment: 1 } }),
                ...(status === "unknown" && { unknown: { increment: 1 } }),
              },
            });
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
            active--;
            if (queue.length === 0 && active === 0) {
              resolve();
            } else {
              processNext();
            }
          }
        })();
      }
    }

    processNext();
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
}
