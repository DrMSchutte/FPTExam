import { useEffect, useState } from "react";
import { api } from "../../lib/api";
import type { Qualification, AssessmentInstrument } from "@shared/types";
import { PageHeader, Card, CardHead, Notice, Pill, Empty, PlusIcon } from "../../components/ui";

export default function AdminQualifications() {
  const [qualifications, setQualifications] = useState<Qualification[]>([]);
  const [instruments, setInstruments] = useState<AssessmentInstrument[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);

  async function load() {
    const [q, i] = await Promise.all([
      api.get<Qualification[]>("/qualifications"),
      api.get<AssessmentInstrument[]>("/instruments"),
    ]);
    setQualifications(q);
    setInstruments(i);
  }

  useEffect(() => {
    load();
  }, []);

  const [qTitle, setQTitle] = useState("");
  const [qType, setQType] = useState<"fisa" | "eisa">("eisa");
  const [qSaqaId, setQSaqaId] = useState("");
  const [qNqf, setQNqf] = useState("");

  async function createQualification(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setMessage(null);
    try {
      await api.post("/qualifications", {
        title: qTitle,
        qctoRegistrationType: qType,
        saqaQualificationId: qSaqaId || undefined,
        nqfLevel: qNqf ? Number(qNqf) : undefined,
      });
      setQTitle("");
      setQSaqaId("");
      setQNqf("");
      setMessage("Qualification added.");
      setShowCreate(false);
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function setNqf(qualificationId: string, value: string) {
    setError(null);
    try {
      await api.patch(`/qualifications/${qualificationId}`, { nqfLevel: value ? Number(value) : null });
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  const [saqaEditId, setSaqaEditId] = useState<string | null>(null);
  const [saqaEditValue, setSaqaEditValue] = useState("");

  async function saveSaqaId(qualificationId: string) {
    setError(null);
    setMessage(null);
    try {
      await api.patch(`/qualifications/${qualificationId}`, { saqaQualificationId: saqaEditValue });
      setSaqaEditId(null);
      setMessage("SAQA ID saved.");
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  const instrumentCount = (qid: string) => instruments.filter((i) => i.qualificationId === qid).length;

  return (
    <>
      <PageHeader
        title="Qualifications"
        subtitle="The registered programmes you run exams for. Set a SAQA ID to unlock AI drafting from the SAQA record."
        action={
          <button className="btn whitespace-nowrap" onClick={() => setShowCreate((v) => !v)}>
            {showCreate ? "Close" : <><PlusIcon /> Add qualification</>}
          </button>
        }
      />

      {error && <Notice kind="error">{error}</Notice>}
      {message && <Notice kind="success">{message}</Notice>}

      {showCreate && (
        <Card className="mb-5">
          <CardHead title="Add a qualification" subtitle="The SAQA ID is the id= value from the qualification's page on allqs.saqa.org.za" />
          <form onSubmit={createQualification} className="grid grid-cols-[2fr_1fr_1fr_1fr_auto] gap-3.5 items-end px-5 pt-4 pb-5">
            <div>
              <label className="field-lbl">Title</label>
              <input className="inp" value={qTitle} onChange={(e) => setQTitle(e.target.value)} required placeholder="e.g. Occupational Certificate: Electrician" />
            </div>
            <div>
              <label className="field-lbl">QCTO type</label>
              <select className="inp" value={qType} onChange={(e) => setQType(e.target.value as "fisa" | "eisa")}>
                <option value="eisa">EISA</option>
                <option value="fisa">FISA (legacy)</option>
              </select>
            </div>
            <div>
              <label className="field-lbl">SAQA ID <span className="normal-case font-normal text-ink-faint">(optional)</span></label>
              <input className="inp" value={qSaqaId} onChange={(e) => setQSaqaId(e.target.value)} placeholder="e.g. 91234" />
            </div>
            <div>
              <label className="field-lbl">NQF level <span className="normal-case font-normal text-ink-faint">(optional)</span></label>
              <select className="inp" value={qNqf} onChange={(e) => setQNqf(e.target.value)}>
                <option value="">Not set</option>
                {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => (
                  <option key={n} value={n}>{n}</option>
                ))}
              </select>
            </div>
            <button className="btn">Add</button>
          </form>
        </Card>
      )}

      <Card>
        <CardHead title="All qualifications" />
        <div className="px-2 pb-2">
          {qualifications.length ? (
            <table className="data">
              <thead>
                <tr><th>Qualification</th><th>Type</th><th>SAQA ID</th><th>NQF</th><th>Instruments</th></tr>
              </thead>
              <tbody>
                {qualifications.map((q) => (
                  <tr key={q.id}>
                    <td className="font-semibold">{q.title}</td>
                    <td><Pill tone={q.qctoRegistrationType}>{q.qctoRegistrationType.toUpperCase()}</Pill></td>
                    <td>
                      {saqaEditId === q.id ? (
                        <span className="flex items-center gap-2">
                          <input
                            autoFocus
                            className="inp !w-28 !py-1 text-xs"
                            value={saqaEditValue}
                            onChange={(e) => setSaqaEditValue(e.target.value)}
                            placeholder="SAQA ID"
                          />
                          <button onClick={() => saveSaqaId(q.id)} className="lnk">Save</button>
                          <button onClick={() => setSaqaEditId(null)} className="text-xs text-ink-faint">Cancel</button>
                        </span>
                      ) : q.saqaQualificationId ? (
                        <span className="tabular">{q.saqaQualificationId}</span>
                      ) : (
                        <button
                          onClick={() => { setSaqaEditId(q.id); setSaqaEditValue(""); }}
                          className="lnk"
                        >
                          Set SAQA ID
                        </button>
                      )}
                    </td>
                    <td>
                      <select
                        className="inp !w-20 !py-1 text-xs"
                        value={q.nqfLevel ?? ""}
                        onChange={(e) => setNqf(q.id, e.target.value)}
                        title="NQF level - sets the expected cognitive demand in the assessment-standard check. Filled automatically from SAQA when a paper is drafted from it."
                      >
                        <option value="">—</option>
                        {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => (
                          <option key={n} value={n}>{n}</option>
                        ))}
                      </select>
                    </td>
                    <td>{instrumentCount(q.id)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <Empty>No qualifications yet — add the first one above.</Empty>
          )}
        </div>
      </Card>
    </>
  );
}
