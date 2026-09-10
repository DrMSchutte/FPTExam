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

// Block 5d: the result-released email. Never carries the result itself - the
// learner signs in to see it and to download the Statement of Results.
export function resultReleasedEmail(p: { name: string; qualificationTitle: string; loginUrl: string }) {
  const text = `Hello ${p.name}

Your result for ${p.qualificationTitle} has been released by the assessor.

Sign in to FPT Exam to see your result, the assessor's feedback and to download your Statement of Results:
${p.loginUrl}

FPT Academy`;
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;color:#1c2a1f;line-height:1.5;max-width:560px">
<p>Hello ${esc(p.name)}</p>
<p>Your result for <strong>${esc(p.qualificationTitle)}</strong> has been released by the assessor.</p>
<p><a href="${esc(p.loginUrl)}" style="display:inline-block;background:#6BBF3E;color:#fff;text-decoration:none;font-weight:bold;padding:12px 20px;border-radius:8px">See my result</a></p>
<p style="font-size:13px;color:#5d6b60">Sign in to see your result, the assessor's feedback, and to download your Statement of Results. Or copy this link: ${esc(p.loginUrl)}</p>
<p>FPT Academy</p></div>`;
  return { subject: `Your result for ${p.qualificationTitle} has been released`, text, html };
}

// ---- Block 8e: the reminders ---------------------------------------------------
//
// Plain text only. These go to staff several times a week, so they are short,
// say what to do, and never pretend to be more urgent than they are.

export function assessorScriptsEmail(p: { name: string; waiting: number; overdue: number; sittings: number; oldest: Date | null; overdueDays: number; queueUrl: string }) {
  const when = p.oldest ? p.oldest.toLocaleDateString("en-ZA", { day: "numeric", month: "long", timeZone: "Africa/Johannesburg" }) : null;
  const subject = p.overdue > 0
    ? `${p.overdue} exam script${p.overdue === 1 ? "" : "s"} overdue for marking`
    : `${p.waiting} exam script${p.waiting === 1 ? "" : "s"} waiting to be marked`;
  const text = `Hello ${p.name}

You have ${p.waiting} script${p.waiting === 1 ? "" : "s"} waiting to be marked${p.sittings > 1 ? `, across ${p.sittings} sittings` : ""}.${when ? `\nThe oldest was submitted on ${when}.` : ""}
${p.overdue > 0 ? `\n${p.overdue} of them ${p.overdue === 1 ? "has" : "have"} been waiting longer than ${p.overdueDays} days. Learners cannot see their result until you sign it off.\n` : ""}
Your marking queue: ${p.queueUrl}

The AI's suggested marks are there to speed you up, not to decide. The mark you sign off is the mark.

FPT Academy`;
  return { subject, text };
}

export function invigilatorSittingEmail(p: { name: string; role: "invigilator" | "assessor"; sittingName: string; qualificationTitle: string; day: string; from: string; to: string; venue: string | null; learners: number; codesIssued: number; minutes: number; fullRecording: boolean; consoleUrl: string }) {
  const missing = p.learners - p.codesIssued;
  const text = `Hello ${p.name}

${p.role === "invigilator" ? "You are invigilating" : "You are the assessor of record for"} a sitting tomorrow.

  ${p.sittingName}
  ${p.qualificationTitle}
  ${p.day}, ${p.from}-${p.to} (${p.minutes} minutes' writing time)
  ${p.venue ?? "No venue recorded"}
  ${p.learners} learner${p.learners === 1 ? "" : "s"} on the roster${missing > 0 ? ` - ${missing} still ${missing === 1 ? "has" : "have"} no sitting code` : ", all with sitting codes"}
  Evidence kept: ${p.fullRecording ? "full recording (camera and screen) plus stills" : "camera and screen stills at intervals"}
${p.role === "invigilator" ? `
Before you start: print the sitting codes${missing > 0 ? " (and issue the missing ones)" : ""}, and open the live console when the room opens so you can see everyone at once.

  ${p.consoleUrl}
` : `
The scripts will reach your marking queue as learners submit.
`}
FPT Academy`;
  return { subject: `Tomorrow: ${p.sittingName} (${p.from})`, text };
}

export function adminDigestEmail(p: { name: string; submitted: number; released: number; today: { name: string; at: string; venue: string | null; learners: number }[]; problems: string[]; overdueDays: number; url: string }) {
  const text = `Hello ${p.name}

Yesterday on FPT Exam: ${p.submitted} paper${p.submitted === 1 ? "" : "s"} submitted, ${p.released} result${p.released === 1 ? "" : "s"} released.

${p.today.length ? `Today's sittings:\n${p.today.map((t) => `  ${t.at}  ${t.name} - ${t.learners} learner${t.learners === 1 ? "" : "s"}${t.venue ? `, ${t.venue}` : ""}`).join("\n")}` : "No sittings today."}

${p.problems.length ? `Needs attention:\n${p.problems.map((x) => `  - ${x}`).join("\n")}` : "Nothing needs attention."}

${p.url}

FPT Academy`;
  return { subject: `FPT Exam: ${p.today.length ? `${p.today.length} sitting${p.today.length === 1 ? "" : "s"} today` : "no sittings today"}${p.problems.length ? ` · ${p.problems.length} to look at` : ""}`, text };
}

export function healthAlertEmail(p: { name: string; problems: string[]; url: string }) {
  const text = `Hello ${p.name}

Something on FPT Exam needs attention:

${p.problems.map((x) => `  - ${x}`).join("\n")}

${p.url}

You are getting this once for this set of problems today, not every hour.

FPT Academy`;
  return { subject: `FPT Exam needs attention: ${p.problems[0]?.slice(0, 60) ?? "see the dashboard"}`, text };
}
