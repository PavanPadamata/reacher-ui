"use client";

import { useState, useRef, useCallback } from "react";
import {
  Upload,
  Download,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  HelpCircle,
  Loader2,
  Mail,
  ChevronDown,
  ChevronUp,
  BarChart3,
  FileText,
  X,
} from "lucide-react";
import Papa from "papaparse";

// ─── Types ────────────────────────────────────────────────────────────────────

type Status = "safe" | "risky" | "invalid" | "unknown" | "pending" | "error";

interface InputRow {
  email: string;
  name: string;
  [key: string]: string;
}

interface ResultRow {
  email: string;
  name: string;
  status: Status;
  is_reachable: string;
  is_disposable: boolean;
  is_role_account: boolean;
  is_catch_all: boolean;
  mx_accepts_mail: boolean;
  smtp_deliverable: boolean;
  smtp_disabled: boolean;
  raw_error?: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function classifyResult(data: Record<string, unknown>): Status {
  const reachable = data.is_reachable as string;
  if (reachable === "safe") return "safe";
  if (reachable === "risky") return "risky";
  if (reachable === "invalid") return "invalid";
  return "unknown";
}

function statusIcon(status: Status, size = 16) {
  const cls = `w-${size === 16 ? 4 : 5} h-${size === 16 ? 4 : 5}`;
  if (status === "safe") return <CheckCircle2 className={cls} style={{ color: "var(--safe)" }} />;
  if (status === "risky") return <AlertTriangle className={cls} style={{ color: "var(--risky)" }} />;
  if (status === "invalid") return <XCircle className={cls} style={{ color: "var(--invalid)" }} />;
  if (status === "pending") return <Loader2 className={`${cls} spin-slow`} style={{ color: "var(--text-muted)" }} />;
  if (status === "error") return <XCircle className={cls} style={{ color: "var(--invalid)" }} />;
  return <HelpCircle className={cls} style={{ color: "var(--unknown)" }} />;
}

function statusLabel(status: Status) {
  const map: Record<Status, { label: string; color: string }> = {
    safe: { label: "Safe", color: "var(--safe)" },
    risky: { label: "Risky", color: "var(--risky)" },
    invalid: { label: "Invalid", color: "var(--invalid)" },
    unknown: { label: "Unknown", color: "var(--unknown)" },
    pending: { label: "Checking…", color: "var(--text-muted)" },
    error: { label: "Error", color: "var(--invalid)" },
  };
  return map[status] || map.unknown;
}

function downloadCSV(rows: ResultRow[], filename: string) {
  const fields = ["email", "name", "status", "is_reachable", "is_disposable", "is_role_account", "is_catch_all", "mx_accepts_mail", "smtp_deliverable", "smtp_disabled"];
  const csv = Papa.unparse(rows.map((r) => {
    const obj: Record<string, unknown> = {};
    fields.forEach((f) => { obj[f] = (r as Record<string, unknown>)[f] ?? ""; });
    return obj;
  }));
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// ─── Component ────────────────────────────────────────────────────────────────

const CONCURRENCY = 3; // parallel requests to Reacher

export default function HomePage() {
  const [rows, setRows] = useState<ResultRow[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const [fileName, setFileName] = useState("");
  const [filterStatus, setFilterStatus] = useState<Status | "all">("all");
  const [expandedRow, setExpandedRow] = useState<number | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [startedAt, setStartedAt] = useState<Date | null>(null);
  const [finishedAt, setFinishedAt] = useState<Date | null>(null);
  const abortRef = useRef(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const processed = rows.filter((r) => r.status !== "pending").length;
  const total = rows.length;
  const progress = total > 0 ? Math.round((processed / total) * 100) : 0;

  const counts = {
    safe: rows.filter((r) => r.status === "safe").length,
    risky: rows.filter((r) => r.status === "risky").length,
    invalid: rows.filter((r) => r.status === "invalid").length,
    unknown: rows.filter((r) => r.status === "unknown" || r.status === "error").length,
    pending: rows.filter((r) => r.status === "pending").length,
  };

  const parseCSV = useCallback((file: File) => {
    setFileName(file.name);
    setRows([]);
    setStartedAt(null);
    setFinishedAt(null);

    Papa.parse<Record<string, string>>(file, {
      header: true,
      skipEmptyLines: true,
      complete: (result) => {
        const headers = result.meta.fields || [];
        const emailCol = headers.find((h) => h.toLowerCase().includes("email"));
        const nameCol = headers.find((h) => h.toLowerCase().includes("name"));

        if (!emailCol) {
          alert("CSV must have an 'email' column.");
          return;
        }

        const parsed: ResultRow[] = result.data
          .filter((row) => row[emailCol]?.trim())
          .map((row) => ({
            email: row[emailCol]?.trim() || "",
            name: nameCol ? (row[nameCol]?.trim() || "") : "",
            status: "pending",
            is_reachable: "",
            is_disposable: false,
            is_role_account: false,
            is_catch_all: false,
            mx_accepts_mail: false,
            smtp_deliverable: false,
            smtp_disabled: false,
          }));

        setRows(parsed);
      },
    });
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragging(false);
      const file = e.dataTransfer.files[0];
      if (file?.name.endsWith(".csv")) parseCSV(file);
    },
    [parseCSV]
  );

  const runVerification = useCallback(async () => {
    if (rows.length === 0) return;
    abortRef.current = false;
    setIsRunning(true);
    setStartedAt(new Date());
    setFinishedAt(null);

    // Reset all pending
    setRows((prev) =>
      prev.map((r) => ({ ...r, status: "pending" as Status }))
    );

    // Process with concurrency
    const queue = [...rows.map((_, i) => i)];
    let active = 0;

    await new Promise<void>((resolve) => {
      function next() {
        while (active < CONCURRENCY && queue.length > 0) {
          if (abortRef.current) { resolve(); return; }
          const idx = queue.shift()!;
          active++;
          verifyOne(idx).then(() => {
            active--;
            if (queue.length === 0 && active === 0) resolve();
            else next();
          });
        }
      }
      next();
    });

    setIsRunning(false);
    setFinishedAt(new Date());
  }, [rows]);

  async function verifyOne(idx: number) {
    const email = rows[idx].email;
    try {
      const res = await fetch("/api/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }

      const data = await res.json();
      const status = classifyResult(data);

      setRows((prev) => {
        const next = [...prev];
        next[idx] = {
          ...next[idx],
          status,
          is_reachable: data.is_reachable || "",
          is_disposable: data.misc?.is_disposable || false,
          is_role_account: data.misc?.is_role_account || false,
          is_catch_all: data.smtp?.is_catch_all || false,
          mx_accepts_mail: data.mx?.accepts_mail || false,
          smtp_deliverable: data.smtp?.is_deliverable || false,
          smtp_disabled: data.smtp?.is_disabled || false,
        };
        return next;
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "error";
      setRows((prev) => {
        const next = [...prev];
        next[idx] = { ...next[idx], status: "error", raw_error: msg };
        return next;
      });
    }
  }

  const filteredRows = filterStatus === "all"
    ? rows
    : rows.filter((r) =>
        filterStatus === "unknown"
          ? r.status === "unknown" || r.status === "error"
          : r.status === filterStatus
      );

  const elapsed = startedAt && finishedAt
    ? ((finishedAt.getTime() - startedAt.getTime()) / 1000).toFixed(1)
    : null;

  return (
    <div className="min-h-screen" style={{ background: "var(--bg)", fontFamily: "var(--font-sans)" }}>
      {/* Header */}
      <header style={{ borderBottom: "1px solid var(--border)" }} className="px-8 py-5 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ background: "var(--accent)", color: "#0a0f0d" }}>
            <Mail className="w-4 h-4" />
          </div>
          <div>
            <span className="font-semibold text-lg tracking-tight" style={{ color: "var(--text-primary)" }}>Reacher</span>
            <span className="ml-2 text-xs px-2 py-0.5 rounded-full font-medium" style={{ background: "var(--surface-2)", color: "var(--text-secondary)", border: "1px solid var(--border-2)" }}>
              Self-hosted
            </span>
          </div>
        </div>
        <p className="text-sm" style={{ color: "var(--text-muted)" }}>Bulk Email Verification</p>
      </header>

      <main className="max-w-6xl mx-auto px-6 py-10 space-y-8">

        {/* Upload Area */}
        {rows.length === 0 && (
          <div
            onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
            onDragLeave={() => setIsDragging(false)}
            onDrop={handleDrop}
            onClick={() => fileRef.current?.click()}
            className="rounded-2xl flex flex-col items-center justify-center cursor-pointer transition-all duration-200"
            style={{
              border: `2px dashed ${isDragging ? "var(--accent)" : "var(--border-2)"}`,
              background: isDragging ? "rgba(45,222,110,0.04)" : "var(--surface)",
              padding: "80px 40px",
              minHeight: "320px",
            }}
          >
            <div className="w-16 h-16 rounded-2xl flex items-center justify-center mb-6" style={{ background: "var(--surface-2)", border: "1px solid var(--border-2)" }}>
              <Upload className="w-7 h-7" style={{ color: isDragging ? "var(--accent)" : "var(--text-secondary)" }} />
            </div>
            <h2 className="text-xl font-semibold mb-2" style={{ color: "var(--text-primary)" }}>
              Drop your CSV here
            </h2>
            <p className="text-sm mb-6" style={{ color: "var(--text-muted)" }}>
              or click to browse — must have <code className="px-1.5 py-0.5 rounded text-xs" style={{ background: "var(--surface-2)", color: "var(--accent)" }}>email</code> and optionally <code className="px-1.5 py-0.5 rounded text-xs" style={{ background: "var(--surface-2)", color: "var(--text-secondary)" }}>name</code> columns
            </p>
            <button
              className="px-5 py-2.5 rounded-lg text-sm font-medium transition-colors"
              style={{ background: "var(--accent)", color: "#0a0f0d" }}
            >
              Select CSV File
            </button>
            <input
              ref={fileRef}
              type="file"
              accept=".csv"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) parseCSV(file);
              }}
            />
          </div>
        )}

        {/* Loaded but not started */}
        {rows.length > 0 && !isRunning && processed === 0 && (
          <div className="rounded-2xl p-6 flex items-center justify-between" style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
            <div className="flex items-center gap-4">
              <div className="w-10 h-10 rounded-xl flex items-center justify-center" style={{ background: "var(--surface-2)" }}>
                <FileText className="w-5 h-5" style={{ color: "var(--accent)" }} />
              </div>
              <div>
                <p className="font-medium" style={{ color: "var(--text-primary)" }}>{fileName}</p>
                <p className="text-sm" style={{ color: "var(--text-muted)" }}>{total} email{total !== 1 ? "s" : ""} loaded</p>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <button
                onClick={() => { setRows([]); setFileName(""); }}
                className="px-4 py-2 rounded-lg text-sm transition-colors"
                style={{ color: "var(--text-muted)", border: "1px solid var(--border-2)" }}
              >
                <X className="w-4 h-4 inline mr-1.5" />Clear
              </button>
              <button
                onClick={runVerification}
                className="px-5 py-2.5 rounded-lg text-sm font-semibold transition-all"
                style={{ background: "var(--accent)", color: "#0a0f0d" }}
              >
                Start Verification →
              </button>
            </div>
          </div>
        )}

        {/* Progress Bar (while running) */}
        {isRunning && (
          <div className="rounded-2xl p-6 space-y-4" style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Loader2 className="w-4 h-4 spin-slow" style={{ color: "var(--accent)" }} />
                <span className="text-sm font-medium" style={{ color: "var(--text-primary)" }}>
                  Verifying emails…
                </span>
              </div>
              <span className="text-sm font-mono" style={{ color: "var(--text-secondary)" }}>
                {processed} / {total}
              </span>
            </div>
            <div className="h-2 rounded-full overflow-hidden" style={{ background: "var(--surface-2)" }}>
              <div
                className="h-full rounded-full progress-shimmer transition-all duration-300"
                style={{ width: `${progress}%` }}
              />
            </div>
            <div className="flex gap-6 text-xs" style={{ color: "var(--text-muted)" }}>
              <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full inline-block" style={{ background: "var(--safe)" }} />{counts.safe} safe</span>
              <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full inline-block" style={{ background: "var(--risky)" }} />{counts.risky} risky</span>
              <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full inline-block" style={{ background: "var(--invalid)" }} />{counts.invalid} invalid</span>
              <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full inline-block" style={{ background: "var(--unknown)" }} />{counts.unknown} unknown</span>
              <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full inline-block" style={{ background: "var(--text-muted)" }} />{counts.pending} pending</span>
            </div>
            <button
              onClick={() => { abortRef.current = true; setIsRunning(false); }}
              className="text-xs px-3 py-1.5 rounded-lg"
              style={{ color: "var(--invalid)", border: "1px solid var(--invalid)", opacity: 0.7 }}
            >
              Stop
            </button>
          </div>
        )}

        {/* Summary + Downloads (after done) */}
        {processed > 0 && !isRunning && (
          <div className="rounded-2xl p-6 space-y-5" style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <BarChart3 className="w-4 h-4" style={{ color: "var(--accent)" }} />
                <span className="font-semibold" style={{ color: "var(--text-primary)" }}>
                  Results — {processed} of {total} verified
                  {elapsed && <span className="ml-2 text-sm font-normal" style={{ color: "var(--text-muted)" }}>in {elapsed}s</span>}
                </span>
              </div>
              <button
                onClick={() => { setRows([]); setFileName(""); setStartedAt(null); setFinishedAt(null); }}
                className="text-xs px-3 py-1.5 rounded-lg flex items-center gap-1.5"
                style={{ color: "var(--text-muted)", border: "1px solid var(--border-2)" }}
              >
                <X className="w-3 h-3" /> New Upload
              </button>
            </div>

            {/* Stat Cards */}
            <div className="grid grid-cols-4 gap-3">
              {(["safe", "risky", "invalid", "unknown"] as const).map((s) => {
                const pct = total > 0 ? Math.round((counts[s] / total) * 100) : 0;
                const sl = statusLabel(s);
                return (
                  <button
                    key={s}
                    onClick={() => setFilterStatus(filterStatus === s ? "all" : s)}
                    className="rounded-xl p-4 text-left transition-all"
                    style={{
                      background: filterStatus === s ? "rgba(45,222,110,0.06)" : "var(--surface-2)",
                      border: `1px solid ${filterStatus === s ? "var(--accent)" : "var(--border-2)"}`,
                    }}
                  >
                    <div className="flex items-center justify-between mb-2">
                      {statusIcon(s, 20)}
                      <span className="text-2xl font-bold font-mono" style={{ color: sl.color }}>{counts[s]}</span>
                    </div>
                    <p className="text-sm font-medium" style={{ color: sl.color }}>{sl.label}</p>
                    <p className="text-xs mt-0.5" style={{ color: "var(--text-muted)" }}>{pct}% of total</p>
                  </button>
                );
              })}
            </div>

            {/* Download Buttons */}
            <div className="flex flex-wrap gap-2 pt-1">
              <button
                onClick={() => downloadCSV(rows, "all_results.csv")}
                className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium"
                style={{ background: "var(--accent)", color: "#0a0f0d" }}
              >
                <Download className="w-4 h-4" /> Download All ({total})
              </button>
              {(["safe", "risky", "invalid", "unknown"] as const).map((s) => {
                const filtered = rows.filter((r) => s === "unknown" ? (r.status === "unknown" || r.status === "error") : r.status === s);
                if (filtered.length === 0) return null;
                const sl = statusLabel(s);
                return (
                  <button
                    key={s}
                    onClick={() => downloadCSV(filtered, `${s}_emails.csv`)}
                    className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm"
                    style={{ border: `1px solid var(--border-2)`, color: sl.color }}
                  >
                    <Download className="w-3.5 h-3.5" /> {sl.label} ({filtered.length})
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* Results Table */}
        {rows.length > 0 && (
          <div className="rounded-2xl overflow-hidden" style={{ border: "1px solid var(--border)" }}>
            {/* Filter tabs */}
            <div className="flex items-center gap-1 px-4 py-3" style={{ background: "var(--surface)", borderBottom: "1px solid var(--border)" }}>
              {(["all", "safe", "risky", "invalid", "unknown"] as const).map((f) => {
                const count = f === "all" ? total : f === "unknown" ? counts.unknown : counts[f];
                return (
                  <button
                    key={f}
                    onClick={() => setFilterStatus(f)}
                    className="px-3 py-1.5 rounded-lg text-xs font-medium capitalize transition-colors"
                    style={{
                      background: filterStatus === f ? "var(--surface-2)" : "transparent",
                      color: filterStatus === f ? "var(--text-primary)" : "var(--text-muted)",
                      border: filterStatus === f ? "1px solid var(--border-2)" : "1px solid transparent",
                    }}
                  >
                    {f === "all" ? "All" : f.charAt(0).toUpperCase() + f.slice(1)} ({count})
                  </button>
                );
              })}
            </div>

            {/* Table */}
            <div style={{ background: "var(--bg)", maxHeight: "520px", overflowY: "auto" }}>
              <table className="w-full text-sm">
                <thead style={{ position: "sticky", top: 0, background: "var(--surface)", borderBottom: "1px solid var(--border)" }}>
                  <tr>
                    <th className="text-left px-4 py-3 text-xs font-medium uppercase tracking-wider" style={{ color: "var(--text-muted)", width: "40px" }}>#</th>
                    <th className="text-left px-4 py-3 text-xs font-medium uppercase tracking-wider" style={{ color: "var(--text-muted)" }}>Email</th>
                    <th className="text-left px-4 py-3 text-xs font-medium uppercase tracking-wider" style={{ color: "var(--text-muted)" }}>Name</th>
                    <th className="text-left px-4 py-3 text-xs font-medium uppercase tracking-wider" style={{ color: "var(--text-muted)" }}>Status</th>
                    <th className="text-left px-4 py-3 text-xs font-medium uppercase tracking-wider" style={{ color: "var(--text-muted)" }}>Details</th>
                    <th className="px-4 py-3 w-8" />
                  </tr>
                </thead>
                <tbody>
                  {filteredRows.map((row, i) => {
                    const realIdx = rows.indexOf(row);
                    const sl = statusLabel(row.status);
                    const isExpanded = expandedRow === realIdx;

                    return (
                      <>
                        <tr
                          key={realIdx}
                          style={{
                            borderBottom: "1px solid var(--border)",
                            background: isExpanded ? "var(--surface)" : "transparent",
                          }}
                        >
                          <td className="px-4 py-3 font-mono text-xs" style={{ color: "var(--text-muted)" }}>{i + 1}</td>
                          <td className="px-4 py-3 font-mono text-xs" style={{ color: "var(--text-primary)" }}>{row.email}</td>
                          <td className="px-4 py-3" style={{ color: "var(--text-secondary)" }}>{row.name || "—"}</td>
                          <td className="px-4 py-3">
                            <span className="flex items-center gap-1.5">
                              {statusIcon(row.status)}
                              <span className="text-xs font-medium" style={{ color: sl.color }}>{sl.label}</span>
                            </span>
                          </td>
                          <td className="px-4 py-3">
                            {row.status !== "pending" && row.status !== "error" && (
                              <div className="flex flex-wrap gap-1">
                                {row.is_disposable && <Tag label="Disposable" color="var(--invalid)" />}
                                {row.is_catch_all && <Tag label="Catch-all" color="var(--risky)" />}
                                {row.is_role_account && <Tag label="Role" color="var(--risky)" />}
                                {!row.mx_accepts_mail && <Tag label="No MX" color="var(--invalid)" />}
                              </div>
                            )}
                            {row.status === "error" && (
                              <span className="text-xs font-mono" style={{ color: "var(--invalid)" }}>{row.raw_error}</span>
                            )}
                          </td>
                          <td className="px-4 py-3">
                            {row.status !== "pending" && (
                              <button
                                onClick={() => setExpandedRow(isExpanded ? null : realIdx)}
                                style={{ color: "var(--text-muted)" }}
                              >
                                {isExpanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                              </button>
                            )}
                          </td>
                        </tr>
                        {isExpanded && (
                          <tr key={`${realIdx}-detail`} style={{ background: "var(--surface-2)", borderBottom: "1px solid var(--border)" }}>
                            <td colSpan={6} className="px-6 py-4">
                              <div className="grid grid-cols-3 gap-4 text-xs">
                                <Detail label="Is Reachable" value={row.is_reachable} />
                                <Detail label="MX Accepts Mail" value={row.mx_accepts_mail ? "Yes" : "No"} />
                                <Detail label="SMTP Deliverable" value={row.smtp_deliverable ? "Yes" : "No"} />
                                <Detail label="SMTP Disabled" value={row.smtp_disabled ? "Yes" : "No"} />
                                <Detail label="Disposable" value={row.is_disposable ? "Yes" : "No"} />
                                <Detail label="Catch-all" value={row.is_catch_all ? "Yes" : "No"} />
                                <Detail label="Role Account" value={row.is_role_account ? "Yes" : "No"} />
                              </div>
                            </td>
                          </tr>
                        )}
                      </>
                    );
                  })}
                </tbody>
              </table>
              {filteredRows.length === 0 && (
                <div className="py-16 text-center" style={{ color: "var(--text-muted)" }}>
                  No emails in this category yet.
                </div>
              )}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

// ─── Small Sub-components ─────────────────────────────────────────────────────

function Tag({ label, color }: { label: string; color: string }) {
  return (
    <span
      className="px-1.5 py-0.5 rounded text-xs"
      style={{ background: `${color}18`, color, border: `1px solid ${color}40` }}
    >
      {label}
    </span>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p style={{ color: "var(--text-muted)" }}>{label}</p>
      <p className="font-mono mt-0.5" style={{ color: "var(--text-primary)" }}>{value}</p>
    </div>
  );
}
