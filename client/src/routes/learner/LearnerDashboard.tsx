import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../lib/api";
import type { LearnerSittingSummary, PaperResponse, LearnerResult } from "@shared/types";
import LearnerResultView from "./LearnerResultView";

const STATUS_LABEL: Record<string, string> = {
  scheduled: "Scheduled",
  checked_in: "Checked in",
  in_progress: "In progress",
  submitted: "Submitted",
  sealed: "Submitted",
};

export default function LearnerDashboard() {
  const [sittings, setSittings] = useState<LearnerSittingSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [paper, setPaper] = useState<PaperResponse | null>(null);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [submitted, setSubmitted] = useState(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Released results, keyed by session. A result exists only once the
  // Assessor has signed off - the server answers 404 until then.
  const [results, setResults] = useState<Record<string, LearnerResult>>({});
  const [viewingResult, setViewingResult] = useState<LearnerResult | null>(null);

  const loadSittings = useCallback(async () => {
    try {
      const list = await api.get<LearnerSittingSummary[]>("/me/sittings");
      setSittings(list);
      const done = list.filter((s) => s.status === "submitted" || s.status === "sealed");
      const found: Record<string, LearnerResult> = {};
      await Promise.all(
        done.map(async (s) => {
          try {
            found[s.sessionId] = await api.get<LearnerResult>(`/sessions/${s.sessionId}/result`);
          } catch {
            /* not released yet */
          }
        })
      );
      setResults(found);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    loadSittings();
  }, [loadSittings]);

  async function openSession(sessionId: string, status: string) {
    setError(null);
    setSubmitted(false);
    try {
      if (status === "scheduled") {
        await api.post(`/sessions/${sessionId}/start`);
      }
      const fetched = await api.get<PaperResponse>(`/sessions/${sessionId}/paper`);
      setPaper(fetched);
      setAnswers(fetched.existingAnswers ?? {});
      setActiveSessionId(sessionId);
      await loadSittings();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  function updateAnswer(questionId: string, value: string) {
    setAnswers((prev) => {
      const next = { ...prev, [questionId]: value };
      return next;
    });
    setSaveState("idle");
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      void saveAnswer(questionId, value);
    }, 800);
  }

  async function saveAnswer(questionId: string, value: string) {
    if (!activeSessionId) return;
    setSaveState("saving");
    try {
      await api.post(`/sessions/${activeSessionId}/answers`, { answers: { [questionId]: value } });
      setSaveState("saved");
    } catch (err) {
      setSaveState("error");
      setError((err as Error).message);
    }
  }

  async function submitExam() {
    if (!activeSessionId) return;
    if (!window.confirm("Submit your exam now? You will not be able to change any answers afterwards.")) {
      return;
    }
    setError(null);
    try {
      // Flush any pending debounced save first so the last keystroke isn't lost.
      if (saveTimer.current) clearTimeout(saveTimer.current);
      await api.post(`/sessions/${activeSessionId}/answers`, { answers });
      await api.post(`/sessions/${activeSessionId}/submit`);
      setSubmitted(true);
      await loadSittings();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  function backToList() {
    setActiveSessionId(null);
    setPaper(null);
    setAnswers({});
    setSubmitted(false);
    loadSittings();
  }

  if (viewingResult) {
    return <LearnerResultView result={viewingResult} onBack={() => setViewingResult(null)} />;
  }

  if (activeSessionId && paper) {
    return (
      <div className="max-w-3xl mx-auto p-8 space-y-6">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-semibold text-brand-700">Exam paper</h1>
          <button onClick={backToList} className="text-xs text-ink-muted underline">
            ← Back to my sittings
          </button>
        </div>

        <div className="card p-4 text-sm text-ink-muted flex flex-wrap gap-x-6 gap-y-1">
          <span>Time allocation: {paper.timeAllocationMinutes} minutes</span>
          {paper.permittedMaterials.length > 0 && (
            <span>Permitted materials: {paper.permittedMaterials.join(", ")}</span>
          )}
        </div>

        {submitted ? (
          <section className="card p-6">
            <h2 className="text-lg font-medium text-green-700">Submitted</h2>
            <p className="text-sm text-ink-muted mt-2">
              Your exam has been submitted. Your Assessor will mark it, and your result and feedback appear
              here the moment they sign it off.
            </p>
          </section>
        ) : (
          <>
            {error && <p className="text-sm text-red-600">{error}</p>}
            <p className="text-xs text-ink-faint">
              {saveState === "saving" && "Saving..."}
              {saveState === "saved" && "All answers saved."}
              {saveState === "error" && "Could not save your last answer - check your connection."}
            </p>

            <section className="space-y-4">
              {paper.questions.map((q, idx) => (
                <div key={q.id} className="card p-6 space-y-3">
                  <div className="flex items-baseline justify-between">
                    <h3 className="font-medium">Question {idx + 1}</h3>
                    <span className="text-xs text-ink-faint">{q.maxMark} marks</span>
                  </div>
                  <p className="text-sm text-ink whitespace-pre-wrap">{q.prompt}</p>

                  {q.type === "mcq" && (
                    <div className="space-y-2">
                      {(q.options ?? []).map((opt) => (
                        <label key={opt} className="flex items-center gap-2 text-sm">
                          <input
                            type="radio"
                            name={q.id}
                            value={opt}
                            checked={answers[q.id] === opt}
                            onChange={(e) => updateAnswer(q.id, e.target.value)}
                          />
                          {opt}
                        </label>
                      ))}
                    </div>
                  )}

                  {(q.type === "short_answer" || q.type === "long_answer") && (
                    <textarea
                      value={answers[q.id] ?? ""}
                      onChange={(e) => updateAnswer(q.id, e.target.value)}
                      rows={q.type === "long_answer" ? 8 : 3}
                      className="w-full rounded border border-gray-300 px-3 py-2 text-sm"
                      placeholder="Your answer"
                    />
                  )}

                  {q.type === "practical_upload" && (
                    <div className="space-y-2">
                      <input type="file" disabled className="text-sm" />
                      <p className="text-xs text-ink-faint">
                        File upload for practical evidence isn't available in this build yet - use the notes
                        field below in the meantime.
                      </p>
                      <textarea
                        value={answers[q.id] ?? ""}
                        onChange={(e) => updateAnswer(q.id, e.target.value)}
                        rows={3}
                        className="w-full rounded border border-gray-300 px-3 py-2 text-sm"
                        placeholder="Notes for the Assessor"
                      />
                    </div>
                  )}
                </div>
              ))}
            </section>

            <button
              onClick={submitExam}
              className="rounded bg-brand-600 text-white px-6 py-2.5 text-sm font-medium hover:bg-brand-700"
            >
              Submit exam
            </button>
          </>
        )}
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto p-8 space-y-6">
      <h1 className="text-2xl font-semibold text-brand-700">Learner</h1>
      {error && <p className="text-sm text-red-600">{error}</p>}

      <section className="card p-6">
        <h2 className="text-lg font-medium mb-4">My exam sittings</h2>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-ink-muted border-b">
              <th className="py-2">Starts</th>
              <th>Ends</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {sittings.map((s) => (
              <tr key={s.sessionId} className="border-b last:border-0">
                <td className="py-2">{new Date(s.startTime).toLocaleString()}</td>
                <td>{new Date(s.endTime).toLocaleString()}</td>
                <td>{STATUS_LABEL[s.status] ?? s.status}</td>
                <td className="py-2 text-right">
                  {s.status === "submitted" || s.status === "sealed" ? (
                    results[s.sessionId] ? (
                      <button
                        onClick={() => setViewingResult(results[s.sessionId])}
                        className="rounded bg-brand-600 text-white px-3 py-1.5 text-xs font-medium hover:bg-brand-700"
                      >
                        View result
                      </button>
                    ) : (
                      <span className="text-xs text-ink-faint">Awaiting sign-off</span>
                    )
                  ) : (
                    <button
                      onClick={() => openSession(s.sessionId, s.status)}
                      className="rounded bg-brand-600 text-white px-3 py-1.5 text-xs font-medium hover:bg-brand-700"
                    >
                      {s.status === "scheduled" ? "Start exam" : "Continue"}
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {sittings.length === 0 && (
              <tr>
                <td colSpan={4} className="py-4 text-ink-faint text-center">
                  No exam sittings assigned yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>
    </div>
  );
}
