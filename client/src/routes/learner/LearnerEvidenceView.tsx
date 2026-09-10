import { useEffect, useState } from "react";
import { api } from "../../lib/api";
import type { MyEvidence } from "@shared/types";
import { Card, CardHead } from "../../components/ui";

// Block 8c: "You may ask to see your own recordings" (consent text). Once the
// paper is submitted the learner can see exactly what the room kept of them -
// the identity photo, every camera and screen still, and the full recording
// when the sitting was recorded in full - and until when it is kept. Nothing
// here is the assessor's: no integrity findings, no marks.

const fmtDT = (iso: string | null) => (iso ? new Date(iso).toLocaleString(undefined, { day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "—");
const fmtDay = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" });
const hhmmss = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });

export default function LearnerEvidenceView({ sessionId, onBack }: { sessionId: string; onBack: () => void }) {
  const [data, setData] = useState<MyEvidence | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<"photo" | "screen" | "recording">("photo");
  const [playing, setPlaying] = useState<{ kind: "camera" | "screen"; seq: number } | null>(null);

  useEffect(() => { api.get<MyEvidence>(`/sessions/${sessionId}/evidence`).then(setData).catch((e) => setError(e.message)); }, [sessionId]);

  const camera = data?.segments.filter((s) => s.kind === "camera") ?? [];
  const screenSegs = data?.segments.filter((s) => s.kind === "screen") ?? [];
  const stills = data?.captures.filter((c) => c.kind === tab) ?? [];

  return (
    <div className="max-w-4xl mx-auto p-8 space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-brand-700">What was recorded of my sitting</h1>
        <button onClick={onBack} className="text-xs text-ink-muted underline">← Back to my sittings</button>
      </div>
      {error && <p className="text-sm text-red-600">{error}</p>}
      {!data && !error && <p className="text-sm text-ink-muted">Loading…</p>}
      {data && (
        <>
          <Card className="p-6">
            <p className="text-sm">
              You wrote from <span className="font-semibold">{fmtDT(data.startedAt)}</span> and submitted at <span className="font-semibold">{fmtDT(data.submittedAt)}</span>.
              The room kept <span className="font-semibold">{data.captures.filter((c) => c.kind === "photo").length} camera</span> and <span className="font-semibold">{data.captures.filter((c) => c.kind === "screen").length} screen</span> stills
              {data.fullRecording ? <>, and a full recording of your camera and screen ({camera.length} minutes)</> : null}.
              These are kept until <span className="font-semibold">{fmtDay(data.keptUntil)}</span> and then deleted, unless an appeal or investigation requires them to be held. They are seen only by your invigilator, your assessor and FPT Academy's quality-assurance staff.
            </p>
            {data.sealHash && <p className="t-sub mt-3 break-all">Your submission was sealed with the hash {data.sealHash}. It proves your answers and these recordings have not changed since you submitted.</p>}
          </Card>

          <Card>
            <CardHead
              title="Recordings"
              right={
                <div className="flex gap-1 text-xs">
                  <button type="button" className={"btn-ghost btn-sm " + (tab === "photo" ? "bg-brand-50 text-brand-700" : "")} onClick={() => setTab("photo")}>Camera stills</button>
                  <button type="button" className={"btn-ghost btn-sm " + (tab === "screen" ? "bg-brand-50 text-brand-700" : "")} onClick={() => setTab("screen")}>Screen stills</button>
                  {data.fullRecording && <button type="button" className={"btn-ghost btn-sm " + (tab === "recording" ? "bg-brand-50 text-brand-700" : "")} onClick={() => setTab("recording")}>Full recording</button>}
                </div>
              }
            />
            <div className="p-5">
              {tab !== "recording" && (
                <>
                  {data.identityPhotoId && tab === "photo" && (
                    <div className="flex items-center gap-4 mb-5">
                      <img src={`/api/sit/evidence/${data.identityPhotoId}`} alt="Identity photo" className="h-28 w-36 object-cover rounded-lg border border-line" />
                      <p className="text-sm text-ink-muted">Your identity photograph, taken at check-in.</p>
                    </div>
                  )}
                  {stills.length === 0 ? <p className="text-sm text-ink-faint">None kept.</p> : (
                    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
                      {stills.map((c) => (
                        <figure key={c.id}>
                          <img src={`/api/sit/evidence/${c.id}`} alt="" loading="lazy" className="w-full aspect-[4/3] object-cover rounded-lg border border-line bg-surface-2" />
                          <figcaption className="t-sub mt-1">{hhmmss(c.at)}</figcaption>
                        </figure>
                      ))}
                    </div>
                  )}
                </>
              )}
              {tab === "recording" && (
                <div className="grid md:grid-cols-2 gap-5">
                  {(["camera", "screen"] as const).map((kind) => {
                    const segs = kind === "camera" ? camera : screenSegs;
                    const cur = playing?.kind === kind ? segs.find((s) => s.seq === playing.seq) : undefined;
                    return (
                      <div key={kind}>
                        <p className="text-sm font-semibold mb-2">{kind === "camera" ? "Camera" : "Screen"} · {segs.length} minute{segs.length === 1 ? "" : "s"}</p>
                        {cur ? <video key={cur.id} src={`/api/sit/recording/${cur.id}`} controls autoPlay className="w-full rounded-lg border border-line bg-black aspect-video" /> : <div className="w-full aspect-video rounded-lg border border-line bg-surface-2 grid place-items-center text-sm text-ink-faint">Pick a minute below</div>}
                        <div className="flex flex-wrap gap-1 mt-2 max-h-40 overflow-y-auto">
                          {segs.map((s) => (
                            <button key={s.id} type="button" onClick={() => setPlaying({ kind, seq: s.seq })} className={"rounded px-2 py-1 text-[11px] border " + (cur?.id === s.id ? "bg-brand-600 text-white border-brand-600" : "border-line hover:bg-surface-2")} title={hhmmss(s.startedAt)}>
                              {hhmmss(s.startedAt).slice(0, 5)}
                            </button>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </Card>
        </>
      )}
    </div>
  );
}
