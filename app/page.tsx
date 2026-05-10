"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import {
  Upload, Sun, Moon, Play, Pause, Square, Trash2,
  Download, CheckCircle, AlertTriangle, XCircle,
  Loader2, Mail, Clock, Zap, Plus, X, LogOut
} from "lucide-react";

// ── Types ─────────────────────────────────────────────────────────────────────

type JobStatus = "PENDING" | "RUNNING" | "PAUSED" | "COMPLETED" | "STOPPED" | "FAILED";

interface Job {
  id: string;
  name: string;
  fileName: string;
  totalEmails: number;
  processed: number;
  safe: number;
  risky: number;
  invalid: number;
  unknown: number;
  unverifiable: number;
  status: JobStatus;
  concurrency: number;
  groupId: string | null;
  partNumber: number | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmt(n: number) { return n.toLocaleString(); }

function elapsed(startedAt: string | null, finishedAt: string | null): string {
  if (!startedAt) return "—";
  const start = new Date(startedAt).getTime();
  const end = finishedAt ? new Date(finishedAt).getTime() : Date.now();
  const secs = Math.floor((end - start) / 1000);
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ${secs % 60}s`;
  return `${Math.floor(secs / 3600)}h ${Math.floor((secs % 3600) / 60)}m`;
}

function eta(job: Job): string {
  if (!job.startedAt || job.processed === 0) return "Calculating…";
  const secs = (Date.now() - new Date(job.startedAt).getTime()) / 1000;
  const rate = job.processed / secs;
  const remaining = job.totalEmails - job.processed;
  const etaSecs = Math.round(remaining / rate);
  if (etaSecs < 60) return `~${etaSecs}s left`;
  if (etaSecs < 3600) return `~${Math.floor(etaSecs / 60)}m left`;
  return `~${Math.floor(etaSecs / 3600)}h ${Math.floor((etaSecs % 3600) / 60)}m left`;
}

function speed(job: Job): string {
  if (!job.startedAt || job.processed === 0) return "—";
  const secs = (Date.now() - new Date(job.startedAt).getTime()) / 1000;
  return `${Math.round((job.processed / secs) * 60)}/min`;
}

const STATUS_CONFIG: Record<JobStatus, { label: string; color: string; dot: string }> = {
  PENDING:   { label: "Pending",   color: "var(--text-3)",   dot: "var(--text-4)" },
  RUNNING:   { label: "Running",   color: "var(--accent)",   dot: "var(--accent)" },
  PAUSED:    { label: "Paused",    color: "var(--risky)",    dot: "var(--risky)" },
  COMPLETED: { label: "Completed", color: "var(--safe)",     dot: "var(--safe)" },
  STOPPED:   { label: "Stopped",   color: "var(--text-3)",   dot: "var(--text-3)" },
  FAILED:    { label: "Failed",    color: "var(--invalid)",  dot: "var(--invalid)" },
};

// ── Theme Toggle ──────────────────────────────────────────────────────────────

function ThemeToggle() {
  const [dark, setDark] = useState(false);
  useEffect(() => {
    setDark(document.documentElement.getAttribute("data-theme") === "dark");
  }, []);
  const toggle = () => {
    const next = dark ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    localStorage.setItem("theme", next);
    setDark(!dark);
  };
  return (
    <button onClick={toggle} className="icon-btn" title="Toggle theme">
      {dark ? <Sun size={16} /> : <Moon size={16} />}
    </button>
  );
}

// ── Upload Modal ──────────────────────────────────────────────────────────────

function UploadModal({ onClose, onUploaded }: { onClose: () => void; onUploaded: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [preset, setPreset] = useState<"safe" | "balanced" | "fast" | "maximum">("safe");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [dragging, setDragging] = useState(false);
  const [splitInfo, setSplitInfo] = useState<{ total: number; part1: number; part2: number } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const PRESETS = [
    { key: "safe",     label: "🐢 Safe",     desc: "8 total · 1 per domain · 1s cooldown",  note: "Recommended for Gmail/Yahoo heavy lists" },
    { key: "balanced", label: "⚡ Balanced",  desc: "15 total · 2 per domain · 500ms cooldown", note: "Good for mixed lists" },
    { key: "fast",     label: "🚀 Fast",      desc: "30 total · 3 per domain · 200ms cooldown", note: "For corporate/B2B lists" },
    { key: "maximum",  label: "⚠️ Maximum",   desc: "50 total · 3 per domain · no cooldown", note: "Use with SMTP proxies only" },
  ] as const;

  const handleFile = (f: File) => {
    if (!f.name.endsWith(".csv")) { setError("Only CSV files are supported"); return; }
    setFile(f);
    setError("");
    setSplitInfo(null);
  };

  const upload = async (forceSingle = false) => {
    if (!file) return;
    setLoading(true);
    setError("");
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("preset", preset);
      if (forceSingle) fd.append("forceSingle", "true");
      const res = await fetch("/api/upload", { method: "POST", body: fd });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      if (data.requiresSplit) {
        setSplitInfo({ total: data.total, part1: data.part1, part2: data.part2 });
        setLoading(false);
        return;
      }
      onUploaded();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setLoading(false);
    }
  };

  // Split confirmation screen
  if (splitInfo) return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2 className="modal-title">Large list detected</h2>
          <button className="icon-btn" onClick={onClose}><X size={16} /></button>
        </div>
        <div className="split-info">
          <div className="split-icon">⚡</div>
          <p className="split-title">This list has <strong>{fmt(splitInfo.total)}</strong> emails</p>
          <p className="split-desc">For best reliability we recommend splitting into 2 jobs of ~500k each. Both jobs will appear in the dashboard and you can start them independently.</p>
          <div className="split-preview">
            <div className="split-part">
              <span className="split-part-label">Part 1</span>
              <span className="split-part-count">{fmt(splitInfo.part1)} emails</span>
            </div>
            <div className="split-divider">+</div>
            <div className="split-part">
              <span className="split-part-label">Part 2</span>
              <span className="split-part-count">{fmt(splitInfo.part2)} emails</span>
            </div>
          </div>
          <p className="split-hint">A merged download option will appear once both parts are done.</p>
        </div>
        {error && <p className="error-msg">{error}</p>}
        <div className="modal-footer">
          <button className="btn btn-ghost" onClick={() => upload(true)} disabled={loading}>
            {loading ? <Loader2 size={14} className="spin" /> : null} Single job anyway
          </button>
          <button className="btn btn-primary" onClick={() => upload(false)} disabled={loading}>
            {loading ? <Loader2 size={14} className="spin" /> : "✂️"} Split into 2 jobs
          </button>
        </div>
      </div>
    </div>
  );

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2 className="modal-title">New Verification Job</h2>
          <button className="icon-btn" onClick={onClose}><X size={16} /></button>
        </div>

        {/* Drop zone */}
        <div
          className={`dropzone${dragging ? " dragging" : ""}${file ? " has-file" : ""}`}
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => { e.preventDefault(); setDragging(false); const f = e.dataTransfer.files[0]; if (f) handleFile(f); }}
          onClick={() => inputRef.current?.click()}
        >
          <input ref={inputRef} type="file" accept=".csv" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); }} />
          {file ? (
            <div className="dropzone-file">
              <div className="dropzone-file-icon"><Mail size={20} /></div>
              <div>
                <p className="dropzone-file-name">{file.name}</p>
                <p className="dropzone-file-size">{(file.size / 1024).toFixed(1)} KB</p>
              </div>
            </div>
          ) : (
            <>
              <div className="dropzone-icon"><Upload size={22} /></div>
              <p className="dropzone-label">Drop your CSV here or <span className="link">browse</span></p>
              <p className="dropzone-hint">Must have an <code>email</code> column. <code>name</code> is optional.</p>
            </>
          )}
        </div>

        {/* Preset selector */}
        <div className="field">
          <label className="field-label">Speed Preset</label>
          <div className="preset-grid">
            {PRESETS.map((p) => (
              <button
                key={p.key}
                type="button"
                onClick={() => setPreset(p.key)}
                className={`preset-card${preset === p.key ? " active" : ""}`}
              >
                <span className="preset-label">{p.label}</span>
                <span className="preset-desc">{p.desc}</span>
                <span className="preset-note">{p.note}</span>
              </button>
            ))}
          </div>
        </div>

        {error && <p className="error-msg">{error}</p>}

        <div className="modal-footer">
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={() => upload(false)} disabled={!file || loading}>
            {loading ? <><Loader2 size={14} className="spin" /> Uploading…</> : <><Plus size={14} /> Create Job</>}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Job Card ──────────────────────────────────────────────────────────────────

function JobCard({ job, onAction }: { job: Job; onAction: () => void }) {
  const pct = job.totalEmails > 0 ? Math.round((job.processed / job.totalEmails) * 100) : 0;
  const sc = STATUS_CONFIG[job.status];
  const isActive = job.status === "RUNNING";
  const isPaused = job.status === "PAUSED";
  const isDone = ["COMPLETED", "STOPPED", "FAILED"].includes(job.status);
  const canStart = ["PENDING", "STOPPED", "PAUSED"].includes(job.status);

  const action = async (type: string) => {
    if (type === "delete") {
      if (!confirm(`Delete "${job.name}"? This cannot be undone.`)) return;
      await fetch(`/api/jobs/${job.id}`, { method: "DELETE" });
    } else if (type === "start") {
      await fetch(`/api/jobs/${job.id}`, { method: "POST" });
    } else {
      await fetch(`/api/jobs/${job.id}/actions?action=${type}`, { method: "POST" });
    }
    onAction();
  };

  const download = (bucket: string) => {
    window.open(`/api/jobs/${job.id}/download?bucket=${bucket}`, "_blank");
  };

  return (
    <div className="job-card fade-up">
      {/* Header */}
      <div className="job-header">
        <div className="job-title-row">
          <h3 className="job-name">{job.name}</h3>
          <span className="status-badge" style={{ color: sc.color, borderColor: `${sc.color}30`, background: `${sc.color}10` }}>
            {isActive && <span className="pulse-dot" style={{ background: sc.dot }} />}
            {sc.label}
          </span>
        </div>
        <p className="job-meta">{job.fileName} · {fmt(job.totalEmails)} emails · { {1:"🐢 Safe", 2:"⚡ Balanced", 3:"🚀 Fast", 4:"⚠️ Maximum"}[job.concurrency] || "Custom" }</p>
      </div>

      {/* Progress bar */}
      <div className="progress-track">
        <div
          className={`progress-fill${isActive ? " progress-bar" : ""}`}
          style={{ width: `${pct}%`, background: isActive ? undefined : isDone && job.status === "COMPLETED" ? "var(--safe)" : "var(--border-2)" }}
        />
      </div>

      {/* Stats row */}
      <div className="job-stats">
        <div className="stat">
          <CheckCircle size={13} style={{ color: "var(--safe)" }} />
          <span className="stat-val" style={{ color: "var(--safe)" }}>{fmt(job.safe + job.risky + job.unverifiable)}</span>
          <span className="stat-label">Valid</span>
        </div>
        <div className="stat">
          <AlertTriangle size={13} style={{ color: "var(--risky)" }} />
          <span className="stat-val" style={{ color: "var(--risky)" }}>{fmt(job.unknown)}</span>
          <span className="stat-label">Review</span>
        </div>
        <div className="stat">
          <XCircle size={13} style={{ color: "var(--invalid)" }} />
          <span className="stat-val" style={{ color: "var(--invalid)" }}>{fmt(job.invalid)}</span>
          <span className="stat-label">Invalid</span>
        </div>
        <div className="stat-divider" />
        <div className="stat">
          <Clock size={13} style={{ color: "var(--text-3)" }} />
          <span className="stat-val">{elapsed(job.startedAt, job.finishedAt)}</span>
          <span className="stat-label">{isDone ? "Total" : "Elapsed"}</span>
        </div>
        {isActive && (
          <div className="stat">
            <Zap size={13} style={{ color: "var(--accent)" }} />
            <span className="stat-val" style={{ color: "var(--accent)" }}>{speed(job)}</span>
            <span className="stat-label">Speed</span>
          </div>
        )}
        <div className="stat-progress">
          <span className="stat-pct">{pct}%</span>
          <span className="stat-label">{fmt(job.processed)} / {fmt(job.totalEmails)}</span>
          {isActive && <span className="stat-eta">{eta(job)}</span>}
        </div>
      </div>

      {/* Actions */}
      <div className="job-actions">
        {/* Controls */}
        <div className="job-controls">
          {canStart && (
            <button className="btn btn-primary btn-sm" onClick={() => action("start")}>
              <Play size={13} /> {isPaused ? "Resume" : "Start"}
            </button>
          )}
          {isActive && (
            <button className="btn btn-ghost btn-sm" onClick={() => action("pause")}>
              <Pause size={13} /> Pause
            </button>
          )}
          {(isActive || isPaused) && (
            <button className="btn btn-ghost btn-sm" onClick={() => action("stop")}>
              <Square size={13} /> Stop
            </button>
          )}
        </div>

        {/* Downloads + Delete */}
        <div className="job-downloads">
          {(isDone || job.processed > 0) && (
            <>
              <button className="btn btn-ghost btn-sm download-safe" onClick={() => download("valid")}>
                <Download size={12} /> Valid ({fmt(job.safe + job.risky + job.unverifiable)})
              </button>
              <button className="btn btn-ghost btn-sm download-risky" onClick={() => download("review")}>
                <Download size={12} /> Review ({fmt(job.unknown)})
              </button>
              <button className="btn btn-ghost btn-sm download-invalid" onClick={() => download("invalid")}>
                <Download size={12} /> Invalid ({fmt(job.invalid)})
              </button>
            </>
          )}
          <button className="btn btn-ghost btn-sm btn-danger" onClick={() => action("delete")}>
            <Trash2 size={13} />
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Merged Download Bar ───────────────────────────────────────────────────────

function MergedDownloadBar({ groupId, jobs }: { groupId: string; jobs: Job[] }) {
  const allDone = jobs.every((j) => ["COMPLETED", "STOPPED"].includes(j.status));
  const totalValid = jobs.reduce((a, j) => a + j.safe + j.risky + j.unverifiable, 0);
  const totalReview = jobs.reduce((a, j) => a + j.unknown, 0);
  const totalInvalid = jobs.reduce((a, j) => a + j.invalid, 0);
  const baseName = jobs[0]?.name.replace(/_part\d+$/, "") || "merged";

  const dl = (bucket: string) => window.open(`/api/groups/${groupId}/download?bucket=${bucket}`, "_blank");

  return (
    <div className="merged-bar">
      <div className="merged-label">
        <span className="merged-icon">🔗</span>
        <span className="merged-title">{baseName} — Merged</span>
        {!allDone && <span className="merged-hint">(available when both parts complete)</span>}
      </div>
      <div className="merged-downloads">
        <button className="btn btn-ghost btn-sm download-safe" onClick={() => dl("valid")} disabled={!allDone}>
          <Download size={12} /> Valid ({fmt(totalValid)})
        </button>
        <button className="btn btn-ghost btn-sm download-risky" onClick={() => dl("review")} disabled={!allDone}>
          <Download size={12} /> Review ({fmt(totalReview)})
        </button>
        <button className="btn btn-ghost btn-sm download-invalid" onClick={() => dl("invalid")} disabled={!allDone}>
          <Download size={12} /> Invalid ({fmt(totalInvalid)})
        </button>
      </div>
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function Dashboard() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [showUpload, setShowUpload] = useState(false);
  const [loading, setLoading] = useState(true);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchJobs = useCallback(async () => {
    try {
      const res = await fetch("/api/jobs");
      const data = await res.json();
      setJobs(data);
    } catch { /* silent */ }
    finally { setLoading(false); }
  }, []);

  const logout = async () => {
    await fetch("/api/auth?action=logout", { method: "POST" });
    window.location.href = "/login";
  };

  useEffect(() => {
    fetchJobs();
    intervalRef.current = setInterval(fetchJobs, 3000);
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, [fetchJobs]);

  const hasActive = jobs.some((j) => j.status === "RUNNING" || j.status === "PAUSED");
  const totalVerified = jobs.reduce((a, j) => a + j.processed, 0);
  const totalSafe = jobs.reduce((a, j) => a + j.safe, 0);

  return (
    <>
      <div className="app">
        {/* Navbar */}
        <nav className="navbar">
          <div className="navbar-inner">
            <div className="navbar-brand">
              <div className="brand-icon"><Mail size={15} /></div>
              <span className="brand-name">Reacher</span>
              <span className="brand-tag">Self-hosted</span>
            </div>
            <div className="navbar-right">
              {hasActive && (
                <span className="live-badge">
                  <span className="pulse-dot" style={{ background: "var(--accent)" }} />
                  Live
                </span>
              )}
              <ThemeToggle />
              <button className="btn btn-primary btn-sm" onClick={() => setShowUpload(true)}>
                <Plus size={14} /> New Job
              </button>
              <button className="icon-btn" onClick={logout} title="Sign out">
                <LogOut size={15} />
              </button>
            </div>
          </div>
        </nav>

        {/* Summary bar */}
        {jobs.length > 0 && (
          <div className="summary-bar">
            <div className="summary-inner">
              <div className="summary-stat">
                <span className="summary-val">{fmt(jobs.length)}</span>
                <span className="summary-label">Jobs</span>
              </div>
              <div className="summary-stat">
                <span className="summary-val">{fmt(totalVerified)}</span>
                <span className="summary-label">Verified</span>
              </div>
              <div className="summary-stat">
                <span className="summary-val" style={{ color: "var(--safe)" }}>{fmt(totalSafe)}</span>
                <span className="summary-label">Safe</span>
              </div>
              <div className="summary-stat">
                <span className="summary-val">{jobs.filter(j => j.status === "RUNNING").length}</span>
                <span className="summary-label">Running</span>
              </div>
            </div>
          </div>
        )}

        {/* Content */}
        <main className="main">
          {loading ? (
            <div className="empty-state">
              <Loader2 size={24} className="spin" style={{ color: "var(--text-4)" }} />
            </div>
          ) : jobs.length === 0 ? (
            <div className="empty-state fade-up">
              <div className="empty-icon"><Mail size={28} style={{ color: "var(--text-4)" }} /></div>
              <h2 className="empty-title">No jobs yet</h2>
              <p className="empty-desc">Upload a CSV to start verifying emails at scale.</p>
              <button className="btn btn-primary" onClick={() => setShowUpload(true)}>
                <Upload size={14} /> Upload CSV
              </button>
            </div>
          ) : (
          <div className="jobs-grid">
              {(() => {
                // Group jobs by groupId
                const groups = new Map<string, Job[]>();
                const singles: Job[] = [];

                jobs.forEach((job) => {
                  if (job.groupId) {
                    const g = groups.get(job.groupId) || [];
                    g.push(job);
                    groups.set(job.groupId, g);
                  } else {
                    singles.push(job);
                  }
                });

                const elements: React.ReactNode[] = [];

                // Render grouped jobs together
                groups.forEach((groupJobs, groupId) => {
                  elements.push(
                    <div key={groupId} className="job-group">
                      <div className="job-group-label">Split job · {groupJobs[0]?.name.replace(/_part\d+$/, "")}</div>
                      {groupJobs.map((job) => (
                        <JobCard key={job.id} job={job} onAction={fetchJobs} />
                      ))}
                      <MergedDownloadBar groupId={groupId} jobs={groupJobs} />
                    </div>
                  );
                });

                // Render single jobs
                singles.forEach((job) => {
                  elements.push(<JobCard key={job.id} job={job} onAction={fetchJobs} />);
                });

                return elements;
              })()}
            </div>
          )}
        </main>
      </div>

      {showUpload && (
        <UploadModal
          onClose={() => setShowUpload(false)}
          onUploaded={fetchJobs}
        />
      )}

      <style>{`
        /* ── Layout ── */
        .app { min-height: 100vh; background: var(--bg-subtle); }

        /* ── Navbar ── */
        .navbar { background: var(--surface); border-bottom: 1px solid var(--border); position: sticky; top: 0; z-index: 40; }
        .navbar-inner { max-width: 1200px; margin: 0 auto; padding: 0 24px; height: 56px; display: flex; align-items: center; justify-content: space-between; }
        .navbar-brand { display: flex; align-items: center; gap: 10px; }
        .brand-icon { width: 28px; height: 28px; background: var(--accent); color: #fff; border-radius: 7px; display: flex; align-items: center; justify-content: center; }
        .brand-name { font-weight: 600; font-size: 15px; color: var(--text-1); letter-spacing: -0.3px; }
        .brand-tag { font-size: 11px; padding: 2px 7px; border-radius: 999px; background: var(--surface-2); color: var(--text-3); border: 1px solid var(--border); font-weight: 500; }
        .navbar-right { display: flex; align-items: center; gap: 10px; }
        .live-badge { display: flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 500; color: var(--accent); }

        /* ── Summary ── */
        .summary-bar { background: var(--surface); border-bottom: 1px solid var(--border); }
        .summary-inner { max-width: 1200px; margin: 0 auto; padding: 0 24px; height: 44px; display: flex; align-items: center; gap: 32px; }
        .summary-stat { display: flex; align-items: center; gap: 6px; }
        .summary-val { font-size: 13px; font-weight: 600; color: var(--text-1); font-variant-numeric: tabular-nums; }
        .summary-label { font-size: 12px; color: var(--text-3); }

        /* ── Main ── */
        .main { max-width: 1200px; margin: 0 auto; padding: 28px 24px; }
        .jobs-grid { display: flex; flex-direction: column; gap: 14px; }

        /* ── Empty ── */
        .empty-state { display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 100px 24px; text-align: center; gap: 14px; }
        .empty-icon { width: 56px; height: 56px; background: var(--surface); border: 1px solid var(--border); border-radius: 14px; display: flex; align-items: center; justify-content: center; }
        .empty-title { font-size: 18px; font-weight: 600; color: var(--text-1); }
        .empty-desc { font-size: 14px; color: var(--text-3); max-width: 320px; line-height: 1.5; }

        /* ── Job Card ── */
        .job-card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-lg); padding: 20px; display: flex; flex-direction: column; gap: 16px; box-shadow: var(--shadow-sm); transition: box-shadow 0.15s; }
        .job-card:hover { box-shadow: var(--shadow); }
        .job-header { display: flex; flex-direction: column; gap: 4px; }
        .job-title-row { display: flex; align-items: center; gap: 10px; }
        .job-name { font-size: 15px; font-weight: 600; color: var(--text-1); letter-spacing: -0.2px; }
        .job-meta { font-size: 12px; color: var(--text-3); }
        .status-badge { display: inline-flex; align-items: center; gap: 5px; font-size: 11px; font-weight: 500; padding: 2px 8px; border-radius: 999px; border: 1px solid; white-space: nowrap; }
        .pulse-dot { width: 6px; height: 6px; border-radius: 50%; display: inline-block; }

        /* ── Progress ── */
        .progress-track { height: 4px; background: var(--surface-2); border-radius: 999px; overflow: hidden; }
        .progress-fill { height: 100%; border-radius: 999px; transition: width 0.5s ease; min-width: ${0}; }

        /* ── Stats ── */
        .job-stats { display: flex; align-items: center; gap: 20px; flex-wrap: wrap; }
        .stat { display: flex; align-items: center; gap: 5px; }
        .stat-val { font-size: 13px; font-weight: 600; color: var(--text-1); font-variant-numeric: tabular-nums; }
        .stat-label { font-size: 11px; color: var(--text-3); }
        .stat-eta { font-size: 11px; color: var(--accent); margin-left: 4px; }
        .stat-pct { font-size: 13px; font-weight: 600; color: var(--text-1); }
        .stat-progress { display: flex; align-items: center; gap: 5px; margin-left: auto; }
        .stat-divider { width: 1px; height: 14px; background: var(--border); }

        /* ── Actions ── */
        .job-actions { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; padding-top: 4px; border-top: 1px solid var(--border); }
        .job-controls { display: flex; gap: 6px; }
        .job-downloads { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
        .download-safe { color: var(--safe) !important; border-color: var(--safe) !important; }
        .download-safe:hover { background: var(--safe-bg) !important; }
        .download-risky { color: var(--risky) !important; border-color: var(--risky) !important; }
        .download-risky:hover { background: var(--risky-bg) !important; }
        .download-invalid { color: var(--invalid) !important; border-color: var(--invalid) !important; }
        .download-invalid:hover { background: var(--invalid-bg) !important; }
        .download-unverifiable { color: var(--text-3) !important; border-color: var(--border-2) !important; }
        .download-unverifiable:hover { background: var(--surface-2) !important; }

        /* ── Buttons ── */
        .btn { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; font-weight: 500; padding: 7px 14px; border-radius: var(--radius-sm); border: 1px solid transparent; cursor: pointer; transition: all 0.12s; white-space: nowrap; font-family: inherit; }
        .btn:disabled { opacity: 0.5; cursor: not-allowed; }
        .btn-sm { padding: 5px 10px; font-size: 12px; }
        .btn-primary { background: var(--accent); color: #fff; border-color: var(--accent); }
        .btn-primary:hover:not(:disabled) { background: var(--accent-hover); }
        .btn-ghost { background: transparent; color: var(--text-2); border-color: var(--border); }
        .btn-ghost:hover { background: var(--surface-2); border-color: var(--border-2); }
        .btn-danger { color: var(--invalid) !important; border-color: var(--border) !important; }
        .btn-danger:hover { background: var(--invalid-bg) !important; border-color: var(--invalid) !important; }
        .icon-btn { display: inline-flex; align-items: center; justify-content: center; width: 32px; height: 32px; border-radius: var(--radius-sm); border: 1px solid var(--border); background: transparent; color: var(--text-2); cursor: pointer; transition: all 0.12s; }
        .icon-btn:hover { background: var(--surface-2); }

        /* ── Modal ── */
        .modal-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.4); display: flex; align-items: center; justify-content: center; z-index: 100; padding: 24px; backdrop-filter: blur(2px); }
        .modal { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-lg); width: 100%; max-width: 480px; box-shadow: var(--shadow-md); display: flex; flex-direction: column; gap: 20px; padding: 24px; }
        .modal-header { display: flex; align-items: center; justify-content: space-between; }
        .modal-title { font-size: 16px; font-weight: 600; color: var(--text-1); }
        .modal-footer { display: flex; justify-content: flex-end; gap: 8px; padding-top: 4px; }

        /* ── Dropzone ── */
        .dropzone { border: 1.5px dashed var(--border-2); border-radius: var(--radius); padding: 32px 24px; display: flex; flex-direction: column; align-items: center; gap: 10px; cursor: pointer; transition: all 0.15s; text-align: center; }
        .dropzone:hover, .dropzone.dragging { border-color: var(--accent); background: var(--accent-bg); }
        .dropzone.has-file { border-style: solid; border-color: var(--safe); background: var(--safe-bg); }
        .dropzone-icon { width: 42px; height: 42px; background: var(--surface-2); border: 1px solid var(--border); border-radius: 10px; display: flex; align-items: center; justify-content: center; color: var(--text-3); }
        .dropzone-label { font-size: 14px; color: var(--text-2); font-weight: 500; }
        .dropzone-hint { font-size: 12px; color: var(--text-3); line-height: 1.5; }
        .dropzone-file { display: flex; align-items: center; gap: 12px; }
        .dropzone-file-icon { width: 40px; height: 40px; background: var(--safe-bg); border: 1px solid var(--safe); border-radius: 9px; display: flex; align-items: center; justify-content: center; color: var(--safe); }
        .dropzone-file-name { font-size: 14px; font-weight: 500; color: var(--text-1); }
        .dropzone-file-size { font-size: 12px; color: var(--text-3); }

        /* ── Fields ── */
        .field { display: flex; flex-direction: column; gap: 8px; }
        .field-header { display: flex; justify-content: space-between; align-items: center; }
        .field-label { font-size: 13px; font-weight: 500; color: var(--text-1); }
        .field-value { font-size: 13px; font-weight: 600; color: var(--accent); font-variant-numeric: tabular-nums; }
        .field-hint { font-size: 12px; color: var(--text-3); line-height: 1.5; }
        .slider { width: 100%; accent-color: var(--accent); }
        .slider-labels { display: flex; justify-content: space-between; font-size: 11px; color: var(--text-4); }

        /* ── Misc ── */
        .link { color: var(--accent); text-decoration: underline; cursor: pointer; }
        .error-msg { font-size: 13px; color: var(--invalid); background: var(--invalid-bg); padding: 10px 12px; border-radius: var(--radius-sm); border: 1px solid ${`var(--invalid)`}30; }
        code { font-family: 'Geist Mono', monospace; font-size: 12px; background: var(--surface-2); padding: 1px 5px; border-radius: 4px; }
        .hidden { display: none; }
        /* ── Preset cards ── */
        .preset-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
        .preset-card { display: flex; flex-direction: column; gap: 3px; padding: 10px 12px; border-radius: 8px; border: 1px solid var(--border); background: var(--bg); cursor: pointer; text-align: left; transition: all 0.12s; font-family: inherit; }
        .preset-card:hover { border-color: var(--border-2); background: var(--surface-2); }
        .preset-card.active { border-color: var(--accent); background: var(--accent-bg); }
        .preset-label { font-size: 13px; font-weight: 600; color: var(--text-1); }
        .preset-desc { font-size: 11px; color: var(--text-3); font-family: 'Geist Mono', monospace; }
        .preset-note { font-size: 11px; color: var(--text-4); margin-top: 2px; }
        /* ── Split info ── */
        .split-info { display: flex; flex-direction: column; align-items: center; gap: 12px; text-align: center; padding: 8px 0; }
        .split-icon { font-size: 28px; }
        .split-title { font-size: 15px; color: var(--text-1); }
        .split-desc { font-size: 13px; color: var(--text-3); line-height: 1.6; max-width: 340px; }
        .split-preview { display: flex; align-items: center; gap: 12px; background: var(--surface-2); border: 1px solid var(--border); border-radius: 10px; padding: 14px 20px; }
        .split-part { display: flex; flex-direction: column; align-items: center; gap: 4px; }
        .split-part-label { font-size: 11px; font-weight: 600; color: var(--text-3); text-transform: uppercase; letter-spacing: 0.05em; }
        .split-part-count { font-size: 16px; font-weight: 700; color: var(--accent); font-variant-numeric: tabular-nums; }
        .split-divider { font-size: 18px; color: var(--text-4); font-weight: 300; }
        .split-hint { font-size: 12px; color: var(--text-4); }
        /* ── Job group ── */
        .job-group { display: flex; flex-direction: column; gap: 8px; }
        .job-group-label { font-size: 11px; font-weight: 600; color: var(--text-3); text-transform: uppercase; letter-spacing: 0.06em; padding: 0 4px; }
        /* ── Merged bar ── */
        .merged-bar { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 14px 16px; display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 10px; }
        .merged-label { display: flex; align-items: center; gap: 8px; }
        .merged-icon { font-size: 14px; }
        .merged-title { font-size: 13px; font-weight: 600; color: var(--text-1); }
        .merged-hint { font-size: 12px; color: var(--text-4); }
        .merged-downloads { display: flex; gap: 6px; flex-wrap: wrap; }
      `}</style>
    </>
  );
}
