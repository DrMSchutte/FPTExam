import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api } from "../lib/api";
import type { PaperResponse } from "@shared/types";
import { BrandMark } from "../components/Shell";

// Block 5b - the locked paper. Full screen, one question at a time, the
// server's clock, answers saved as they are typed. Leaving the exam window or
// full screen locks the paper (recorded, invigilator alerted); the learner may
// put it back a limited number of times, after that the invigilator must.
// Camera stills every 45 s and screen stills every 2 min go to the server as
// evidence; paste/copy are blocked and recorded; time-up submits the paper.

interface RoomState {
  sessionId: string;
  status: string;
  startedAt: string | null;
  deadline: string;
  serverTime: string;
  extraMinutes: number;
  locked: boolean;
  lockReason: string | null;
  requiresInvigilator: boolean;
  locks: number;
  selfResumesLeft: number;
  cadence: { photoEverySeconds: number; screenEverySeconds: number };
  counts: { photos: number; screens: number; focusLosses: number; pasteAttempts: number };
  sealHash: string | null;
  notes: { id: string; text: string; at: string }[];
  captureRequested: boolean;
}
interface RoomResponse { room: RoomState; learner: { name: string }; sitting: { name: string; qualificationTitle: string; paper: string; minutes: number; permittedMaterials: string[] } }
type Paper = PaperResponse & { deadline: string; serverTime: string; startedAt: string | null; locked: boolean; requiresInvigilator: boolean; status: string };

const pad = (n: number) => String(n).padStart(2, "0");

export default function ExamRoom() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [info, setInfo] = useState<RoomResponse | null>(null);
  const [paper, setPaper] = useState<Paper | null>(null);
  const [room, setRoom] = useState<RoomState | null>(null);
  const [phase, setPhase] = useState<"setup" | "writing" | "submitted">("setup");
  const [error, setError] = useState<string | null>(null);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [idx, setIdx] = useState(0);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [skew, setSkew] = useState(0); // serverTime - clientTime, ms
  const [now, setNow] = useState(Date.now());
  const [confirmSubmit, setConfirmSubmit] = useState(false);
  const [screenSurface, setScreenSurface] = useState<string | null>(null);

  const camRef = useRef<MediaStream | null>(null);
  const screenRef = useRef<MediaStream | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const screenVideoRef = useRef<HTMLVideoElement>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const armed = useRef(false); // detection on only while writing
  const lockedRef = useRef(false);

  // ---- load ----
  useEffect(() => {
    if (!id) return;
    api.get<RoomResponse>(`/sit/${id}/room`).then((r) => {
      setInfo(r); setRoom(r.room);
      setSkew(new Date(r.room.serverTime).getTime() - Date.now());
      if (r.room.status === "submitted" || r.room.status === "sealed") setPhase("submitted");
    }).catch((e) => setError((e as Error).message));
  }, [id]);
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  useEffect(() => { lockedRef.current = Boolean(room?.locked); }, [room?.locked]);

  const sendEvent = useCallback(async (type: string, detail?: Record<string, unknown>) => {
    if (!id) return;
    try {
      const r = await api.post<{ room: RoomState }>(`/sit/${id}/event`, { type, detail });
      setRoom(r.room);
    } catch { /* keep going - the server may be briefly unreachable */ }
  }, [id]);

  // ---- detection: only while writing ----
  useEffect(() => {
    if (phase !== "writing") return;
    armed.current = true;
    const onVis = () => { if (document.visibilityState === "hidden" && armed.current) sendEvent("visibility_hidden"); };
    const onBlur = () => { if (armed.current) sendEvent("focus_loss", { at: new Date().toISOString() }); };
    const onFocus = () => { if (armed.current) sendEvent("focus_return"); };
    const onFs = () => { if (!document.fullscreenElement && armed.current) sendEvent("fullscreen_exit"); };
    const block = (e: Event) => { e.preventDefault(); sendEvent(e.type === "paste" ? "paste_attempt" : "copy_attempt"); };
    const onKey = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase();
      if ((e.ctrlKey || e.metaKey) && ["p", "s", "u", "c", "v", "x", "a"].includes(k) && !(e.target instanceof HTMLTextAreaElement && ["a"].includes(k))) { e.preventDefault(); if (k === "c" || k === "v" || k === "x") sendEvent(k === "v" ? "paste_attempt" : "copy_attempt", { key: k }); }
      if (k === "f12" || ((e.ctrlKey || e.metaKey) && e.shiftKey && ["i", "j", "c"].includes(k))) { e.preventDefault(); sendEvent("devtools"); }
    };
    const onCtx = (e: Event) => e.preventDefault();
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("blur", onBlur);
    window.addEventListener("focus", onFocus);
    document.addEventListener("fullscreenchange", onFs);
    document.addEventListener("paste", block); document.addEventListener("copy", block); document.addEventListener("cut", block);
    document.addEventListener("keydown", onKey);
    document.addEventListener("contextmenu", onCtx);
    return () => {
      armed.current = false;
      document.removeEventListener("visibilitychange", onVis); window.removeEventListener("blur", onBlur); window.removeEventListener("focus", onFocus);
      document.removeEventListener("fullscreenchange", onFs); document.removeEventListener("paste", block); document.removeEventListener("copy", block); document.removeEventListener("cut", block);
      document.removeEventListener("keydown", onKey); document.removeEventListener("contextmenu", onCtx);
    };
  }, [phase, sendEvent]);

  // ---- captures ----
  const snap = useCallback(async (kind: "photo" | "screen", reason?: string) => {
    if (!id) return;
    const v = kind === "photo" ? videoRef.current : screenVideoRef.current;
    if (!v || v.readyState < 2 || !v.videoWidth) return;
    const c = document.createElement("canvas");
    const w = kind === "photo" ? 480 : 1024;
    c.width = w; c.height = Math.round((w * v.videoHeight) / v.videoWidth);
    const ctx = c.getContext("2d"); if (!ctx) return;
    ctx.drawImage(v, 0, 0, c.width, c.height);
    const image = c.toDataURL("image/jpeg", kind === "photo" ? 0.7 : 0.6);
    try { await api.post(`/sit/${id}/capture`, { kind, image, reason }); } catch { /* throttled or offline */ }
  }, [id]);

  useEffect(() => {
    if (phase !== "writing" || !room) return;
    const p = setInterval(() => snap("photo"), room.cadence.photoEverySeconds * 1000);
    const s = setInterval(() => snap("screen"), room.cadence.screenEverySeconds * 1000);
    // Every 5 s: the clock, lock state, messages from the invigilator, capture requests - and the console's heartbeat.
    const poll = setInterval(() => id && api.get<RoomResponse>(`/sit/${id}/room`).then((r) => { setRoom(r.room); if (r.room.status !== "in_progress") setPhase("submitted"); }).catch(() => {}), 5000);
    const first = setTimeout(() => { snap("photo"); snap("screen"); }, 3000);
    return () => { clearInterval(p); clearInterval(s); clearInterval(poll); clearTimeout(first); };
  }, [phase, room?.cadence.photoEverySeconds, room?.cadence.screenEverySeconds, snap, id]); // eslint-disable-line react-hooks/exhaustive-deps

  // The setup and writing views render their own <video> elements; when the
  // view changes the streams have to be re-attached to the new elements.
  useEffect(() => {
    if (phase !== "writing") return;
    if (videoRef.current && camRef.current) { videoRef.current.srcObject = camRef.current; videoRef.current.play().catch(() => {}); }
    if (screenVideoRef.current && screenRef.current) { screenVideoRef.current.srcObject = screenRef.current; screenVideoRef.current.play().catch(() => {}); }
  }, [phase]);

  // A flagged capture whenever the paper locks.
  useEffect(() => { if (room?.locked && phase === "writing") { snap("photo", "lock"); snap("screen", "lock"); } }, [room?.locked, phase, snap]);
  // The invigilator asked for a capture now.
  useEffect(() => { if (room?.captureRequested && phase === "writing") { snap("photo", "requested"); snap("screen", "requested"); } }, [room?.captureRequested, phase, snap]);
  // A message from the invigilator: shown until the learner dismisses it.
  const note = room?.notes?.[0] ?? null;
  function dismissNote() { if (note) { sendEvent("note_seen", { id: note.id }); setRoom((r) => (r ? { ...r, notes: r.notes.filter((n) => n.id !== note.id) } : r)); } }

  // ---- begin: full screen + camera + screen share, then the paper ----
  async function begin() {
    setError(null);
    try {
      await document.documentElement.requestFullscreen?.();
    } catch { return setError("Full screen could not be started. Use a desktop browser (Chrome, Edge or Firefox) and allow full screen."); }
    try {
      camRef.current = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 640 }, facingMode: "user" }, audio: false });
      if (videoRef.current) { videoRef.current.srcObject = camRef.current; await videoRef.current.play().catch(() => {}); }
      camRef.current.getVideoTracks()[0].onended = () => sendEvent("camera_lost");
    } catch { await document.exitFullscreen?.().catch(() => {}); return setError("The camera is required for the whole sitting. Allow it and try again."); }
    try {
      const md = navigator.mediaDevices as MediaDevices & { getDisplayMedia?: (c: unknown) => Promise<MediaStream> };
      if (!md.getDisplayMedia) { setScreenSurface("unsupported"); await sendEvent("screen_share", { surface: "unsupported" }); }
      else {
        screenRef.current = await md.getDisplayMedia({ video: { frameRate: 2 }, audio: false, preferCurrentTab: false } as unknown);
        const track = screenRef.current.getVideoTracks()[0];
        const surface = (track.getSettings() as MediaTrackSettings & { displaySurface?: string }).displaySurface ?? "unknown";
        setScreenSurface(surface);
        if (screenVideoRef.current) { screenVideoRef.current.srcObject = screenRef.current; await screenVideoRef.current.play().catch(() => {}); }
        track.onended = () => sendEvent("screen_share_lost");
        await sendEvent("screen_share", { surface });
        if (surface !== "monitor" && surface !== "unknown") {
          track.stop(); screenRef.current = null;
          await document.exitFullscreen?.().catch(() => {});
          camRef.current?.getTracks().forEach((t) => t.stop());
          return setError(`Share your entire screen, not a window or a tab (you shared: ${surface}). Press Begin again and choose "Entire screen".`);
        }
      }
    } catch { await document.exitFullscreen?.().catch(() => {}); camRef.current?.getTracks().forEach((t) => t.stop()); return setError("Screen sharing is required: when the browser asks, choose \"Entire screen\" and press Share."); }
    try {
      const p = await api.get<Paper>(`/sessions/${id}/paper`);
      setPaper(p); setAnswers(Object.fromEntries(Object.entries(p.existingAnswers ?? {}).map(([k, v]) => [k, String(v ?? "")])));
      setSkew(new Date(p.serverTime).getTime() - Date.now());
      setPhase("writing");
    } catch (e) { setError((e as Error).message); }
  }

  // ---- answers ----
  function updateAnswer(qid: string, value: string) {
    setAnswers((a) => ({ ...a, [qid]: value }));
    setSaveState("saving");
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      try { await api.post(`/sessions/${id}/answers`, { answers: { [qid]: value } }); setSaveState("saved"); }
      catch { setSaveState("error"); }
    }, 600);
  }

  const submit = useCallback(async (auto = false) => {
    if (!id) return;
    try {
      if (saveTimer.current) { clearTimeout(saveTimer.current); saveTimer.current = null; }
      await api.post(`/sessions/${id}/answers`, { answers }).catch(() => {});
      await api.post(`/sessions/${id}/submit`);
      const r = await api.get<RoomResponse>(`/sit/${id}/room`).catch(() => null);
      if (r) setRoom(r.room);
      setPhase("submitted");
      armed.current = false;
      camRef.current?.getTracks().forEach((t) => t.stop()); screenRef.current?.getTracks().forEach((t) => t.stop());
      await document.exitFullscreen?.().catch(() => {});
    } catch (e) { if (!auto) setError((e as Error).message); }
  }, [id, answers]);

  // ---- clock ----
  const deadline = paper ? new Date(paper.deadline).getTime() : room ? new Date(room.deadline).getTime() : 0;
  const remaining = Math.max(0, Math.round((deadline - (now + skew)) / 1000));
  useEffect(() => { if (phase === "writing" && paper && remaining === 0) submit(true); }, [remaining, phase, paper, submit]);
  // Re-sync deadline when extra time is granted (room poll updates room.deadline).
  useEffect(() => { if (room && paper && room.deadline !== paper.deadline) setPaper({ ...paper, deadline: room.deadline }); }, [room?.deadline]); // eslint-disable-line react-hooks/exhaustive-deps

  async function resume() {
    try {
      await document.documentElement.requestFullscreen?.().catch(() => {});
      const r = await api.post<{ room: RoomState }>(`/sit/${id}/resume`);
      setRoom(r.room);
    } catch (e) {
      const body = (e as Error & { body?: { room?: RoomState } }).body;
      if (body?.room) setRoom(body.room);
    }
  }

  if (error && !info) return <Shell><p className="text-red-700 text-sm">{error}</p></Shell>;
  if (!info || !room) return <Shell><p className="text-ink-muted text-sm">Loading…</p></Shell>;

  if (phase === "submitted") {
    return (
      <Shell>
        <div className="max-w-[640px] mx-auto rounded-xl border border-brand-100 bg-surface p-8 shadow-card text-center">
          <div className="mx-auto h-14 w-14 rounded-full bg-brand-600 text-white grid place-items-center text-2xl">✓</div>
          <h1 className="font-display text-2xl font-extrabold mt-4">Your exam has been submitted</h1>
          <p className="text-ink-muted mt-2">{info.sitting.name}. Your answers are sealed and will be marked by a registered assessor. Your result and feedback appear on FPT Exam once the assessor has signed them off.</p>
          {room.sealHash && <p className="text-[12px] text-ink-faint mt-4 font-mono">Seal {room.sealHash.slice(0, 16)}…</p>}
          <p className="text-sm text-ink-muted mt-4">You may close this window.</p>
        </div>
      </Shell>
    );
  }

  if (phase === "setup") {
    return (
      <Shell>
        <div className="max-w-[720px] mx-auto rounded-xl border border-line bg-surface shadow-card">
          <div className="px-6 pt-5 pb-4 border-b border-line">
            <p className="font-display font-bold text-[17px]">{info.sitting.name}</p>
            <p className="text-sm text-ink-muted mt-1">{info.sitting.qualificationTitle} · {info.sitting.minutes} minutes{info.sitting.permittedMaterials.length ? ` · permitted: ${info.sitting.permittedMaterials.join(", ")}` : ""}</p>
          </div>
          <div className="px-6 py-5 space-y-4 text-[13.5px]">
            <p>When you press <strong>Begin</strong>, three things happen, in this order:</p>
            <ol className="list-decimal pl-5 space-y-1.5">
              <li>The exam goes <strong>full screen</strong>. Stay in it — leaving locks your paper and alerts your invigilator.</li>
              <li>Your <strong>camera</strong> switches on and stays on. A photo is taken every {room.cadence.photoEverySeconds} seconds.</li>
              <li>Your browser asks you to <strong>share your screen</strong>: choose <em>Entire screen</em>. A screen still is taken every {Math.round(room.cadence.screenEverySeconds / 60)} minutes.</li>
            </ol>
            <p className="text-ink-muted">One question at a time; your answers save as you type; you can move back and forth. Copying and pasting are switched off. The clock starts the moment the paper opens{room.startedAt ? " (it already has)" : ""}.</p>
            {error && <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-amber-900">{error}</p>}
            <div className="flex items-center gap-3">
              <button type="button" className="btn text-[15px] px-6 py-2.5" onClick={begin}>Begin</button>
              <button type="button" className="btn-ghost" onClick={() => navigate("/sit")}>Back</button>
            </div>
          </div>
        </div>
        <video ref={videoRef} playsInline muted className="hidden" /><video ref={screenVideoRef} playsInline muted className="hidden" />
      </Shell>
    );
  }

  // ---- writing ----
  const qs = paper?.questions ?? [];
  const q = qs[idx];
  const answered = qs.filter((x) => (answers[x.id] ?? "").trim() !== "").length;
  const hh = Math.floor(remaining / 3600), mm = Math.floor((remaining % 3600) / 60), ss = remaining % 60;
  const urgent = remaining <= 600;

  return (
    <div className="fixed inset-0 bg-surface-bg text-ink select-none flex flex-col" onCopy={(e) => e.preventDefault()}>
      {/* top bar */}
      <div className="flex items-center gap-4 px-5 py-2.5 bg-surface border-b border-line shrink-0">
        <BrandMark size={28} />
        <div className="leading-tight">
          <div className="font-display font-bold text-[14px]">{info.sitting.name}</div>
          <div className="text-[11.5px] text-ink-muted">{info.learner.name} · {answered} of {qs.length} answered</div>
        </div>
        <span className="flex-1" />
        <div className="text-[11.5px] text-ink-faint">{saveState === "saving" ? "Saving…" : saveState === "saved" ? "Saved" : saveState === "error" ? "Not saved — check your connection" : ""}</div>
        <div className={"font-display tabular font-extrabold text-[20px] px-3 py-1 rounded-md " + (urgent ? "bg-amber-100 text-amber-900" : "bg-brand-50 text-brand-800")} title="Time remaining">
          {hh > 0 ? `${hh}:${pad(mm)}:${pad(ss)}` : `${pad(mm)}:${pad(ss)}`}
        </div>
        <button type="button" className="btn btn-sm" onClick={() => setConfirmSubmit(true)}>Submit</button>
      </div>

      <div className="flex-1 grid grid-cols-[220px_1fr] min-h-0">
        {/* question list */}
        <aside className="border-r border-line bg-surface overflow-auto p-3">
          <div className="field-lbl mb-2">Questions</div>
          <div className="grid grid-cols-4 gap-1.5">
            {qs.map((x, i) => {
              const done = (answers[x.id] ?? "").trim() !== "";
              return <button key={x.id} type="button" onClick={() => setIdx(i)} className={"h-9 rounded-md text-[13px] font-semibold border " + (i === idx ? "border-brand-600 bg-brand-600 text-white" : done ? "border-brand-200 bg-brand-50 text-brand-800" : "border-line text-ink-muted hover:bg-surface-2")}>{i + 1}</button>;
            })}
          </div>
          <div className="mt-4 text-[11.5px] text-ink-faint space-y-1">
            <div><span className="inline-block h-2.5 w-2.5 rounded-sm bg-brand-50 border border-brand-200 mr-1.5" />answered</div>
            <div><span className="inline-block h-2.5 w-2.5 rounded-sm border border-line mr-1.5" />not yet</div>
          </div>
          <div className="mt-6 text-[11.5px] text-ink-faint">
            <div className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-brand-500 animate-pulse" /> Camera on{screenSurface === "monitor" || screenSurface === "unknown" ? " · screen shared" : ""}</div>
          </div>
        </aside>

        {/* question */}
        <main className="overflow-auto p-8">
          {q && (
            <div className="max-w-[820px] mx-auto">
              <div className="flex items-baseline justify-between mb-3">
                <h2 className="font-display text-xl font-bold">Question {idx + 1}</h2>
                <span className="text-[13px] text-ink-muted">{q.maxMark} mark{q.maxMark === 1 ? "" : "s"}</span>
              </div>
              <p className="text-[15px] leading-relaxed whitespace-pre-wrap select-text">{q.prompt}</p>
              <div className="mt-5">
                {q.type === "mcq" ? (
                  <div className="space-y-2">
                    {(q.options ?? []).map((opt) => (
                      <label key={opt} className={"flex items-start gap-3 rounded-lg border px-4 py-3 cursor-pointer text-[14px] " + (answers[q.id] === opt ? "border-brand-600 bg-brand-50" : "border-line hover:bg-surface-2")}>
                        <input type="radio" className="accent-brand-600 mt-1" name={q.id} value={opt} checked={answers[q.id] === opt} onChange={(e) => updateAnswer(q.id, e.target.value)} />
                        <span>{opt}</span>
                      </label>
                    ))}
                  </div>
                ) : (
                  <textarea
                    value={answers[q.id] ?? ""}
                    onChange={(e) => updateAnswer(q.id, e.target.value)}
                    onPaste={(e) => e.preventDefault()}
                    rows={q.type === "long_answer" ? 14 : 5}
                    spellCheck={false}
                    autoComplete="off"
                    className="w-full rounded-lg border border-line-strong bg-white px-4 py-3 text-[15px] leading-relaxed focus:outline-none focus:ring-2 focus:ring-brand-400 select-text"
                    placeholder="Type your answer here"
                  />
                )}
                {q.type !== "mcq" && <div className="t-sub mt-1.5 text-right">{(answers[q.id] ?? "").trim().split(/\s+/).filter(Boolean).length} words</div>}
              </div>
              <div className="flex items-center justify-between mt-8">
                <button type="button" className="btn-ghost" disabled={idx === 0} onClick={() => setIdx(idx - 1)}>← Previous</button>
                {idx < qs.length - 1 ? <button type="button" className="btn" onClick={() => setIdx(idx + 1)}>Next →</button> : <button type="button" className="btn" onClick={() => setConfirmSubmit(true)}>Finish and submit</button>}
              </div>
            </div>
          )}
        </main>
      </div>

      {/* hidden media */}
      <video ref={videoRef} playsInline muted className="hidden" /><video ref={screenVideoRef} playsInline muted className="hidden" />

      {/* message from the invigilator */}
      {note && !room.locked && (
        <div className="fixed top-16 left-1/2 -translate-x-1/2 z-40 w-[min(560px,92vw)] rounded-xl border-2 border-blue-300 bg-blue-50 shadow-card p-4 flex items-start gap-3">
          <div className="h-9 w-9 rounded-full bg-[#2E86AB] text-white grid place-items-center font-black shrink-0">i</div>
          <div className="flex-1 text-[14px]">
            <div className="font-display font-bold text-blue-900">Message from your invigilator</div>
            <p className="text-blue-900/90 mt-0.5 whitespace-pre-wrap">{note.text}</p>
          </div>
          <button type="button" className="btn btn-sm" onClick={dismissNote}>OK</button>
        </div>
      )}

      {/* lock overlay */}
      {room.locked && (
        <div className="fixed inset-0 z-50 bg-[#1B2A22]/95 text-white grid place-items-center p-8">
          <div className="max-w-[560px] text-center space-y-4">
            <div className="mx-auto h-14 w-14 rounded-full bg-amber-400 text-[#1B2A22] grid place-items-center text-2xl font-black">!</div>
            <h2 className="font-display text-2xl font-extrabold">Your paper is locked</h2>
            <p className="text-white/80">{room.lockReason ?? "You left the exam."} This has been recorded and your invigilator has been alerted. Your clock keeps running.</p>
            {note && (
              <div className="rounded-lg bg-white text-[#1B2A22] px-4 py-3 text-left text-[14px] flex items-start gap-3">
                <div className="h-8 w-8 rounded-full bg-[#2E86AB] text-white grid place-items-center font-black shrink-0">i</div>
                <div className="flex-1"><div className="font-bold">Message from your invigilator</div><p className="whitespace-pre-wrap">{note.text}</p></div>
                <button type="button" className="btn btn-sm" onClick={dismissNote}>OK</button>
              </div>
            )}
            {room.requiresInvigilator ? (
              <p className="rounded-lg bg-white/10 px-4 py-3 text-[14px]">You have left the exam {room.locks} times. Only your invigilator can put your paper back now — stay at your desk and wait. This screen updates by itself.</p>
            ) : (
              <>
                <p className="text-[13px] text-white/60">You may return {room.selfResumesLeft} more time{room.selfResumesLeft === 1 ? "" : "s"} yourself; after that your invigilator must release your paper.</p>
                <button type="button" className="btn text-[15px] px-6 py-2.5" onClick={resume}>Return to the exam (full screen)</button>
              </>
            )}
          </div>
        </div>
      )}

      {/* submit confirm */}
      {confirmSubmit && !room.locked && (
        <div className="fixed inset-0 z-40 bg-black/50 grid place-items-center p-8">
          <div className="max-w-[480px] w-full rounded-xl bg-surface p-6 shadow-card space-y-3">
            <h3 className="font-display text-lg font-bold">Submit your exam?</h3>
            <p className="text-[13.5px] text-ink-muted">{answered} of {qs.length} questions answered{answered < qs.length ? ` — ${qs.length - answered} still blank` : ""}. Once submitted you cannot change anything.</p>
            <div className="flex gap-2 justify-end">
              <button type="button" className="btn-ghost" onClick={() => setConfirmSubmit(false)}>Keep writing</button>
              <button type="button" className="btn" onClick={() => { setConfirmSubmit(false); submit(false); }}>Submit now</button>
            </div>
          </div>
        </div>
      )}
      {error && <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-40 rounded-lg bg-amber-50 border border-amber-200 px-4 py-2 text-sm text-amber-900">{error}</div>}
    </div>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-surface-bg px-4 py-10">
      <div className="mx-auto w-full max-w-[860px]">
        <div className="flex items-center gap-3 mb-6"><BrandMark size={40} /><div><p className="font-display font-extrabold text-lg leading-tight tracking-tight">FPT Exam</p><p className="text-[12px] text-ink-faint">Secure Exam Centre · exam room</p></div></div>
        {children}
      </div>
    </div>
  );
}
