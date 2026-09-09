import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import QRCode from "qrcode";
import { api } from "../lib/api";
import { BrandMark } from "../components/Shell";

// The page a newly registered person lands on from their set-up link: choose a
// password and, for supervisory roles, enrol the authenticator. No sign-in
// needed - the one-use link in the address is the credential.

interface SetupInfo {
  name: string;
  email: string;
  roles: string[];
  mfaOtpAuthUrl: string | null;
  expiresAt: string;
}

export default function AccountSetup() {
  const { token } = useParams<{ token: string }>();
  const [info, setInfo] = useState<SetupInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (!token) return;
    api
      .get<SetupInfo>(`/auth/setup/${token}`)
      .then((i) => {
        setInfo(i);
        if (i.mfaOtpAuthUrl) {
          QRCode.toDataURL(i.mfaOtpAuthUrl, { width: 200, margin: 1, color: { dark: "#1B2A22", light: "#FFFFFF" } })
            .then(setQr)
            .catch(() => setQr(null));
        }
      })
      .catch((err) => setError((err as Error).message));
  }, [token]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (password.length < 10) return setError("Choose a password of at least 10 characters.");
    if (password !== confirm) return setError("The two passwords do not match.");
    if (info?.mfaOtpAuthUrl && !/^\d{6}$/.test(code)) return setError("Enter the 6-digit code your authenticator app shows.");
    setBusy(true);
    try {
      await api.post(`/auth/setup/${token}`, { password, ...(info?.mfaOtpAuthUrl ? { mfaCode: code } : {}) });
      setDone(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const secret = info?.mfaOtpAuthUrl ? new URL(info.mfaOtpAuthUrl).searchParams.get("secret") ?? "" : "";

  return (
    <div className="min-h-screen bg-surface-bg px-4 py-10">
      <div className="mx-auto w-full max-w-[720px]">
        <div className="flex items-center gap-3 mb-6">
          <BrandMark size={40} />
          <div>
            <p className="font-display font-extrabold text-lg leading-tight tracking-tight">FPT Exam</p>
            <p className="text-[12px] text-ink-faint">Secure Exam Centre · set up your sign-in</p>
          </div>
        </div>

        {error && !info && (
          <div className="rounded-xl border border-amber-200 bg-amber-50 p-5 text-sm text-amber-900">
            <p className="font-semibold">This set-up link is not valid any more.</p>
            <p className="mt-1">It may have been used already or expired. Ask the FPT Academy Administrator to send you a new one.</p>
          </div>
        )}

        {done && info && (
          <div className="rounded-xl border border-brand-100 bg-surface p-6 shadow-card">
            <p className="font-display font-bold text-[17px]">You're set up, {info.name.split(" ")[0]}.</p>
            <p className="text-sm text-ink-muted mt-1.5">
              Sign in with <strong>{info.email}</strong> and the password you just chose{info.mfaOtpAuthUrl ? ", then the 6-digit code from your authenticator app" : ""}.
            </p>
            <Link to="/login" className="btn inline-flex mt-4">Go to sign in</Link>
          </div>
        )}

        {info && !done && (
          <form onSubmit={submit} className="rounded-xl border border-line bg-surface shadow-card">
            <div className="px-6 pt-5 pb-4 border-b border-line">
              <p className="font-display font-bold text-[17px]">Hello {info.name}</p>
              <p className="text-sm text-ink-muted mt-1">
                You have been registered as <strong>{info.roles.join(" and ")}</strong> on FPT Exam. Two things to do, then you can sign in.
              </p>
            </div>

            <div className="px-6 py-5 border-b border-line">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-muted mb-2">1 · Choose your password</p>
              <div className="grid grid-cols-2 gap-3.5 max-w-[520px]">
                <div>
                  <label className="field-lbl">Password <span className="normal-case font-normal text-ink-faint">(at least 10 characters)</span></label>
                  <input className="inp" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={10} />
                </div>
                <div>
                  <label className="field-lbl">Repeat it</label>
                  <input className="inp" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
                </div>
              </div>
              <p className="t-sub mt-2">Your email address is your username: {info.email}</p>
            </div>

            {info.mfaOtpAuthUrl && (
              <div className="px-6 py-5 border-b border-line">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-muted mb-2">2 · Link your authenticator app</p>
                <div className="grid grid-cols-[216px_1fr] gap-6 items-start">
                  <div className="rounded-xl border border-line bg-white p-2 grid place-items-center min-h-[216px]">
                    {qr ? <img src={qr} alt="Authenticator QR code" width={200} height={200} /> : <span className="t-sub">Generating…</span>}
                  </div>
                  <div className="text-sm space-y-3">
                    <ol className="list-decimal pl-5 space-y-1.5">
                      <li>On your phone, open an authenticator app — Google Authenticator, Microsoft Authenticator, Authy or 1Password all work.</li>
                      <li>Add an account and <strong>scan this QR code</strong>. It appears as <em>FPT Exam ({info.email})</em>.</li>
                      <li>Type the <strong>6-digit code</strong> the app now shows, below.</li>
                    </ol>
                    <div>
                      <p className="field-lbl">Can't scan? Enter this key in the app instead</p>
                      <code className="block rounded-lg border border-line bg-surface-2 px-3 py-2 text-[13px] tracking-[0.15em] break-all select-all">{secret.replace(/(.{4})/g, "$1 ").trim()}</code>
                    </div>
                    <div className="max-w-[220px]">
                      <label className="field-lbl">Code from the app</label>
                      <input className="inp tabular text-lg tracking-[0.3em]" inputMode="numeric" pattern="\d{6}" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} placeholder="000000" required />
                    </div>
                  </div>
                </div>
              </div>
            )}

            <div className="px-6 py-4 flex items-center gap-4">
              <button className="btn" disabled={busy}>{busy ? "Saving…" : "Finish set-up"}</button>
              {error && <p className="text-sm text-red-700">{error}</p>}
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
