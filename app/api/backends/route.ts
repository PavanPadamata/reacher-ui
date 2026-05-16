import { NextResponse } from "next/server";
import { getAllBackends, checkAllBackends } from "@/lib/backends";

// GET /api/backends — get all backends status
export async function GET() {
  try {
    const backends = getAllBackends();
    return NextResponse.json(backends);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

// POST /api/backends — trigger health check
export async function POST() {
  try {
    await checkAllBackends();
    const backends = getAllBackends();
    return NextResponse.json(backends);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
