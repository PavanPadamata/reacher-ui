/**
 * Multi-backend Reacher manager with per-backend rhythm control
 * and domain-aware IP rotation.
 *
 * Domain-aware rotation ensures consecutive emails to the same
 * domain (e.g. gmail.com) are spread across different backend IPs,
 * preventing any single IP from being rate-limited by one provider.
 */

export interface Backend {
  url: string;
  healthy: boolean;
  lastChecked: number;
  lastError: string | null;
  responseTime: number | null;

  // Daily tracking
  dailyCount: number;
  dailyLimit: number;
  lastReset: string; // YYYY-MM-DD

  // Rhythm tracking
  batchCount: number;
  batchSize: number;
  shortBreakMs: number;
  longBreakEvery: number;
  longBreakMs: number;
  batchesCompleted: number;
  coolingUntil: number;
  concurrency: number;
  activeRequests: number;
}

// Random int between min and max inclusive
function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function parseBackends(): Backend[] {
  const raw = process.env.REACHER_BACKEND_URLS || process.env.REACHER_BACKEND_URL || "http://localhost:8080";
  const dailyLimit     = parseInt(process.env.REACHER_DAILY_LIMIT_PER_BACKEND    || "80000");
  const batchSize      = parseInt(process.env.REACHER_BATCH_SIZE                 || "200");
  const shortBreakMin  = parseInt(process.env.REACHER_SHORT_BREAK_MINS           || "5");
  const longBreakMin   = parseInt(process.env.REACHER_LONG_BREAK_MINS            || "20");
  const longBreakEvery = parseInt(process.env.REACHER_LONG_BREAK_EVERY_BATCHES   || "6");
  const concurrency    = parseInt(process.env.REACHER_CONCURRENCY_PER_BACKEND    || "2");
  const today = new Date().toISOString().split("T")[0];

  return raw.split(",").map((url, idx) => ({
    url: url.trim(),
    healthy: true,
    lastChecked: 0,
    lastError: null,
    responseTime: null,
    dailyCount: 0,
    dailyLimit,
    lastReset: today,
    batchCount: 0,
    batchSize,
    shortBreakMs: (shortBreakMin * 60 * 1000) + (idx * 60 * 1000), // stagger per backend
    longBreakEvery,
    longBreakMs: longBreakMin * 60 * 1000,
    batchesCompleted: 0,
    coolingUntil: 0,
    concurrency,
    activeRequests: 0,
  }));
}

const backends: Backend[] = parseBackends();

// ── Domain → backend rotation tracking ────────────────────────────────────
// Tracks which backend index was last used for each MX host
// so consecutive probes to the same provider rotate IPs
const domainBackendIndex = new Map<string, number>();

// ── Daily reset ────────────────────────────────────────────────────────────
function resetDailyCountsIfNeeded() {
  const today = new Date().toISOString().split("T")[0];
  backends.forEach((b) => {
    if (b.lastReset !== today) {
      b.dailyCount = 0;
      b.lastReset = today;
      b.batchCount = 0;
      b.batchesCompleted = 0;
      b.coolingUntil = 0;
    }
  });
}

// ── Health check ───────────────────────────────────────────────────────────
export async function checkBackendHealth(backend: Backend): Promise<void> {
  const start = Date.now();
  try {
    const res = await fetch(`${backend.url}/v0/check_email`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to_email: "health@check.invalid" }),
      signal: AbortSignal.timeout(10000),
    });
    void res;
    backend.healthy = true;
    backend.lastError = null;
    backend.responseTime = Date.now() - start;
  } catch (err) {
    backend.healthy = false;
    backend.lastError = err instanceof Error ? err.message : "unreachable";
    backend.responseTime = null;
  }
  backend.lastChecked = Date.now();
}

export async function checkAllBackends(): Promise<void> {
  await Promise.all(backends.map(checkBackendHealth));
}

// ── Available backend pool ─────────────────────────────────────────────────
function getAvailableBackends(): Backend[] {
  resetDailyCountsIfNeeded();
  const now = Date.now();
  return backends.filter(
    (b) =>
      b.healthy &&
      b.dailyCount < b.dailyLimit &&
      now >= b.coolingUntil &&
      b.activeRequests < b.concurrency
  );
}

// ── Domain-aware backend selection ────────────────────────────────────────
// For a given MX host (e.g. "gmail-smtp-in.l.google.com"), always picks
// the next backend in rotation — so consecutive gmail probes cycle through
// all 3 IPs instead of hammering one.
export function getBackendForDomain(mxHost: string): Backend | null {
  const available = getAvailableBackends();
  if (available.length === 0) return null;

  // Get last used index for this MX host
  const lastIdx = domainBackendIndex.get(mxHost) ?? -1;

  // Find next available backend after lastIdx (wrap around)
  for (let i = 1; i <= available.length; i++) {
    const candidate = available[(lastIdx + i) % available.length];
    if (candidate) {
      // Update rotation pointer for this domain
      domainBackendIndex.set(mxHost, available.indexOf(candidate));
      return candidate;
    }
  }

  return available[0];
}

// ── Wait until a backend is available for a domain ────────────────────────
export async function waitForBackendForDomain(
  mxHost: string,
  timeoutMs = 30 * 60 * 1000
): Promise<Backend | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const b = getBackendForDomain(mxHost);
    if (b) return b;
    await new Promise((r) => setTimeout(r, 500));
  }
  return null;
}

// ── Random human-like delay ────────────────────────────────────────────────
export function getRequestDelay(): number {
  return randInt(1000, 4000);
}

// ── Record completed verification ─────────────────────────────────────────
export function recordVerification(url: string) {
  const b = backends.find((bk) => bk.url === url);
  if (!b) return;

  b.dailyCount++;
  b.batchCount++;
  b.activeRequests = Math.max(0, b.activeRequests - 1);

  if (b.batchCount >= b.batchSize) {
    b.batchCount = 0;
    b.batchesCompleted++;

    if (b.batchesCompleted % b.longBreakEvery === 0) {
      const jitter = randInt(0, 5 * 60 * 1000);
      b.coolingUntil = Date.now() + b.longBreakMs + jitter;
      console.log(`[backend ${url}] Long break for ${Math.round((b.coolingUntil - Date.now()) / 60000)} mins`);
    } else {
      const jitter = randInt(0, 60 * 1000);
      b.coolingUntil = Date.now() + b.shortBreakMs + jitter;
      console.log(`[backend ${url}] Short break for ${Math.round((b.coolingUntil - Date.now()) / 60000)} mins`);
    }
  }
}

export function reserveBackend(url: string) {
  const b = backends.find((bk) => bk.url === url);
  if (b) b.activeRequests++;
}

export function releaseBackend(url: string, error?: string) {
  const b = backends.find((bk) => bk.url === url);
  if (!b) return;
  b.activeRequests = Math.max(0, b.activeRequests - 1);
  if (error) b.lastError = error;
}

// ── Get all backends for dashboard ────────────────────────────────────────
export function getAllBackends(): (Backend & { coolingFor: number })[] {
  resetDailyCountsIfNeeded();
  const now = Date.now();
  return backends.map((b) => ({
    ...b,
    coolingFor: b.coolingUntil > now ? Math.round((b.coolingUntil - now) / 1000) : 0,
  }));
}

// ── Health check interval ──────────────────────────────────────────────────
let healthCheckInterval: ReturnType<typeof setInterval> | null = null;

export function startHealthChecks() {
  if (healthCheckInterval) return;
  checkAllBackends().catch(console.error);
  healthCheckInterval = setInterval(() => {
    checkAllBackends().catch(console.error);
  }, 2 * 60 * 1000);
}

// Random int between min and max inclusive
function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function parseBackends(): Backend[] {
  const raw = process.env.REACHER_BACKEND_URLS || process.env.REACHER_BACKEND_URL || "http://localhost:8080";
  const dailyLimit    = parseInt(process.env.REACHER_DAILY_LIMIT_PER_BACKEND || "40000");
  const batchSize     = parseInt(process.env.REACHER_BATCH_SIZE              || "200");
  const shortBreakMin = parseInt(process.env.REACHER_SHORT_BREAK_MINS        || "5");
  const longBreakMin  = parseInt(process.env.REACHER_LONG_BREAK_MINS         || "20");
  const longBreakEvery= parseInt(process.env.REACHER_LONG_BREAK_EVERY_BATCHES|| "6");
  const concurrency   = parseInt(process.env.REACHER_CONCURRENCY_PER_BACKEND || "2");
  const today = new Date().toISOString().split("T")[0];

  return raw.split(",").map((url, idx) => ({
    url: url.trim(),
    healthy: true,
    lastChecked: 0,
    lastError: null,
    responseTime: null,
    dailyCount: 0,
    dailyLimit,
    lastReset: today,
    batchCount: 0,
    batchSize,
    // Stagger short break slightly per backend so they don't all rest at once
    shortBreakMs: (shortBreakMin * 60 * 1000) + (idx * 60 * 1000),
    longBreakEvery,
    longBreakMs: longBreakMin * 60 * 1000,
    batchesCompleted: 0,
    coolingUntil: 0,
    concurrency,
    activeRequests: 0,
  }));
}

const backends: Backend[] = parseBackends();

// ── Daily reset ────────────────────────────────────────────────────────────
function resetDailyCountsIfNeeded() {
  const today = new Date().toISOString().split("T")[0];
  backends.forEach((b) => {
    if (b.lastReset !== today) {
      b.dailyCount = 0;
      b.lastReset = today;
      b.batchCount = 0;
      b.batchesCompleted = 0;
      b.coolingUntil = 0;
    }
  });
}

// ── Health check ───────────────────────────────────────────────────────────
export async function checkBackendHealth(backend: Backend): Promise<void> {
  const start = Date.now();
  try {
    const res = await fetch(`${backend.url}/v0/check_email`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to_email: "health@check.invalid" }),
      signal: AbortSignal.timeout(10000),
    });
    void res; // we don't care about the response body
    backend.healthy = true;
    backend.lastError = null;
    backend.responseTime = Date.now() - start;
  } catch (err) {
    backend.healthy = false;
    backend.lastError = err instanceof Error ? err.message : "unreachable";
    backend.responseTime = null;
  }
  backend.lastChecked = Date.now();
}

export async function checkAllBackends(): Promise<void> {
  await Promise.all(backends.map(checkBackendHealth));
}

// ── Backend selection ──────────────────────────────────────────────────────
// Returns a backend that is:
//   - healthy
//   - under daily limit
//   - not currently cooling down
//   - has capacity (activeRequests < concurrency)
export function getAvailableBackend(): Backend | null {
  resetDailyCountsIfNeeded();
  const now = Date.now();

  const available = backends.filter(
    (b) =>
      b.healthy &&
      b.dailyCount < b.dailyLimit &&
      now >= b.coolingUntil &&
      b.activeRequests < b.concurrency
  );

  if (available.length === 0) return null;

  // Pick the one with fewest active requests for natural load balancing
  return available.reduce((a, b) => a.activeRequests <= b.activeRequests ? a : b);
}

// ── Wait until a backend is available ─────────────────────────────────────
// Polls every 500ms — used by worker when all backends are busy/cooling
export async function waitForAvailableBackend(timeoutMs = 30 * 60 * 1000): Promise<Backend | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const b = getAvailableBackend();
    if (b) return b;
    await new Promise((r) => setTimeout(r, 500));
  }
  return null;
}

// ── Random human-like delay between requests ───────────────────────────────
export function getRequestDelay(): number {
  // 1–4 seconds, weighted toward 1.5–3s to feel natural
  return randInt(1000, 4000);
}

// ── Record completed verification on a backend ────────────────────────────
export function recordVerification(url: string) {
  const b = backends.find((bk) => bk.url === url);
  if (!b) return;

  b.dailyCount++;
  b.batchCount++;
  b.activeRequests = Math.max(0, b.activeRequests - 1);

  // Check if batch is complete
  if (b.batchCount >= b.batchSize) {
    b.batchCount = 0;
    b.batchesCompleted++;

    // Long break every N batches
    if (b.batchesCompleted % b.longBreakEvery === 0) {
      const jitter = randInt(0, 5 * 60 * 1000); // ±5 min jitter
      b.coolingUntil = Date.now() + b.longBreakMs + jitter;
      console.log(`[backend ${url}] Long break for ${Math.round((b.coolingUntil - Date.now()) / 60000)} mins`);
    } else {
      const jitter = randInt(0, 60 * 1000); // ±1 min jitter
      b.coolingUntil = Date.now() + b.shortBreakMs + jitter;
      console.log(`[backend ${url}] Short break for ${Math.round((b.coolingUntil - Date.now()) / 60000)} mins`);
    }
  }
}

// ── Mark backend as actively processing ───────────────────────────────────
export function reserveBackend(url: string) {
  const b = backends.find((bk) => bk.url === url);
  if (b) b.activeRequests++;
}

// ── Mark backend request failed ───────────────────────────────────────────
export function releaseBackend(url: string, error?: string) {
  const b = backends.find((bk) => bk.url === url);
  if (!b) return;
  b.activeRequests = Math.max(0, b.activeRequests - 1);
  if (error) b.lastError = error;
}

// ── Get all backends for dashboard ────────────────────────────────────────
export function getAllBackends(): (Backend & { coolingFor: number })[] {
  resetDailyCountsIfNeeded();
  const now = Date.now();
  return backends.map((b) => ({
    ...b,
    coolingFor: b.coolingUntil > now ? Math.round((b.coolingUntil - now) / 1000) : 0,
  }));
}

// ── Health check interval ──────────────────────────────────────────────────
let healthCheckInterval: ReturnType<typeof setInterval> | null = null;

export function startHealthChecks() {
  if (healthCheckInterval) return;
  checkAllBackends().catch(console.error);
  healthCheckInterval = setInterval(() => {
    checkAllBackends().catch(console.error);
  }, 2 * 60 * 1000);
}
