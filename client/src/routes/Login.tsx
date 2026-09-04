import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import type { LoginResponse } from "@shared/types";

export default function Login() {
  const navigate = useNavigate();
  const { refresh } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [mfaToken, setMfaToken] = useState("");
  const [pendingToken, setPendingToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handlePasswordSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res = await api.post<LoginResponse & { pendingToken?: string }>("/auth/login", {
        email,
        password,
      });
      if (res.mfaRequired) {
        setPendingToken(res.pendingToken ?? null);
      } else {
        await refresh();
        navigate("/");
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function handleMfaSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await api.post("/auth/mfa/verify", { pendingToken, token: mfaToken });
      await refresh();
      navigate("/");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-surface-bg px-4">
      <div className="w-full max-w-[400px]">
        <div className="flex items-center gap-3 mb-6">
          <div
            className="h-10 w-10 shrink-0 rounded-[10px] grid place-items-center text-white font-display font-extrabold text-lg shadow-btn"
            style={{ background: "linear-gradient(145deg, #6BBF3E 0%, #4C9127 100%)" }}
          >
            F
          </div>
          <div>
            <p className="font-display font-extrabold text-lg leading-tight tracking-tight">FPT Exam</p>
            <p className="text-xs text-ink-faint">Secure Exam Centre</p>
          </div>
        </div>

        <div className="card p-7">
          {!pendingToken ? (
            <form onSubmit={handlePasswordSubmit} className="space-y-4">
              <div>
                <h1 className="text-[19px] font-bold tracking-tight">Sign in</h1>
                <p className="text-[13.5px] text-ink-muted mt-0.5">Use the email and password you were registered with.</p>
              </div>
              <div>
                <label className="field-lbl">Email</label>
                <input className="inp" type="email" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
              </div>
              <div>
                <label className="field-lbl">Password</label>
                <input className="inp" type="password" required autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
              </div>
              {error && <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
              <button type="submit" disabled={busy} className="btn w-full justify-center !py-2.5">
                {busy ? "Signing in…" : "Sign in"}
              </button>
            </form>
          ) : (
            <form onSubmit={handleMfaSubmit} className="space-y-4">
              <div>
                <h1 className="text-[19px] font-bold tracking-tight">Two-step verification</h1>
                <p className="text-[13.5px] text-ink-muted mt-0.5">Enter the 6-digit code from your authenticator app.</p>
              </div>
              <input
                className="inp text-center tracking-[0.4em] font-display text-lg tabular"
                type="text"
                inputMode="numeric"
                maxLength={6}
                required
                autoFocus
                value={mfaToken}
                onChange={(e) => setMfaToken(e.target.value)}
              />
              {error && <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
              <button type="submit" disabled={busy} className="btn w-full justify-center !py-2.5">
                {busy ? "Verifying…" : "Verify"}
              </button>
            </form>
          )}
        </div>
        <p className="text-center text-xs text-ink-faint mt-5">© {new Date().getFullYear()} FPT Academy. All rights reserved.</p>
      </div>
    </div>
  );
}
