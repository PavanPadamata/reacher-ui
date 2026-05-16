import { NextResponse } from "next/server";
import { getAllBackends, checkAllBackends } from "@/lib/backends";

export async function GET() {
  try {
    return NextResponse.json(getAllBackends());
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

export async function POST() {
  try {
    await checkAllBackends();
    return NextResponse.json(getAllBackends());
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
