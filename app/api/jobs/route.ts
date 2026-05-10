import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function GET() {
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
      status: true,
      concurrency: true,
      startedAt: true,
      finishedAt: true,
      createdAt: true,
      updatedAt: true,
    },
  });
  return NextResponse.json(jobs);
}
