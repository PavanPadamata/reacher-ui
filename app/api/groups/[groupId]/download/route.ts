import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

type Params = { params: Promise<{ groupId: string }> };

const BUCKET_MAP: Record<string, string[]> = {
  valid:   ["safe", "risky", "unverifiable"],
  review:  ["unknown", "error"],
  invalid: ["invalid"],
  all:     ["safe", "risky", "unverifiable", "unknown", "error", "invalid"],
};

export async function GET(req: NextRequest, { params }: Params) {
  const { groupId } = await params;
  const url = new URL(req.url);
  const bucket = url.searchParams.get("bucket") || "all";

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
  const statuses = BUCKET_MAP[bucket] || BUCKET_MAP.all;

  const results = await prisma.result.findMany({
    where: { jobId: { in: jobIds }, status: { in: statuses } },
    select: { email: true, name: true, status: true },
    orderBy: { email: "asc" },
  });

  const header = "email,name\n";
  const rows = results.map((r) => [r.email, r.name].join(",")).join("\n");
  const filename = `${baseName}_merged_${bucket}.csv`;

  return new NextResponse(header + rows, {
    headers: {
      "Content-Type": "text/csv",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}
