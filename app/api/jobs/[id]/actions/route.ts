import { NextRequest, NextResponse } from "next/server";
import { signalJob } from "@/lib/worker";
import { prisma } from "@/lib/prisma";

type Params = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, { params }: Params) {
  const { id } = await params;
  const url = new URL(req.url);
  const action = url.searchParams.get("action");

  if (action === "pause") {
    signalJob(id, "pause");
    await prisma.job.update({ where: { id }, data: { status: "PAUSED" } });
    return NextResponse.json({ ok: true });
  }

  if (action === "resume") {
    signalJob(id, null);
    await prisma.job.update({ where: { id }, data: { status: "RUNNING" } });
    return NextResponse.json({ ok: true });
  }

  if (action === "stop") {
    signalJob(id, "stop");
    await prisma.job.update({ where: { id }, data: { status: "STOPPED" } });
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}
