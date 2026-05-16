/**
 * Multi-backend Reacher manager
 * Maintains a pool of Reacher backend URLs, tracks health,
 * and provides round-robin selection with automatic failover.
 */

export interface Backend {
  url: string;
  healthy: boolean;
  lastChecked: number;
  lastError: string | null;
  responseTime: number | null; // ms
  dailyCount: number;
  dailyLimit: number;
  lastReset: string; // YYYY-MM-DD
}

// Parse backend URLs from env — comma separated
// e.g. REACHER_BACKEND_URLS=http://1.2.3.4:8080,http://5.6.7.8:8080
function parseBackends(): Backend[] {
  const raw = process.env.REACHER_BACKEND_URLS || process.env.REACHER_BACKEND_URL || "http://localhost:8080";
  const dailyLimit = parseInt(process.env.REACHER_DAILY_LIMIT_PER_BACKEND || "50000");
  const today = new Date().toISOString().split("T")[0];

  return raw.split(",").map((url) => ({
    url: url.trim(),
    healthy: true,
    lastChecked: 0,
    lastError: null,
    responseTime: null,
    dailyCount: 0,
    dailyLimit,
    lastReset: today,
  }));
}

// Module-level backend pool
const backends: Backend[] = parseBackends();
let rrIndex = 0; // round-robin pointer

// Reset daily counts at midnight
function resetDailyCountsIfNeeded() {
  const today = new Date().toISOString().split("T")[0];
  backends.forEach((b) => {
    if (b.lastReset !== today) {
      b.dailyCount = 0;
      b.lastReset = today;
    }
  });
}

// Health check a single backend
export async function checkBackendHealth(backend: Backend): Promise<void> {
  const start = Date.now();
  try {
    const res = await fetch(`${backend.url}/v0/check_email`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to_email: "health@check.invalid" }),
      signal: AbortSignal.timeout(10000),
    });
    // Any response (even error) means backend is reachable
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

// Health check all backends
export async function checkAllBackends(): Promise<void> {
  await Promise.all(backends.map(checkBackendHealth));
}

// Get next available healthy backend (round-robin, skips unhealthy + over daily limit)
export function getNextBackend(): Backend | null {
  resetDailyCountsIfNeeded();

  const available = backends.filter(
    (b) => b.healthy && b.dailyCount < b.dailyLimit
  );

  if (available.length === 0) return null;

  const backend = available[rrIndex % available.length];
  rrIndex++;
  return backend;
}

// Mark a backend as failed (called when a request fails)
export function markBackendFailed(url: string, error: string) {
  const backend = backends.find((b) => b.url === url);
  if (backend) {
    backend.lastError = error;
    // Don't mark unhealthy on single failure — only after health check
  }
}

// Increment daily count for a backend
export function incrementBackendCount(url: string) {
  const backend = backends.find((b) => b.url === url);
  if (backend) backend.dailyCount++;
}

// Get all backends status (for settings page)
export function getAllBackends(): Backend[] {
  resetDailyCountsIfNeeded();
  return backends.map((b) => ({ ...b }));
}

// Run health checks every 2 minutes
let healthCheckInterval: ReturnType<typeof setInterval> | null = null;

export function startHealthChecks() {
  if (healthCheckInterval) return;
  // Initial check
  checkAllBackends().catch(console.error);
  // Then every 2 minutes
  healthCheckInterval = setInterval(() => {
    checkAllBackends().catch(console.error);
  }, 2 * 60 * 1000);
}
