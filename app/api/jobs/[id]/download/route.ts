import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

type Params = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, { params }: Params) {
  const { id } = await params;
  const url = new URL(req.url);
  const statusFilter = url.searchParams.get("status"); // safe | risky | invalid | unknown | all

  const job = await prisma.job.findUnique({ where: { id }, select: { name: true } });
  if (!job) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const where: { jobId: string; status?: { in: string[] } } = { jobId: id };

  if (statusFilter && statusFilter !== "all") {
    if (statusFilter === "unknown") {
      where.status = { in: ["unknown", "error"] };
    } else {
      where.status = { in: [statusFilter] };
    }
  }

  const results = await prisma.result.findMany({
    where,
    select: {
      email: true,
      name: true,
      status: true,
    },
    orderBy: { email: "asc" },
  });

  // Build CSV
  const header = "email,name,status\n";
  const rows = results.map((r) =>
    [r.email, r.name, r.status].join(",")
  ).join("\n");

  const suffix = statusFilter && statusFilter !== "all" ? `_${statusFilter}` : "_all";
  const filename = `${job.name}${suffix}.csv`;

  return new NextResponse(header + rows, {
    headers: {
      "Content-Type": "text/csv",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}
