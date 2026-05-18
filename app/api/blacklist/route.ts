import { NextResponse } from "next/server";

// Only real blocklists — not reputation scoring services
const BLACKLISTS = [
  "zen.spamhaus.org",
  "bl.spamcop.net",
  "b.barracudacentral.org",
  "dnsbl.sorbs.net",
  "dnsbl-1.uceprotect.net",
  "psbl.surriel.com",
];

async function checkBlacklist(ip: string, blacklist: string): Promise<boolean> {
  try {
    // Reverse the IP for DNS lookup
    const reversed = ip.split(".").reverse().join(".");
    const lookup = `${reversed}.${blacklist}`;
    
    const res = await fetch(`https://dns.google/resolve?name=${lookup}&type=A`, {
      signal: AbortSignal.timeout(5000),
    });
    const data = await res.json();
    // If we get an A record answer, the IP is listed
    return data.Status === 0 && data.Answer && data.Answer.length > 0;
  } catch {
    return false; // timeout or error = not listed
  }
}

async function checkIP(ip: string) {
  const results = await Promise.all(
    BLACKLISTS.map(async (bl) => ({
      blacklist: bl,
      listed: await checkBlacklist(ip, bl),
    }))
  );
  
  return {
    ip,
    listed: results.filter((r) => r.listed).map((r) => r.blacklist),
    clean: results.filter((r) => !r.listed).map((r) => r.blacklist),
    checkedAt: new Date().toISOString(),
  };
}

export async function GET() {
  try {
    const raw = process.env.REACHER_BACKEND_URLS || "";
    const ips = raw.split(",").map((url) => {
      try { return new URL(url.trim()).hostname; } catch { return url.trim(); }
    }).filter(Boolean);

    if (ips.length === 0) {
      return NextResponse.json({ error: "No backend IPs configured" }, { status: 400 });
    }

    const results = await Promise.all(ips.map(checkIP));
    return NextResponse.json(results);
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
