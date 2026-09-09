import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api } from "../../lib/api";
import { Badge, Notice } from "../../components/ui";
import type { LiveConsole as LiveConsoleData, LiveLearner, LiveAlert, EvidenceResponse, IntegritySummary } from "@shared/types";

// Block 5c: the invigilator console - the live view of one sitting.
//
// Left: every learner as a card with their latest camera still, status, clock
// and flags; filters put the ones who need attention first. Right: the
// selected learner - camera and screen refreshed as captures land, identity
// photo for comparison, every action (resume, extra time, message, capture
// now, record an observation, end the paper) and the evidence timeline.
// Polls every 4 s; nothing here needs a page reload.

const POLL_MS = 4000;
const STATUS_LABEL: Record<string, string> = { scheduled: "Not arrived", checked_in: "Checked in", in_progress: "Writing", submitted: "Submitted", sealed: "Sealed" };
const INCIDENT_LABEL: Record<string, string> = {
  focus_loss: "Left the exam window",
  fullscreen_exit: "Left full screen",
  paste_attempt: "Paste attempt",
  copy_attempt: "Copy attempt",
  screen_share_partial: "Sharing only part of the screen",
  screen_share_lost: "Screen sharing stopped",
  camera_lost: "Camera stopped",
  devtools: "Developer tools shortcut",
  resumed_by_learner: "Returned to the exam",
  resumed_by_invigilator: "Paper released by invigilator",
  note_to_learner: "Message sent to learner",
  ended_by_invigilator: "Paper ended by invigilator",
  talking: "Talking or communicating",
  unauthorised_material: "Unauthorised material",
  phone: "Phone or second device",
  left_seat: "Left the seat",
  identity_doubt: "Identity in doubt",
  other_person: "Another person present",
  other: "Observation",
};
const ACTION_LABEL: Record<string, string> = {
  sitting_entered: "Entered with sitting code",
  sitting_reentered: "Re-entered with sitting code",
  sitting_checked_in: "Checked in",
  sitting_reentry_allowed: "Re-entry allowed",
  session_started: "Paper opened",
  session_extra_time: "Extra time",
  session_submitted: "Submitted by learner",
  session_auto_submitted: "Submitted by the clock",
  session_submitted_by_invigilator: "Submitted by invigilator",
  session_terminated: "Paper ended",
  session_capture_requested: "Capture requested",
  session_evidence_viewed: "Evidence viewed",
};
const label = (t: string | undefined) => (t ? INCIDENT_LABEL[t] ?? ACTION_LABEL[t] ?? t.replace(/_/g, " ") : "");
const hhmm = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleTimeString("en-ZA", { hour: "2-digit", minute: "2-digit" }) : "—");
const hhmmss = (iso: string) => new Date(iso).toLocaleTimeString("en-ZA", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
const pad = (n: number) => String(n).padStart(2, "0");
function remaining(deadline: string | null, now: number) {
  if (!deadline) return null;
  const s = Math.max(0, Math.floor((new Date(deadline).getTime() - now) / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
}

type Filter = "attention" | "all" | "writing" | "locked" | "waiting" | "done";

export default function LiveConsole({ backTo }: { backTo: string }) {
  const { id } = useParams<{ id: string }>();
  const [data, setData] = useState<LiveConsoleData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("attention");
  const [q, setQ] = useState("");
  const [now, setNow] = useState(Date.now());
  const [skew, setSkew] = useState(0);
  const [watch, setWatch] = useState(false);
  const seenAlerts = useRef<Set<string> | null>(null);
  const [fresh, setFresh] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const d = await api.get<LiveConsoleData>(`/sittings/${id}/live`);
      setData(d);
      setSkew(new Date(d.serverTime).getTime() - Date.now());
      setError(null);
      // Alerts that arrived since the last poll are highlighted briefly.
      if (seenAlerts.current) {
        const newIds = d.alerts.filter((a) => !seenAlerts.current!.has(a.id)).map((a) => a.id);
        if (newIds.length) { setFresh(new Set(newIds)); setTimeout(() => setFresh(new Set()), 8000); }
      }
      seenAlerts.current = new Set(d.alerts.map((a) => a.id));
    } catch (e) { setError((e as Error).message); }
  }, [id]);

  useEffect(() => { load(); const t = setInterval(load, POLL_MS); return () => clearInterval(t); }, [load]);
  useEffect(() => { const t = setInterval(() => setNow(Date.now() + skew), 1000); return () => clearInterval(t); }, [skew]);

  const learners = data?.learners ?? [];
  const selected = learners.find((l) => l.learnerId === selectedId) ?? null;

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const rank = (l: LiveLearner) => (l.attention === "red" ? 0 : l.attention === "amber" ? 1 : l.status === "in_progress" ? 2 : l.status === "checked_in" ? 3 : l.status === "scheduled" ? 4 : 5);
    return learners
      .filter((l) => {
        if (needle && !l.name.toLowerCase().includes(needle) && !(l.studentNumber ?? "").toLowerCase().includes(needle)) return false;
        switch (filter) {
          case "attention": return true; // everyone, attention first
          case "writing": return l.status === "in_progress";
          case "locked": return l.locked;
          case "waiting": return l.status === "scheduled" || l.status === "checked_in";
          case "done": return l.status === "submitted" || l.status === "sealed";
          default: return true;
        }
      })
      .sort((a, b) => (filter === "attention" ? rank(a) - rank(b) || a.name.localeCompare(b.name) : a.name.localeCompare(b.name)));
  }, [learners, filter, q]);

  async function act(path: string, body: unknown, done: string) {
    if (!id || !selected) return;
    try { await api.post(`/sittings/${id}/learners/${selected.learnerId}/${path}`, body); setMessage(done); setError(null); await load(); }
    catch (e) { setError((e as Error).message); }
  }

  if (!data) return <div className="p-6 text-sm text-ink-muted">{error ?? "Loading the room…"}</div>;
  const { sitting, counts } = data;
  const started = now >= new Date(sitting.startTime).getTime();
  const ended = now >= new Date(sitting.endTime).getTime();

  return (
    <div className="space-y-4">
      {/* header */}
      <div className="flex items-start gap-4 flex-wrap">
        <div className="min-w-0">
          <Link to={backTo} className="t-sub hover:underline">← My sittings</Link>
          <h1 className="text-[21px] font-bold tracking-tight leading-tight mt-0.5">{sitting.name}</h1>
          <p className="text-[13px] text-ink-muted">{sitting.qualificationTitle} · Paper {sitting.paper} · {sitting.minutes} min{sitting.venue ? ` · ${sitting.venue}` : ""} · {hhmm(sitting.startTime)}–{hhmm(sitting.endTime)}{sitting.invigilators.length ? ` · Invigilators: ${sitting.invigilators.map((i) => i.name).join(", ")}` : ""}</p>
        </div>
        <span className="flex-1" />
        <div className="flex items-center gap-2 flex-wrap">
          <Stat n={counts.total} l="on roster" />
          <Stat n={counts.checkedIn} l="checked in" tone="teal" />
          <Stat n={counts.writing} l="writing" tone="blue" />
          <Stat n={counts.locked} l="locked" tone={counts.locked ? "amber" : undefined} />
          <Stat n={counts.needsYou} l="need you" tone={counts.needsYou ? "red" : undefined} />
          <Stat n={counts.submitted} l="submitted" tone="green" />
          <div className="rounded-lg border border-line bg-surface px-3 py-1.5 text-center min-w-[92px]">
            <div className="font-display tabular font-extrabold text-[17px] leading-tight">{new Date(now).toLocaleTimeString("en-ZA", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</div>
            <div className="text-[10.5px] uppercase tracking-wide text-ink-faint">{ended ? "sitting ended" : started ? "server clock" : "opens " + hhmm(sitting.startTime)}</div>
          </div>
        </div>
      </div>

      {error && <Notice kind="error">{error}</Notice>}
      {message && <Notice kind="success">{message}</Notice>}

      {/* alerts strip */}
      <AlertsStrip alerts={data.alerts} fresh={fresh} onPick={(a) => { if (a.learnerId) setSelectedId(a.learnerId); }} />

      <div className="grid gap-4 xl:grid-cols-[1fr_400px]">
        {/* learner cards */}
        <div className="space-y-3 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            {([["attention", "Everyone · attention first"], ["writing", `Writing · ${counts.writing}`], ["locked", `Locked · ${counts.locked}`], ["waiting", `Waiting · ${counts.scheduled + counts.checkedIn}`], ["done", `Submitted · ${counts.submitted}`]] as [Filter, string][]).map(([f, l]) => (
              <button key={f} type="button" onClick={() => setFilter(f)} className={"rounded-full border px-3 py-1 text-[12.5px] font-semibold " + (filter === f ? "border-brand-600 bg-brand-600 text-white" : "border-line bg-surface text-ink-muted hover:bg-surface-2")}>{l}</button>
            ))}
            <span className="flex-1" />
            <input className="inp max-w-[220px]" placeholder="Find a learner…" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          {shown.length === 0 ? (
            <p className="t-sub py-8 text-center">{learners.length === 0 ? "Nobody is on this roster yet." : "No learner matches."}</p>
          ) : (
            <div className="grid gap-2.5 [grid-template-columns:repeat(auto-fill,minmax(168px,1fr))]">
              {shown.map((l) => <LearnerCard key={l.sessionId} l={l} now={now} selected={l.learnerId === selectedId} onClick={() => setSelectedId(l.learnerId)} />)}
            </div>
          )}
        </div>

        {/* side panel */}
        <div className="min-w-0">
          {selected ? (
            <LearnerPanel key={selected.sessionId} l={selected} sittingId={sitting.id} now={now} act={act} incidentTypes={data.manualIncidentTypes} watch={watch} setWatch={setWatch} onClose={() => setSelectedId(null)} />
          ) : (
            <div className="card p-6 text-center text-[13.5px] text-ink-muted">
              <p className="font-semibold text-ink">Pick a learner</p>
              <p className="mt-1">Click any card to watch that learner, release a locked paper, send a message, grant time, record what you see, or end the paper.</p>
              <p className="t-sub mt-3">Cards refresh every {POLL_MS / 1000} seconds. A red ring means the learner needs you now; amber means worth a look.</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Stat({ n, l, tone }: { n: number; l: string; tone?: "teal" | "blue" | "amber" | "red" | "green" }) {
  const cls = tone === "red" ? "border-red-300 bg-red-50 text-red-800" : tone === "amber" ? "border-amber-300 bg-amber-50 text-amber-900" : tone === "blue" ? "border-blue-200 bg-blue-50 text-blue-800" : tone === "teal" ? "border-teal-200 bg-teal-50 text-teal-800" : tone === "green" ? "border-brand-200 bg-brand-50 text-brand-800" : "border-line bg-surface text-ink";
  return (
    <div className={"rounded-lg border px-3 py-1.5 text-center min-w-[74px] " + cls}>
      <div className="font-display tabular font-extrabold text-[17px] leading-tight">{n}</div>
      <div className="text-[10.5px] uppercase tracking-wide opacity-80">{l}</div>
    </div>
  );
}

function AlertsStrip({ alerts, fresh, onPick }: { alerts: LiveAlert[]; fresh: Set<string>; onPick: (a: LiveAlert) => void }) {
  const [open, setOpen] = useState(true);
  const shown = open ? alerts.slice(0, 12) : alerts.slice(0, 3);
  if (alerts.length === 0) return <div className="rounded-lg border border-line bg-surface px-4 py-2 text-[12.5px] text-ink-faint">No incidents yet. Anything the room records — leaving the window, paste attempts, camera or screen problems — appears here the moment it happens.</div>;
  return (
    <div className="rounded-lg border border-line bg-surface px-3 py-2">
      <div className="flex items-center gap-2 mb-1">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-muted">Live incidents</span>
        <span className="t-sub">newest first · click a line to open that learner</span>
        <span className="flex-1" />
        <button type="button" className="lnk text-[12px]" onClick={() => setOpen(!open)}>{open ? "Show fewer" : `Show ${Math.min(12, alerts.length)}`}</button>
      </div>
      <ul className="divide-y divide-line">
        {shown.map((a) => {
          const serious = ["screen_share_lost", "unauthorised_material", "phone", "identity_doubt", "other_person", "ended_by_invigilator", "devtools"].includes(a.type);
          return (
            <li key={a.id}>
              <button type="button" onClick={() => onPick(a)} className={"w-full text-left flex items-center gap-3 py-1.5 text-[13px] hover:bg-surface-2 rounded px-1 " + (fresh.has(a.id) ? "bg-amber-50" : "")}>
                <span className="tabular text-ink-faint text-[12px] w-[62px] shrink-0">{hhmmss(a.at)}</span>
                <span className={"h-2 w-2 rounded-full shrink-0 " + (serious ? "bg-red-500" : a.by === "system" ? "bg-amber-400" : "bg-blue-400")} />
                <span className="font-semibold truncate max-w-[220px]">{a.learnerName}</span>
                <span className="text-ink-muted truncate">{label(a.type)}{a.detail && !["note_to_learner"].includes(a.type) ? ` — ${a.detail}` : a.type === "note_to_learner" ? `: "${a.detail}"` : ""}</span>
                <span className="flex-1" />
                {a.by !== "system" && <span className="t-sub shrink-0">{a.by}</span>}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function LearnerCard({ l, now, selected, onClick }: { l: LiveLearner; now: number; selected: boolean; onClick: () => void }) {
  const ring = l.attention === "red" ? "ring-2 ring-red-500 border-red-300" : l.attention === "amber" ? "ring-2 ring-amber-400 border-amber-300" : selected ? "ring-2 ring-brand-500 border-brand-300" : "border-line hover:border-line-strong";
  const done = l.status === "submitted" || l.status === "sealed";
  return (
    <button type="button" onClick={onClick} className={"text-left rounded-lg border bg-surface overflow-hidden transition " + ring}>
      <div className="relative aspect-[4/3] bg-[#1B2A22]">
        {l.latestPhotoId ? (
          <img src={`/api/sit/evidence/${l.latestPhotoId}`} alt="" className={"h-full w-full object-cover " + (done ? "opacity-60 grayscale" : "")} />
        ) : l.identityPhotoId ? (
          <img src={`/api/sit/evidence/${l.identityPhotoId}`} alt="" className="h-full w-full object-cover opacity-70" />
        ) : (
          <div className="h-full w-full grid place-items-center text-white/40 text-[12px]">{l.status === "scheduled" ? "not arrived" : "no photo yet"}</div>
        )}
        {l.status === "in_progress" && (
          <div className={"absolute top-1.5 left-1.5 rounded px-1.5 py-0.5 font-display tabular font-bold text-[12px] " + (l.locked ? "bg-amber-400 text-[#1B2A22]" : "bg-black/60 text-white")}>{remaining(l.deadline, now)}</div>
        )}
        {l.noSignal && <div className="absolute inset-0 grid place-items-center bg-red-900/60 text-white font-display font-bold text-[13px]">NO SIGNAL</div>}
        {l.locked && !l.noSignal && <div className="absolute inset-x-0 bottom-0 bg-amber-400 text-[#1B2A22] text-center text-[11px] font-bold py-0.5">{l.requiresInvigilator ? "LOCKED — NEEDS YOU" : "LOCKED"}</div>}
        {l.lastPhotoAt && l.status === "in_progress" && <div className="absolute bottom-1 right-1.5 text-white/70 text-[10px] tabular">{hhmm(l.lastPhotoAt)}</div>}
      </div>
      <div className="p-2">
        <div className="font-semibold text-[13px] truncate">{l.name}</div>
        <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
          <Badge tone={done ? "green" : l.status === "in_progress" ? "blue" : l.status === "checked_in" ? "teal" : "gray"}>{STATUS_LABEL[l.status] ?? l.status}</Badge>
          {l.status === "in_progress" && <span className="t-sub">{l.answered}/{l.questionCount}</span>}
        </div>
        {l.attentionReasons.length > 0 && <div className={"text-[11.5px] mt-1 truncate " + (l.attention === "red" ? "text-red-700" : "text-amber-800")}>{l.attentionReasons.join(" · ")}</div>}
      </div>
    </button>
  );
}

function LearnerPanel({ l, sittingId, now, act, incidentTypes, watch, setWatch, onClose }: {
  l: LiveLearner; sittingId: string; now: number;
  act: (path: string, body: unknown, done: string) => Promise<void>;
  incidentTypes: { code: string; title: string; severity: string }[];
  watch: boolean; setWatch: (v: boolean) => void; onClose: () => void;
}) {
  const [mode, setMode] = useState<"actions" | "note" | "time" | "incident" | "end" | "evidence">("actions");
  const [text, setText] = useState("");
  const [mins, setMins] = useState("10");
  const [reason, setReason] = useState("");
  const [incType, setIncType] = useState("");
  const [warn, setWarn] = useState(true);
  const [evidence, setEvidence] = useState<EvidenceResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const writing = l.status === "in_progress";
  const done = l.status === "submitted" || l.status === "sealed";

  useEffect(() => { if (mode === "evidence") api.get<EvidenceResponse>(`/sittings/${sittingId}/learners/${l.learnerId}/evidence`).then(setEvidence).catch(() => setEvidence(null)); }, [mode, sittingId, l.learnerId, l.incidents, l.photos, l.screens]);

  const run = async (path: string, body: unknown, done: string) => { setBusy(true); try { await act(path, body, done); setMode("actions"); setText(""); setReason(""); setIncType(""); } finally { setBusy(false); } };

  return (
    <div className="card">
      <div className="card-head">
        <div className="min-w-0">
          <h2 className="truncate">{l.name}</h2>
          <p>{l.studentNumber ? `${l.studentNumber} · ` : ""}ID {l.idNumberMasked ?? "—"}{l.entries ? ` · entered ${l.entries}×` : ""}</p>
        </div>
        <button type="button" className="lnk" onClick={onClose}>Close</button>
      </div>

      {/* live pictures */}
      <div className={"grid gap-1 p-2 bg-[#1B2A22] " + (watch ? "grid-cols-1" : "grid-cols-2")}>
        <Still id={l.latestPhotoId ?? l.identityPhotoId} at={l.lastPhotoAt} caption={l.latestPhotoId ? "Camera" : l.identityPhotoId ? "Identity photo (no capture yet)" : "Camera"} tall={watch} />
        <Still id={l.latestScreenId} at={l.lastScreenAt} caption={l.screenShare && l.screenShare !== "monitor" ? `Screen · ${l.screenShare === "none" || l.screenShare === "unsupported" ? "not shared" : "only a " + l.screenShare}` : "Screen"} tall={watch} />
        {l.identityPhotoId && l.latestPhotoId && <Still id={l.identityPhotoId} at={l.checkInTime} caption="Identity photo at check-in" small />}
      </div>
      <div className="flex items-center gap-3 px-4 py-2 border-b border-line text-[12.5px]">
        <button type="button" className="lnk" onClick={() => setWatch(!watch)}>{watch ? "Smaller" : "Watch large"}</button>
        {writing && <button type="button" className="lnk" disabled={busy || l.captureRequested} onClick={() => run("request-capture", {}, `Asked ${l.name}'s browser for a photo and screen now.`)}>{l.captureRequested ? "Capture requested…" : "Capture now"}</button>}
        <span className="flex-1" />
        <span className="t-sub">{l.photos} photos · {l.screens} screens{l.lastSeenAt && writing ? ` · seen ${Math.max(0, Math.round((now - new Date(l.lastSeenAt).getTime()) / 1000))} s ago` : ""}</span>
      </div>

      {/* state */}
      <div className="px-4 py-3 border-b border-line text-[13px] space-y-1">
        <div className="flex items-center gap-2 flex-wrap">
          <Badge tone={done ? "green" : writing ? (l.locked ? "amber" : "blue") : l.status === "checked_in" ? "teal" : "gray"}>{l.locked ? (l.requiresInvigilator ? "Locked — needs you" : "Locked (may self-resume)") : STATUS_LABEL[l.status] ?? l.status}</Badge>
          {writing && <span className="font-display tabular font-bold">{remaining(l.deadline, now)} left</span>}
          {l.extraMinutes > 0 && <span className="t-sub">+{l.extraMinutes} min</span>}
          {l.noSignal && <span className="text-red-700 font-semibold">No signal for over a minute</span>}
        </div>
        {l.lockReason && l.locked && <p className="text-amber-800">{l.lockReason}</p>}
        <p className="t-sub">
          {writing || done ? `${l.answered} of ${l.questionCount} answered · ` : ""}
          {l.focusLosses + l.fullscreenExits ? `left window ${l.focusLosses + l.fullscreenExits}× · ` : ""}{l.locks ? `locked ${l.locks}× · ` : ""}{l.pasteAttempts ? `${l.pasteAttempts} paste · ` : ""}{l.cameraLost ? `camera dropped ${l.cameraLost}× · ` : ""}{l.incidents} incident{l.incidents === 1 ? "" : "s"}
          {l.startedAt ? ` · opened ${hhmm(l.startedAt)}` : l.checkInTime ? ` · checked in ${hhmm(l.checkInTime)}` : ""}
          {done && l.submissionTime ? ` · submitted ${hhmm(l.submissionTime)}` : ""}{l.sealHash ? ` · seal ${l.sealHash}` : ""}
        </p>
      </div>

      {/* actions */}
      <div className="p-4 space-y-3">
        {mode === "actions" && (
          <div className="grid grid-cols-2 gap-2">
            {l.locked && <button type="button" className="btn col-span-2" disabled={busy} onClick={() => run("resume", {}, `${l.name}'s paper is unlocked.`)}>Release the paper</button>}
            {(writing || l.status === "checked_in") && <button type="button" className="btn-ghost" onClick={() => setMode("note")}>Send a message</button>}
            {writing && <button type="button" className="btn-ghost" onClick={() => setMode("time")}>Extra time</button>}
            {(writing || l.status === "checked_in") && <button type="button" className="btn-ghost" onClick={() => setMode("incident")}>Record what I see</button>}
            {writing && <button type="button" className="btn-ghost text-red-700 border-red-200 hover:bg-red-50" onClick={() => setMode("end")}>End the paper</button>}
            {l.codeIssued && l.entries > 0 && !l.reentryAllowed && !done && <button type="button" className="btn-ghost" disabled={busy} onClick={() => run("allow-reentry", {}, `${l.name} may enter their code once more.`)}>Allow re-entry</button>}
            <button type="button" className="btn-ghost col-span-2" onClick={() => setMode("evidence")}>Evidence timeline{l.incidents ? ` · ${l.incidents} incident${l.incidents === 1 ? "" : "s"}` : ""}</button>
          </div>
        )}
        {mode === "note" && (
          <Form title="Message to the learner" hint="Appears on their screen until they press OK. Recorded in the evidence." onCancel={() => setMode("actions")} onOk={() => run("note", { text }, `Message sent to ${l.name}.`)} okLabel="Send" busy={busy} disabled={text.trim().length < 2}>
            <div className="flex gap-1.5 flex-wrap mb-2">{["Please keep your eyes on your own screen.", "Please stay in full-screen mode.", "Your invigilator is on the way to you.", "Ten minutes remaining."].map((t) => <button key={t} type="button" className="rounded-full border border-line px-2.5 py-0.5 text-[12px] hover:bg-surface-2" onClick={() => setText(t)}>{t}</button>)}</div>
            <textarea className="inp" rows={3} value={text} onChange={(e) => setText(e.target.value)} placeholder="Type the message" maxLength={300} />
          </Form>
        )}
        {mode === "time" && (
          <Form title="Extra time" hint="Added to this learner's clock only; never past the end of the sitting. Recorded with your reason." onCancel={() => setMode("actions")} onOk={() => run("extra-time", { minutes: Number(mins), reason }, `${l.name} has ${mins} more minutes.`)} okLabel="Grant" busy={busy} disabled={!(Number(mins) >= 1) || reason.trim().length < 3}>
            <div className="grid grid-cols-[100px_1fr] gap-2">
              <input className="inp" type="number" min={1} max={180} value={mins} onChange={(e) => setMins(e.target.value)} />
              <input className="inp" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason (e.g. lost minutes during a lock)" maxLength={300} />
            </div>
          </Form>
        )}
        {mode === "incident" && (
          <Form title="Record what you see" hint="Goes into the evidence and the integrity summary the assessor sees. A photo and screen capture are taken at once." onCancel={() => setMode("actions")} onOk={() => run("incident", { type: incType, note: reason || undefined, warnLearner: warn && text.trim().length >= 2 ? text.trim() : undefined }, `Recorded: ${incidentTypes.find((t) => t.code === incType)?.title ?? incType}.`)} okLabel="Record" busy={busy} disabled={!incType}>
            <div className="grid grid-cols-2 gap-1.5">
              {incidentTypes.map((t) => <button key={t.code} type="button" onClick={() => setIncType(t.code)} className={"rounded-lg border px-2.5 py-1.5 text-left text-[12.5px] font-semibold " + (incType === t.code ? "border-brand-600 bg-brand-50 text-brand-800" : "border-line hover:bg-surface-2")}>{t.title}{t.severity === "high" && <span className="text-red-600 font-normal"> · serious</span>}</button>)}
            </div>
            <input className="inp mt-2" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="What exactly did you see? (optional)" maxLength={300} />
            <label className="flex items-center gap-2 mt-2 text-[12.5px]"><input type="checkbox" className="accent-brand-600" checked={warn} onChange={(e) => setWarn(e.target.checked)} /> Also warn the learner on screen</label>
            {warn && <input className="inp mt-1.5" value={text} onChange={(e) => setText(e.target.value)} placeholder="Warning shown to the learner" maxLength={300} />}
          </Form>
        )}
        {mode === "end" && (
          <Form title="End this learner's paper" hint="Submits and seals the paper as it stands. The learner cannot continue. Recorded with your reason and shown to the assessor." onCancel={() => setMode("actions")} onOk={() => run("submit", { reason }, `${l.name}'s paper was ended and sealed.`)} okLabel="End the paper" busy={busy} danger disabled={reason.trim().length < 3}>
            <input className="inp" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason (required)" maxLength={300} />
          </Form>
        )}
        {mode === "evidence" && (
          <div>
            <div className="flex items-center justify-between mb-2"><span className="font-display font-semibold text-[13.5px]">Evidence timeline</span><button type="button" className="lnk" onClick={() => setMode("actions")}>Back</button></div>
            {evidence ? <Timeline e={evidence} /> : <p className="t-sub">Loading…</p>}
          </div>
        )}
      </div>
    </div>
  );
}

function Still({ id, at, caption, tall, small }: { id: string | null | undefined; at: string | null | undefined; caption: string; tall?: boolean; small?: boolean }) {
  return (
    <figure className={"relative bg-black/40 rounded overflow-hidden " + (small ? "col-span-2 h-20 w-28" : tall ? "aspect-video" : "aspect-[4/3]")}>
      {id ? <img src={`/api/sit/evidence/${id}`} alt={caption} className="h-full w-full object-contain" /> : <div className="h-full w-full grid place-items-center text-white/40 text-[11.5px]">none yet</div>}
      <figcaption className="absolute inset-x-0 bottom-0 bg-black/55 text-white/85 text-[10.5px] px-1.5 py-0.5 flex justify-between"><span>{caption}</span><span className="tabular">{hhmm(at)}</span></figcaption>
    </figure>
  );
}

function Form({ title, hint, children, onCancel, onOk, okLabel, busy, disabled, danger }: { title: string; hint: string; children: React.ReactNode; onCancel: () => void; onOk: () => void; okLabel: string; busy: boolean; disabled?: boolean; danger?: boolean }) {
  return (
    <div className="rounded-lg border border-line bg-surface-2 p-3">
      <div className="font-display font-semibold text-[13.5px]">{title}</div>
      <p className="t-sub mb-2">{hint}</p>
      {children}
      <div className="flex justify-end gap-2 mt-3">
        <button type="button" className="btn-ghost btn-sm" onClick={onCancel}>Cancel</button>
        <button type="button" className={"btn btn-sm " + (danger ? "!bg-red-600 hover:!bg-red-700" : "")} disabled={busy || disabled} onClick={onOk}>{okLabel}</button>
      </div>
    </div>
  );
}

export function IntegrityBadge({ r }: { r: IntegritySummary["recommendation"] }) {
  return <Badge tone={r === "clear" ? "green" : r === "review" ? "amber" : "red"}>{r === "clear" ? "Clear" : r === "review" ? "Review" : "Investigate"}</Badge>;
}

export function Timeline({ e, showIntegrity = true }: { e: EvidenceResponse; showIntegrity?: boolean }) {
  const [big, setBig] = useState<string | null>(null);
  const images = e.timeline.filter((t) => t.blobId);
  const events = e.timeline.filter((t) => !t.blobId);
  return (
    <div className="space-y-3 text-[13px]">
      {showIntegrity && e.integrity && (
        <div className="rounded-lg border border-line p-3">
          <div className="flex items-center gap-2"><IntegrityBadge r={e.integrity.recommendation} /><span className="font-semibold">{e.integrity.headline}</span></div>
          <ul className="mt-2 space-y-1">
            {e.integrity.findings.filter((f) => f.severity !== "info").map((f) => <li key={f.code} className="flex gap-2"><span className={"mt-1.5 h-2 w-2 rounded-full shrink-0 " + (f.severity === "high" ? "bg-red-500" : f.severity === "medium" ? "bg-amber-400" : "bg-blue-300")} /><span><span className="font-semibold">{f.title}.</span> <span className="text-ink-muted">{f.detail}</span></span></li>)}
          </ul>
        </div>
      )}
      <div>
        <div className="field-lbl">Captures · {images.length}</div>
        <div className="grid grid-cols-4 gap-1 max-h-64 overflow-auto pr-1">
          {images.map((t) => (
            <button key={t.blobId} type="button" onClick={() => setBig(t.blobId!)} className={"relative aspect-[4/3] rounded overflow-hidden border " + (t.kind === "identity_photo" ? "border-brand-400" : "border-line")} title={`${label(t.kind)} ${hhmmss(t.at)}`}>
              <img src={`/api/sit/evidence/${t.blobId}`} alt="" className="h-full w-full object-cover" loading="lazy" />
              <span className="absolute inset-x-0 bottom-0 bg-black/55 text-white text-[9.5px] px-1 tabular">{t.kind === "screen" ? "▭ " : t.kind === "identity_photo" ? "ID " : ""}{hhmm(t.at)}</span>
            </button>
          ))}
        </div>
        {big && (
          <div className="fixed inset-0 z-50 bg-black/80 grid place-items-center p-6" onClick={() => setBig(null)}>
            <img src={`/api/sit/evidence/${big}`} alt="" className="max-h-full max-w-full rounded-lg" />
          </div>
        )}
      </div>
      <div>
        <div className="field-lbl">Events · {events.length}</div>
        <ul className="divide-y divide-line max-h-72 overflow-auto">
          {events.map((t, i) => (
            <li key={i} className="py-1.5 flex gap-3">
              <span className="tabular text-ink-faint text-[12px] w-[62px] shrink-0">{hhmmss(t.at)}</span>
              <span className="min-w-0"><span className="font-semibold">{label(t.type)}</span>{t.detail ? <span className="text-ink-muted"> — {t.detail}</span> : null}{t.by && t.by !== "system" ? <span className="t-sub"> · {t.by}</span> : null}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
