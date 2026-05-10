import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { runJob, signalJob } from "@/lib/worker";

type Params = { params: Promise<{ id: string }> };

// GET /api/jobs/[id] — job details
export async function GET(_req: NextRequest, { params }: Params) {
  const { id } = await params;
  const job = await prisma.job.findUnique({ where: { id } });
  if (!job) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json(job);
}

// POST /api/jobs/[id] — start job
export async function POST(_req: NextRequest, { params }: Params) {
  const { id } = await params;
  const job = await prisma.job.findUnique({ where: { id } });
  if (!job) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (job.status === "RUNNING") return NextResponse.json({ error: "Already running" }, { status: 400 });

  // Clear any old signals
  signalJob(id, null);

  // Run in background (don't await)
  runJob(id).catch(console.error);

  return NextResponse.json({ ok: true });
}

// DELETE /api/jobs/[id] — delete job and all results
export async function DELETE(_req: NextRequest, { params }: Params) {
  const { id } = await params;
  signalJob(id, "stop");
  await prisma.job.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}
