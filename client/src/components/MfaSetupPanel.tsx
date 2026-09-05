import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { Card, CardHead } from "./ui";

// Shows a freshly issued authenticator secret as a QR code (plus the text key
// for manual entry). The Administrator shows this to the person - or sends it
// to them securely - once; the secret is not retrievable again afterwards,
// only re-issued via "Authenticator setup" on the user row.
export default function MfaSetupPanel({
  name,
  email,
  otpAuthUrl,
  onClose,
}: {
  name: string;
  email: string;
  otpAuthUrl: string;
  onClose: () => void;
}) {
  const [qr, setQr] = useState<string | null>(null);
  const secret = new URL(otpAuthUrl).searchParams.get("secret") ?? "";

  useEffect(() => {
    QRCode.toDataURL(otpAuthUrl, { width: 220, margin: 1, color: { dark: "#1B2A22", light: "#FFFFFF" } })
      .then(setQr)
      .catch(() => setQr(null));
  }, [otpAuthUrl]);

  return (
    <Card className="mb-6 border-brand-100">
      <CardHead
        title={`Authenticator setup for ${name}`}
        subtitle="Required before this person can sign in. Show them this screen, or send it securely - it is not shown again."
        right={
          <button type="button" className="btn-ghost btn-sm" onClick={onClose}>
            Done
          </button>
        }
      />
      <div className="p-5 grid grid-cols-[240px_1fr] gap-6 items-start">
        <div className="rounded-xl border border-line bg-white p-2 grid place-items-center min-h-[236px]">
          {qr ? <img src={qr} alt="Authenticator QR code" width={220} height={220} /> : <span className="t-sub">Generating…</span>}
        </div>
        <div className="text-sm space-y-3">
          <ol className="list-decimal pl-5 space-y-1.5">
            <li>On the phone, open an authenticator app (Google Authenticator, Microsoft Authenticator, Authy, 1Password…).</li>
            <li>
              Add an account and <strong>scan this QR code</strong>. It will appear as <em>FPT Exam ({email})</em>.
            </li>
            <li>
              Sign in at FPT Exam with the email and password, then enter the <strong>6-digit code</strong> the app shows.
            </li>
          </ol>
          <div>
            <p className="field-lbl">Can't scan? Enter this key manually</p>
            <code className="block rounded-lg border border-line bg-surface-2 px-3 py-2 text-[13px] tracking-[0.15em] break-all select-all">
              {secret.replace(/(.{4})/g, "$1 ").trim()}
            </code>
            <p className="t-sub mt-1">Time-based (TOTP), 6 digits, 30 seconds.</p>
          </div>
        </div>
      </div>
    </Card>
  );
}
