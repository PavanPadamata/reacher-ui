import { prisma } from "./prisma";

/**
 * On startup:
 * 1. Reset RUNNING jobs → PAUSED (server crashed mid-job)
 * 2. Auto-resume DAILY_LIMIT_REACHED jobs if it's a new day
 */
export async function recoverStuckJobs() {
  // Reset crashed running jobs
  const stuck = await prisma.job.updateMany({
    where: { status: "RUNNING" },
    data: { status: "PAUSED" },
  });
  if (stuck.count > 0) {
    console.log(`[recovery] Reset ${stuck.count} stuck job(s) from RUNNING → PAUSED`);
  }

  // Auto-resume daily limit jobs — they can continue today if limits reset
  const limitReached = await prisma.job.updateMany({
    where: { status: "DAILY_LIMIT_REACHED" },
    data: { status: "PAUSED" },
  });
  if (limitReached.count > 0) {
    console.log(`[recovery] Reset ${limitReached.count} daily-limit job(s) → PAUSED (ready to resume)`);
  }
}

/**
 * Schedule midnight auto-resume of DAILY_LIMIT_REACHED jobs.
 * Runs once at startup, calculates ms until next midnight.
 */
export function scheduleMidnightResume(onResume: (jobId: string) => void) {
  const now = new Date();
  const midnight = new Date(now);
  midnight.setDate(midnight.getDate() + 1);
  midnight.setHours(0, 1, 0, 0); // 12:01 AM — give daily counters time to reset

  const msUntilMidnight = midnight.getTime() - now.getTime();

  setTimeout(async () => {
    // Find all paused jobs that have pending results — auto-resume them
    const jobs = await prisma.job.findMany({
      where: { status: "PAUSED" },
      select: { id: true, name: true },
    });

    for (const job of jobs) {
      const pendingCount = await prisma.result.count({
        where: { jobId: job.id, status: "pending" },
      });
      if (pendingCount > 0) {
        console.log(`[midnight] Auto-resuming job "${job.name}" (${pendingCount} emails remaining)`);
        onResume(job.id);
      }
    }

    // Schedule again for next midnight
    scheduleMidnightResume(onResume);
  }, msUntilMidnight);

  console.log(`[midnight] Auto-resume scheduled in ${Math.round(msUntilMidnight / 60000)} minutes`);
}
