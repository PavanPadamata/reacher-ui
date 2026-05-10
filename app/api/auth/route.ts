import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";
import { createSession, deleteSession, getSession } from "@/lib/auth";

export async function POST(req: NextRequest) {
  const url = new URL(req.url);
  const action = url.searchParams.get("action");

  // ── Login ──────────────────────────────────────────────────────────
  if (action === "login") {
    const { email, password } = await req.json();
    if (!email || !password)
      return NextResponse.json({ error: "Email and password required" }, { status: 400 });

    const admin = await prisma.admin.findUnique({ where: { email: email.toLowerCase() } });
    if (!admin)
      return NextResponse.json({ error: "Invalid email or password" }, { status: 401 });

    const valid = await bcrypt.compare(password, admin.password);
    if (!valid)
      return NextResponse.json({ error: "Invalid email or password" }, { status: 401 });

    await createSession(admin.id);
    return NextResponse.json({ ok: true });
  }

  // ── Setup (first-time admin creation) ─────────────────────────────
  if (action === "setup") {
    const count = await prisma.admin.count();
    if (count > 0)
      return NextResponse.json({ error: "Admin already exists" }, { status: 400 });

    const { email, password } = await req.json();
    if (!email || !password)
      return NextResponse.json({ error: "Email and password required" }, { status: 400 });
    if (password.length < 8)
      return NextResponse.json({ error: "Password must be at least 8 characters" }, { status: 400 });

    const hashed = await bcrypt.hash(password, 12);
    const admin = await prisma.admin.create({
      data: { email: email.toLowerCase(), password: hashed },
    });

    await createSession(admin.id);
    return NextResponse.json({ ok: true });
  }

  // ── Logout ─────────────────────────────────────────────────────────
  if (action === "logout") {
    await deleteSession();
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}

// ── Check if setup needed ──────────────────────────────────────────
export async function GET() {
  const count = await prisma.admin.count();
  const session = await getSession();
  return NextResponse.json({ needsSetup: count === 0, authenticated: !!session });
}
