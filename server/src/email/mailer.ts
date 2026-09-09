import nodemailer, { type Transporter } from "nodemailer";

// Outgoing email. Configured entirely from Secrets; until they are set the system
// still works - anything that would have been emailed is shown to the
// Administrator to send by hand, and callers are told `sent: false`.
//
//   SMTP_HOST, SMTP_PORT (587 or 465), SMTP_USER, SMTP_PASS   the mailbox that sends
//   MAIL_FROM   e.g. "FPT Exam <exams@fptacademy.co.za>"       (defaults to SMTP_USER)
//
// Microsoft 365 / Outlook: SMTP_HOST=smtp.office365.com, SMTP_PORT=587, SMTP_USER=the
// mailbox address, SMTP_PASS=its password (or an app password if MFA is on for it).

export function isMailConfigured(): boolean {
  return Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

let transporter: Transporter | null = null;
function getTransporter() {
  if (!transporter) {
    const port = Number(process.env.SMTP_PORT ?? 587);
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port,
      secure: port === 465,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
  }
  return transporter;
}

export interface MailResult {
  sent: boolean;
  reason?: string;
}

export async function sendMail(opts: { to: string; subject: string; text: string; html?: string }): Promise<MailResult> {
  if (!isMailConfigured()) return { sent: false, reason: "Email is not connected (SMTP_HOST / SMTP_USER / SMTP_PASS not set)." };
  try {
    await getTransporter().sendMail({
      from: process.env.MAIL_FROM ?? process.env.SMTP_USER,
      to: opts.to,
      subject: opts.subject,
      text: opts.text,
      html: opts.html,
    });
    return { sent: true };
  } catch (err) {
    return { sent: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

export function accountSetupEmail(p: { name: string; roleWord: string; setupUrl: string; expiresAt: Date; needsAuthenticator: boolean }) {
  const when = p.expiresAt.toLocaleString("en-ZA", { dateStyle: "long", timeStyle: "short" });
  const text = `Hello ${p.name}

You have been registered on FPT Exam, FPT Academy's secure exam centre, as ${p.roleWord}.

To set up your sign-in, open this link and follow the steps:
${p.setupUrl}

The link works once and expires on ${when}.

You will choose your own password${p.needsAuthenticator ? " and link an authenticator app on your phone (Google Authenticator, Microsoft Authenticator or similar) - it is required each time you sign in" : ""}.

If you were not expecting this email, please ignore it.

FPT Academy`;
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;color:#1c2a1f;line-height:1.5;max-width:560px">
<p>Hello ${esc(p.name)}</p>
<p>You have been registered on <strong>FPT Exam</strong>, FPT Academy's secure exam centre, as <strong>${esc(p.roleWord)}</strong>.</p>
<p><a href="${esc(p.setupUrl)}" style="display:inline-block;background:#6BBF3E;color:#fff;text-decoration:none;font-weight:bold;padding:12px 20px;border-radius:8px">Set up your sign-in</a></p>
<p style="font-size:13px;color:#5d6b60">Or copy this link: ${esc(p.setupUrl)}<br>It works once and expires on ${esc(when)}.</p>
<p>You will choose your own password${p.needsAuthenticator ? " and link an authenticator app on your phone (Google Authenticator, Microsoft Authenticator or similar) — it is required each time you sign in" : ""}.</p>
<p style="font-size:13px;color:#5d6b60">If you were not expecting this email, please ignore it.</p>
<p>FPT Academy</p></div>`;
  return { subject: "Set up your FPT Exam sign-in", text, html };
}
