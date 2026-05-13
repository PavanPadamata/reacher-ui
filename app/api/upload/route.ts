import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

// Increase body size limit to 200MB for large CSVs
export const maxDuration = 300; // 5 min timeout
export const dynamic = "force-dynamic";

// Tell Next.js to allow large request bodies
export const fetchCache = "force-no-store";

const SPLIT_THRESHOLD = 500000;
const BATCH_SIZE = 1000; // insert 1000 rows at a time

async function createJob(
  name: string,
  fileName: string,
  rows: { email: string; name: string }[],
  concurrency: number,
  groupId?: string,
  partNumber?: number
) {
  // Create job first
  const job = await prisma.job.create({
    data: {
      name,
      fileName,
      totalEmails: rows.length,
      concurrency,
      status: "PENDING",
      groupId: groupId || null,
      partNumber: partNumber || null,
    },
  });

  // Batch insert results in chunks of 1000
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    await prisma.result.createMany({
      data: batch.map((r) => ({
        jobId: job.id,
        email: r.email,
        name: r.name,
        status: "pending",
      })),
    });
  }

  return job;
}

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();
    const file = formData.get("file") as File | null;
    // Accept raw concurrency number (1-50) from slider
    const rawConcurrency = parseInt(formData.get("concurrency") as string);
    const concurrency = isNaN(rawConcurrency) ? 8 : Math.max(1, Math.min(50, rawConcurrency));
    const forceSingle = formData.get("forceSingle") === "true";

    if (!file) return NextResponse.json({ error: "No file" }, { status: 400 });

    const text = await file.text();
    const lines = text.split("\n").filter(Boolean);
    if (lines.length < 2) return NextResponse.json({ error: "CSV is empty" }, { status: 400 });

    // Parse header
    const header = lines[0].split(",").map((h) => h.trim().toLowerCase().replace(/"/g, ""));
    const emailIdx = header.findIndex((h) => h.includes("email"));
    const nameIdx = header.findIndex((h) => h.includes("name"));

    if (emailIdx === -1) return NextResponse.json({ error: "CSV must have an 'email' column" }, { status: 400 });

    // Parse rows
    const rows: { email: string; name: string }[] = [];
    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split(",").map((c) => c.trim().replace(/"/g, ""));
      const email = cols[emailIdx]?.trim();
      if (!email || !email.includes("@")) continue;
      const name = nameIdx >= 0 ? (cols[nameIdx]?.trim() || "") : "";
      rows.push({ email: email.toLowerCase(), name });
    }

    if (rows.length === 0) return NextResponse.json({ error: "No valid emails found" }, { status: 400 });

    const jobName = file.name.replace(/\.[^/.]+$/, "");

    // If over threshold and not forced single → tell client to confirm split
    if (rows.length > SPLIT_THRESHOLD && !forceSingle) {
      return NextResponse.json({
        requiresSplit: true,
        total: rows.length,
        part1: Math.ceil(rows.length / 2),
        part2: Math.floor(rows.length / 2),
      });
    }

    // Auto-split into two jobs
    if (rows.length > SPLIT_THRESHOLD) {
      const mid = Math.ceil(rows.length / 2);
      const part1 = rows.slice(0, mid);
      const part2 = rows.slice(mid);
      const groupId = `${jobName}-${Date.now()}`;

      const [job1, job2] = await Promise.all([
        createJob(`${jobName}_part1`, file.name, part1, concurrency, groupId, 1),
        createJob(`${jobName}_part2`, file.name, part2, concurrency, groupId, 2),
      ]);

      return NextResponse.json({
        split: true,
        groupId,
        jobs: [
          { jobId: job1.id, name: job1.name, total: part1.length },
          { jobId: job2.id, name: job2.name, total: part2.length },
        ],
      });
    }

    // Normal single job
    const job = await createJob(jobName, file.name, rows, concurrency);
    return NextResponse.json({ jobId: job.id, total: rows.length });

  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
