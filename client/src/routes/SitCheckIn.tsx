import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { BrandMark } from "../components/Shell";

// Block 5a - the learner's way into a proctored sitting: sitting code + ID
// number, the conditions, a camera check with an identity photo, then the
// waiting room until the sitting starts.

interface SitState {
  sessionId: string;
  status: string;
  learner: { name: string; idNumberLast4: string | null };
  sitting: { id: string; name: string; qualificationTitle: string; paper: string; venue: string | null; startTime: string; endTime: string; minutes: number; permittedMaterials: string[] };
  precheck: { consent: boolean; device: boolean; camera: boolean | null; microphone: boolean | null; identityPhoto: boolean; checkedIn: boolean };
  consent: { version: string; text: string[] };
  window: { opensAt: string; canStart: boolean; closed: boolean; serverTime: string };
}

const fmt = (iso: string) => new Date(iso).toLocaleString(undefined, { weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" });

export default function SitCheckIn() {
  const navigate = useNavigate();
  const { refresh } = useAuth();
  const [state, setState] = useState<SitState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [reentryNeeded, setReentryNeeded] = useState(false);

  // Step 0: enter
  const [code, setCode] = useState("");
  const [idNumber, setIdNumber] = useState("");

  async function enter(e: React.FormEvent) {
    e.preventDefault();
    setError(null); setReentryNeeded(false); setBusy(true);
    try {
      const s = await api.post<SitState>("/sit/enter", { code, idNumber });
      setState(s);
      await refresh();
    } catch (err) {
      const body = (err as Error & { body?: { error?: string; reentry?: boolean } }).body;
      setError(body?.error ?? (err as Error).message);
      setReentryNeeded(Boolean(body?.reentry));
    } finally { setBusy(false); }
  }

  const step = !state ? 0 : !state.precheck.consent ? 1 : !state.precheck.identityPhoto ? 2 : 3;

  return (
    <div className="min-h-screen bg-surface-bg px-4 py-10">
      <div className="mx-auto w-full max-w-[760px]">
        <div className="flex items-center gap-3 mb-6">
          <BrandMark size={40} />
          <div>
            <p className="font-display font-extrabold text-lg leading-tight tracking-tight">FPT Exam</p>
            <p className="text-[12px] text-ink-faint">Secure Exam Centre · {state ? state.sitting.name : "sitting check-in"}</p>
          </div>
          {state && (
            <div className="ml-auto text-right text-[12.5px] text-ink-muted">
              <div className="font-semibold text-ink">{state.learner.name}</div>
              <div>ID ••••••••• {state.learner.idNumberLast4}</div>
            </div>
          )}
        </div>

        {state && (
          <ol className="flex items-center gap-2 text-[12.5px] mb-5">
            {["Conditions", "Camera and photo", "Ready to start"].map((label, i) => {
              const n = i + 1;
              const done = step > n;
              const active = step === n;
              return (
                <li key={label} className={"flex items-center gap-2 " + (i < 2 ? "flex-1" : "")}>
                  <span className={"h-6 w-6 rounded-full grid place-items-center text-[11px] font-bold " + (done ? "bg-brand-600 text-white" : active ? "bg-brand-50 text-brand-700 ring-2 ring-brand-500" : "bg-surface-2 text-ink-faint")}>{done ? "✓" : n}</span>
                  <span className={active ? "font-semibold" : "text-ink-muted"}>{label}</span>
                  {i < 2 && <span className="flex-1 h-px bg-line ml-1" />}
                </li>
              );
            })}
          </ol>
        )}

        {error && <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">{error}{reentryNeeded && <div className="mt-1 text-[12.5px]">Your invigilator can allow you back in from their console; then enter the same code again.</div>}</div>}

        {step === 0 && (
          <form onSubmit={enter} className="rounded-xl border border-line bg-surface shadow-card">
            <div className="px-6 pt-5 pb-4 border-b border-line">
              <p className="font-display font-bold text-[17px]">Enter your sitting</p>
              <p className="text-sm text-ink-muted mt-1">Your invigilator gives you a sitting code for today's exam. Enter it with your ID number. Check-in opens 45 minutes before the start.</p>
            </div>
            <div className="px-6 py-5 grid grid-cols-2 gap-4 max-w-[560px]">
              <div>
                <label className="field-lbl">Sitting code</label>
                <input className="inp tabular tracking-widest uppercase" autoFocus autoComplete="off" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="XXXX-XXXX-XXXX" required />
              </div>
              <div>
                <label className="field-lbl">Your ID number</label>
                <input className="inp tabular" inputMode="numeric" autoComplete="off" value={idNumber} onChange={(e) => setIdNumber(e.target.value.replace(/[^\d ]/g, ""))} placeholder="13 digits" required />
              </div>
            </div>
            <div className="px-6 pb-5"><button className="btn" disabled={busy}>{busy ? "Checking…" : "Continue"}</button></div>
          </form>
        )}

        {state && step === 1 && <ConsentStep state={state} onDone={setState} onError={setError} />}
        {state && step === 2 && <CameraStep state={state} onDone={setState} onError={setError} />}
        {state && step === 3 && <ReadyStep state={state} onState={setState} onError={setError} onStart={() => navigate(`/learner?open=${state.sessionId}`)} />}

        <p className="t-sub mt-6 text-center">© {new Date().getFullYear()} FPT Academy. All rights reserved.</p>
      </div>
    </div>
  );
}

function SittingCard({ s }: { s: SitState }) {
  return (
    <div className="rounded-lg border border-line bg-surface-2/60 p-4 text-[13.5px] grid grid-cols-2 gap-y-1.5 gap-x-6">
      <div><span className="text-ink-muted">Paper</span><div className="font-semibold">{s.sitting.qualificationTitle}</div><div className="t-sub">{s.sitting.paper} · {s.sitting.minutes} minutes</div></div>
      <div><span className="text-ink-muted">When</span><div className="font-semibold">{fmt(s.sitting.startTime)}</div><div className="t-sub">until {new Date(s.sitting.endTime).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}{s.sitting.venue ? ` · ${s.sitting.venue}` : ""}</div></div>
      {s.sitting.permittedMaterials.length > 0 && <div className="col-span-2"><span className="text-ink-muted">Permitted materials</span><div>{s.sitting.permittedMaterials.join(", ")}</div></div>}
    </div>
  );
}

function ConsentStep({ state, onDone, onError }: { state: SitState; onDone: (s: SitState) => void; onError: (m: string | null) => void }) {
  const [accepted, setAccepted] = useState(false);
  const [busy, setBusy] = useState(false);
  async function accept() {
    setBusy(true); onError(null);
    try { onDone(await api.post<SitState>(`/sit/${state.sessionId}/consent`, { version: state.consent.version, accepted: true })); }
    catch (err) { onError((err as Error).message); } finally { setBusy(false); }
  }
  return (
    <div className="rounded-xl border border-line bg-surface shadow-card">
      <div className="px-6 pt-5 pb-4 border-b border-line">
        <p className="font-display font-bold text-[17px]">Before you start, {state.learner.name.split(" ")[0]}</p>
        <p className="text-sm text-ink-muted mt-1">Read the conditions of this proctored examination.</p>
      </div>
      <div className="px-6 py-5 space-y-4">
        <SittingCard s={state} />
        <ol className="list-decimal pl-5 space-y-2 text-[13.5px] leading-relaxed">
          {state.consent.text.map((t, i) => <li key={i}>{t}</li>)}
        </ol>
        <label className="flex items-start gap-3 rounded-lg border border-line p-3.5 cursor-pointer hover:bg-surface-2">
          <input type="checkbox" className="accent-brand-600 mt-0.5" checked={accepted} onChange={() => setAccepted((v) => !v)} />
          <span className="text-[13.5px]">I have read and accept these conditions. I am the registered learner and I am alone with no unauthorised materials.</span>
        </label>
        <button type="button" className="btn" disabled={!accepted || busy} onClick={accept}>{busy ? "Saving…" : "Accept and continue"}</button>
      </div>
    </div>
  );
}

function CameraStep({ state, onDone, onError }: { state: SitState; onDone: (s: SitState) => void; onError: (m: string | null) => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [camera, setCamera] = useState<"pending" | "ok" | "denied">("pending");
  const [mic, setMic] = useState<boolean | null>(null);
  const [shot, setShot] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: "user" }, audio: true });
        if (cancelled) { stream.getTracks().forEach((t) => t.stop()); return; }
        streamRef.current = stream;
        if (videoRef.current) { videoRef.current.srcObject = stream; await videoRef.current.play().catch(() => {}); }
        setCamera("ok");
        setMic(stream.getAudioTracks().length > 0);
        api.post(`/sit/${state.sessionId}/device`, { camera: true, microphone: stream.getAudioTracks().length > 0, userAgent: navigator.userAgent.slice(0, 400) }).catch(() => {});
      } catch {
        // Try video only before giving up - some machines have no microphone.
        try {
          const stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: "user" } });
          if (cancelled) { stream.getTracks().forEach((t) => t.stop()); return; }
          streamRef.current = stream;
          if (videoRef.current) { videoRef.current.srcObject = stream; await videoRef.current.play().catch(() => {}); }
          setCamera("ok"); setMic(false);
          api.post(`/sit/${state.sessionId}/device`, { camera: true, microphone: false, userAgent: navigator.userAgent.slice(0, 400) }).catch(() => {});
        } catch {
          setCamera("denied"); setMic(false);
          api.post(`/sit/${state.sessionId}/device`, { camera: false, microphone: false, userAgent: navigator.userAgent.slice(0, 400) }).catch(() => {});
        }
      }
    })();
    return () => { cancelled = true; streamRef.current?.getTracks().forEach((t) => t.stop()); };
  }, [state.sessionId]);

  function take() {
    const v = videoRef.current, c = canvasRef.current;
    if (!v || !c) return;
    c.width = 480; c.height = Math.round((480 * (v.videoHeight || 3)) / (v.videoWidth || 4));
    const ctx = c.getContext("2d");
    if (!ctx) return;
    ctx.drawImage(v, 0, 0, c.width, c.height);
    setShot(c.toDataURL("image/jpeg", 0.8));
  }

  async function submit() {
    if (!shot) return;
    setBusy(true); onError(null);
    try {
      const s = await api.post<SitState>(`/sit/${state.sessionId}/identity-photo`, { image: shot });
      streamRef.current?.getTracks().forEach((t) => t.stop());
      onDone(s);
    } catch (err) { onError((err as Error).message); } finally { setBusy(false); }
  }

  return (
    <div className="rounded-xl border border-line bg-surface shadow-card">
      <div className="px-6 pt-5 pb-4 border-b border-line">
        <p className="font-display font-bold text-[17px]">Camera check and identity photo</p>
        <p className="text-sm text-ink-muted mt-1">Allow the camera when your browser asks. Look straight at it, with your face clearly visible, and take your photo. The invigilator compares it with your registration.</p>
      </div>
      <div className="px-6 py-5 grid grid-cols-[1fr_260px] gap-6 items-start">
        <div className="space-y-3">
          <div className="relative rounded-xl overflow-hidden bg-black aspect-[4/3]">
            {!shot ? <video ref={videoRef} playsInline muted className="w-full h-full object-cover -scale-x-100" /> : <img src={shot} alt="Your identity photo" className="w-full h-full object-cover -scale-x-100" />}
            {camera === "denied" && (
              <div className="absolute inset-0 grid place-items-center text-center text-white/90 text-sm p-6 bg-black/70">
                <div><p className="font-semibold">The camera could not be started.</p><p className="mt-1 text-white/70">Allow camera access in your browser's address bar and reload this page. A proctored exam cannot be written without a camera.</p></div>
              </div>
            )}
            {camera === "pending" && <div className="absolute inset-0 grid place-items-center text-white/80 text-sm">Starting the camera…</div>}
          </div>
          <canvas ref={canvasRef} className="hidden" />
          <div className="flex gap-2">
            {!shot ? (
              <button type="button" className="btn" disabled={camera !== "ok"} onClick={take}>Take my photo</button>
            ) : (
              <>
                <button type="button" className="btn" disabled={busy} onClick={submit}>{busy ? "Saving…" : "Use this photo"}</button>
                <button type="button" className="btn-ghost" disabled={busy} onClick={() => setShot(null)}>Retake</button>
              </>
            )}
          </div>
        </div>
        <div className="space-y-2 text-[13.5px]">
          <div className="field-lbl">Checks</div>
          <Check ok={camera === "ok"} pending={camera === "pending"} label="Camera" />
          <Check ok={mic === true} pending={mic === null} label="Microphone" soft />
          <Check ok={Boolean(shot)} pending={false} label="Identity photo taken" />
          <p className="t-sub pt-2">Your camera stays on during the exam. Keep your face in view and stay alone in the room.</p>
        </div>
      </div>
    </div>
  );
}

function Check({ ok, pending, label, soft = false }: { ok: boolean; pending: boolean; label: string; soft?: boolean }) {
  return (
    <div className="flex items-center gap-2">
      <span className={"h-5 w-5 rounded-full grid place-items-center text-[11px] font-bold " + (ok ? "bg-brand-600 text-white" : pending ? "bg-surface-2 text-ink-faint" : soft ? "bg-amber-100 text-amber-800" : "bg-red-100 text-red-700")}>{ok ? "✓" : pending ? "…" : "!"}</span>
      <span>{label}{!ok && !pending && soft ? " — not found (allowed)" : ""}</span>
    </div>
  );
}

function ReadyStep({ state, onState, onError, onStart }: { state: SitState; onState: (s: SitState) => void; onError: (m: string | null) => void; onStart: () => void }) {
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!state.precheck.checkedIn) api.post<SitState>(`/sit/${state.sessionId}/check-in`).then(onState).catch((e) => onError((e as Error).message));
  }, [state.sessionId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    const poll = setInterval(() => api.get<SitState>(`/sit/${state.sessionId}/state`).then(onState).catch(() => {}), 20000);
    return () => { clearInterval(t); clearInterval(poll); };
  }, [state.sessionId]); // eslint-disable-line react-hooks/exhaustive-deps

  const start = new Date(state.sitting.startTime).getTime();
  const secs = Math.max(0, Math.round((start - now) / 1000));
  const canStart = now >= start && now < new Date(state.sitting.endTime).getTime();
  const mm = String(Math.floor(secs / 60)).padStart(2, "0"), ss = String(secs % 60).padStart(2, "0");

  async function begin() {
    setBusy(true); onError(null);
    try {
      await api.post(`/sessions/${state.sessionId}/start`);
      onStart();
    } catch (err) { onError((err as Error).message); } finally { setBusy(false); }
  }

  return (
    <div className="rounded-xl border border-line bg-surface shadow-card">
      <div className="px-6 pt-5 pb-4 border-b border-line">
        <p className="font-display font-bold text-[17px]">{canStart ? "Your exam is ready" : "You are checked in"}</p>
        <p className="text-sm text-ink-muted mt-1">{canStart ? "Press Start when your invigilator says so. The clock starts the moment the paper opens." : "Wait here. The Start button appears when the sitting begins."}</p>
      </div>
      <div className="px-6 py-5 space-y-4">
        <SittingCard s={state} />
        {!canStart && !state.window.closed && (
          <div className="rounded-lg border border-brand-100 bg-brand-50/60 p-4 text-center">
            <div className="text-[12px] font-semibold uppercase tracking-wide text-brand-700">Starts in</div>
            <div className="font-display text-4xl font-extrabold tabular text-brand-800 mt-1">{secs >= 3600 ? `${Math.floor(secs / 3600)}h ${mm}m` : `${mm}:${ss}`}</div>
          </div>
        )}
        {state.window.closed && <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">This sitting has ended.</div>}
        <ul className="text-[13.5px] text-ink-muted list-disc pl-5 space-y-1">
          <li>The exam opens full-screen. Leaving the exam window locks the paper and alerts your invigilator.</li>
          <li>Your answers save as you type. Submit when you have finished, or the paper submits itself when time runs out.</li>
          <li>If your connection drops, enter your code again — your invigilator can let you back in.</li>
        </ul>
        <button type="button" className="btn text-[15px] px-6 py-2.5" disabled={!canStart || busy} onClick={begin}>{busy ? "Opening…" : "Start the exam"}</button>
      </div>
    </div>
  );
}
