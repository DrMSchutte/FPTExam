import { useState } from "react";
import { Card, CardHead, Badge } from "./ui";

// Shown after a person is registered (or a link is re-sent): whether the set-up
// link went by email, and the link itself to pass on when email is not connected.
export interface SetupIssue {
  setupUrl: string;
  expiresAt: string;
  emailSent: boolean;
  emailConfigured: boolean;
  emailError?: string;
}

export default function SetupLinkPanel({ name, email, issue, onClose }: { name: string; email: string; issue: SetupIssue; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  const expires = new Date(issue.expiresAt).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

  async function copy() {
    try {
      await navigator.clipboard.writeText(issue.setupUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* the field below is selectable */
    }
  }

  return (
    <Card className="mb-6 border-brand-100">
      <CardHead
        title={`Set-up link for ${name}`}
        subtitle={
          issue.emailSent
            ? `Emailed to ${email}. It works once and expires ${expires}.`
            : issue.emailConfigured
              ? `The email could not be sent — send this link to ${email} yourself. It works once and expires ${expires}.`
              : `Email is not connected yet, so send this link to ${email} yourself (WhatsApp, Teams, email). It works once and expires ${expires}.`
        }
        right={
          <button type="button" className="btn-ghost btn-sm" onClick={onClose}>
            Done
          </button>
        }
      />
      <div className="p-5 space-y-3">
        <div className="flex items-center gap-2">
          {issue.emailSent ? <Badge tone="green">Emailed</Badge> : <Badge tone="amber">Not emailed</Badge>}
          {!issue.emailConfigured && <span className="t-sub">To email these automatically, set SMTP_HOST, SMTP_USER and SMTP_PASS (and MAIL_FROM) in the Repl's Secrets.</span>}
          {issue.emailConfigured && !issue.emailSent && issue.emailError && <span className="t-sub">{issue.emailError}</span>}
        </div>
        <div className="flex gap-2 items-stretch">
          <code className="flex-1 rounded-lg border border-line bg-surface-2 px-3 py-2 text-[12.5px] break-all select-all">{issue.setupUrl}</code>
          <button type="button" className="btn whitespace-nowrap" onClick={copy}>
            {copied ? "Copied" : "Copy link"}
          </button>
        </div>
        <p className="t-sub">
          On the page the link opens, {name.split(" ")[0]} chooses a password and, for a supervisory role, scans the authenticator QR code and confirms it with a first code. The authenticator secret never travels in the email.
        </p>
      </div>
    </Card>
  );
}
