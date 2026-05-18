import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { recoverStuckJobs, scheduleMidnightResume } from "@/lib/recover";
import { runJob } from "@/lib/worker";

let initialized = false;

export async function GET() {
  try {
    if (!initialized) {
      initialized = true;
      await recoverStuckJobs();
      // Auto-resume daily-limit jobs at midnight
      scheduleMidnightResume((jobId) => {
        runJob(jobId).catch(console.error);
      });
    }

    const jobs = await prisma.job.findMany({
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        name: true,
        fileName: true,
        totalEmails: true,
        processed: true,
        safe: true,
        risky: true,
        invalid: true,
        unknown: true,
        unverifiable: true,
      catchAll: true,
        status: true,
        concurrency: true,
        groupId: true,
        partNumber: true,
        startedAt: true,
        finishedAt: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    return NextResponse.json(jobs);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    console.error("[jobs/route] GET error:", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
