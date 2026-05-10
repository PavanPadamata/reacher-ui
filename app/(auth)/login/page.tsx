"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Mail, Lock, Loader2, Eye, EyeOff } from "lucide-react";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPass, setShowPass] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    // Check if setup needed
    fetch("/api/auth").then((r) => r.json()).then((d) => {
      if (d.authenticated) router.replace("/");
      else if (d.needsSetup) router.replace("/setup");
      else setChecking(false);
    });
  }, [router]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/auth?action=login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      router.replace("/");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Login failed");
    } finally {
      setLoading(false);
    }
  };

  if (checking) return (
    <div className="auth-screen">
      <Loader2 size={24} className="spin" style={{ color: "var(--text-4)" }} />
    </div>
  );

  return (
    <div className="auth-screen">
      <div className="auth-card">
        <div className="auth-logo">
          <div className="brand-icon"><Mail size={16} /></div>
          <span className="brand-name">Reacher</span>
        </div>

        <div className="auth-header">
          <h1 className="auth-title">Welcome back</h1>
          <p className="auth-subtitle">Sign in to your account</p>
        </div>

        <form onSubmit={submit} className="auth-form">
          <div className="field">
            <label className="field-label">Email</label>
            <div className="input-wrap">
              <Mail size={15} className="input-icon" />
              <input
                type="email"
                className="input"
                placeholder="admin@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoFocus
              />
            </div>
          </div>

          <div className="field">
            <label className="field-label">Password</label>
            <div className="input-wrap">
              <Lock size={15} className="input-icon" />
              <input
                type={showPass ? "text" : "password"}
                className="input"
                placeholder="••••••••"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
              <button type="button" className="input-action" onClick={() => setShowPass(!showPass)}>
                {showPass ? <EyeOff size={15} /> : <Eye size={15} />}
              </button>
            </div>
          </div>

          {error && <p className="auth-error">{error}</p>}

          <button type="submit" className="btn btn-primary btn-full" disabled={loading}>
            {loading ? <><Loader2 size={14} className="spin" /> Signing in…</> : "Sign in"}
          </button>
        </form>
      </div>

      <AuthStyles />
    </div>
  );
}

function AuthStyles() {
  return (
    <style>{`
      .auth-screen {
        min-height: 100vh;
        background: var(--bg-subtle);
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 24px;
      }
      .auth-card {
        background: var(--surface);
        border: 1px solid var(--border);
        border-radius: 16px;
        padding: 36px;
        width: 100%;
        max-width: 400px;
        box-shadow: var(--shadow-md);
        display: flex;
        flex-direction: column;
        gap: 28px;
      }
      .auth-logo {
        display: flex;
        align-items: center;
        gap: 10px;
      }
      .brand-icon {
        width: 30px; height: 30px;
        background: var(--accent);
        color: #fff;
        border-radius: 8px;
        display: flex; align-items: center; justify-content: center;
      }
      .brand-name { font-size: 16px; font-weight: 700; color: var(--text-1); letter-spacing: -0.3px; }
      .auth-header { display: flex; flex-direction: column; gap: 4px; }
      .auth-title { font-size: 22px; font-weight: 700; color: var(--text-1); letter-spacing: -0.4px; }
      .auth-subtitle { font-size: 14px; color: var(--text-3); }
      .auth-form { display: flex; flex-direction: column; gap: 16px; }
      .field { display: flex; flex-direction: column; gap: 6px; }
      .field-label { font-size: 13px; font-weight: 500; color: var(--text-2); }
      .input-wrap { position: relative; display: flex; align-items: center; }
      .input-icon { position: absolute; left: 12px; color: var(--text-4); pointer-events: none; }
      .input-action { position: absolute; right: 10px; background: none; border: none; cursor: pointer; color: var(--text-3); display: flex; align-items: center; padding: 4px; }
      .input-action:hover { color: var(--text-1); }
      .input {
        width: 100%;
        padding: 10px 12px 10px 36px;
        border: 1px solid var(--border);
        border-radius: 8px;
        background: var(--bg);
        color: var(--text-1);
        font-size: 14px;
        font-family: inherit;
        outline: none;
        transition: border-color 0.15s;
      }
      .input:focus { border-color: var(--accent); }
      .input::placeholder { color: var(--text-4); }
      .auth-error {
        font-size: 13px;
        color: var(--invalid);
        background: var(--invalid-bg);
        padding: 10px 12px;
        border-radius: 8px;
        border: 1px solid color-mix(in srgb, var(--invalid) 20%, transparent);
      }
      .btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; font-size: 14px; font-weight: 500; padding: 10px 16px; border-radius: 8px; border: 1px solid transparent; cursor: pointer; transition: all 0.12s; font-family: inherit; }
      .btn:disabled { opacity: 0.5; cursor: not-allowed; }
      .btn-primary { background: var(--accent); color: #fff; border-color: var(--accent); }
      .btn-primary:hover:not(:disabled) { background: var(--accent-hover); }
      .btn-full { width: 100%; }
      .spin { animation: spin 1s linear infinite; }
      @keyframes spin { to { transform: rotate(360deg); } }
    `}</style>
  );
}
