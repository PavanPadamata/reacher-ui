import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

type Params = { params: Promise<{ groupId: string }> };

export async function GET(req: NextRequest, { params }: Params) {
  const { groupId } = await params;
  const url = new URL(req.url);
  const statusFilter = url.searchParams.get("status") || "safe";

  const jobs = await prisma.job.findMany({
    where: { groupId },
    select: { id: true, name: true },
    orderBy: { partNumber: "asc" },
  });

  if (jobs.length === 0) {
    return NextResponse.json({ error: "Group not found" }, { status: 404 });
  }

  const jobIds = jobs.map((j) => j.id);
  const baseName = jobs[0].name.replace(/_part\d+$/, "");

  const where: { jobId: { in: string[] }; status?: { in: string[] } } = {
    jobId: { in: jobIds },
  };

  if (statusFilter !== "all") {
    where.status = statusFilter === "unknown"
      ? { in: ["unknown", "error"] }
      : { in: [statusFilter] };
  }

  const results = await prisma.result.findMany({
    where,
    select: { email: true, name: true, status: true },
    orderBy: { email: "asc" },
  });

  const header = "email,name,status\n";
  const rows = results.map((r) => [r.email, r.name, r.status].join(",")).join("\n");
  const filename = `${baseName}_merged_${statusFilter}.csv`;

  return new NextResponse(header + rows, {
    headers: {
      "Content-Type": "text/csv",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}
