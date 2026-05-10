import { prisma } from "./prisma";

/**
 * On startup, any job left in RUNNING state means the server crashed
 * mid-verification. Reset them to PAUSED so the user can manually resume.
 */
export async function recoverStuckJobs() {
  const stuck = await prisma.job.updateMany({
    where: { status: "RUNNING" },
    data: { status: "PAUSED" },
  });

  if (stuck.count > 0) {
    console.log(`[recovery] Reset ${stuck.count} stuck job(s) from RUNNING → PAUSED`);
  }
}
