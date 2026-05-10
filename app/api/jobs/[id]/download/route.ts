import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

type Params = { params: Promise<{ id: string }> };

// ── Bucket definitions ─────────────────────────────────────────────────────
// valid   = safe + risky (catch-all) + unverifiable (enterprise M365 etc.)
// review  = unknown + error + risky (role accounts)
// invalid = invalid + disposable
// all     = everything

const BUCKET_MAP: Record<string, string[]> = {
  valid:   ["safe", "risky", "unverifiable"],
  review:  ["unknown", "error"],
  invalid: ["invalid"],
  all:     ["safe", "risky", "unverifiable", "unknown", "error", "invalid"],
};

export async function GET(req: NextRequest, { params }: Params) {
  const { id } = await params;
  const url = new URL(req.url);
  const bucket = url.searchParams.get("bucket") || "all";

  const job = await prisma.job.findUnique({ where: { id }, select: { name: true } });
  if (!job) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const statuses = BUCKET_MAP[bucket] || BUCKET_MAP.all;

  const results = await prisma.result.findMany({
    where: { jobId: id, status: { in: statuses } },
    select: { email: true, name: true, status: true },
    orderBy: { email: "asc" },
  });

  const header = "email,name\n";
  const rows = results.map((r) => [r.email, r.name].join(",")).join("\n");
  const filename = `${job.name}_${bucket}.csv`;

  return new NextResponse(header + rows, {
    headers: {
      "Content-Type": "text/csv",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}
