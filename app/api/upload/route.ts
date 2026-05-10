import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const config = { api: { bodyParser: false } };

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();
    const file = formData.get("file") as File | null;
    const concurrency = parseInt(formData.get("concurrency") as string) || 10;

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

    // Job name from filename (strip extension)
    const jobName = file.name.replace(/\.[^/.]+$/, "");

    // Create job
    const job = await prisma.job.create({
      data: {
        name: jobName,
        fileName: file.name,
        totalEmails: rows.length,
        concurrency,
        status: "PENDING",
        results: {
          create: rows.map((r) => ({
            email: r.email,
            name: r.name,
            status: "pending",
          })),
        },
      },
    });

    return NextResponse.json({ jobId: job.id, total: rows.length });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
