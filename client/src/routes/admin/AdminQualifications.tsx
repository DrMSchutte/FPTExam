import { useEffect, useState } from "react";
import { api } from "../../lib/api";
import type { Qualification } from "@shared/types";

export default function AdminQualifications() {
  const [qualifications, setQualifications] = useState<Qualification[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function load() {
    setQualifications(await api.get<Qualification[]>("/qualifications"));
  }

  useEffect(() => {
    load();
  }, []);

  const [qTitle, setQTitle] = useState("");
  const [qType, setQType] = useState<"fisa" | "eisa">("eisa");
  const [qSaqaId, setQSaqaId] = useState("");

  async function createQualification(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setMessage(null);
    try {
      await api.post("/qualifications", {
        title: qTitle,
        qctoRegistrationType: qType,
        saqaQualificationId: qSaqaId || undefined,
      });
      setQTitle("");
      setQSaqaId("");
      setMessage("Qualification created.");
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
      setMessage("SAQA qualification ID saved.");
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-brand-700">Qualifications</h1>
        <p className="text-sm text-gray-500 mt-1">
          Register the qualifications you run exams for, and set a SAQA ID where you want to use the
          "Generate from SAQA" instrument path later on the Instruments page.
        </p>
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}
      {message && <p className="text-sm text-green-700">{message}</p>}

      <section className="bg-white rounded-lg shadow p-6">
        <h2 className="text-lg font-medium mb-4">Add a qualification</h2>
        <form onSubmit={createQualification} className="flex flex-wrap gap-3 items-end">
          <div>
            <label className="block text-xs text-gray-500">Title</label>
            <input
              value={qTitle}
              onChange={(e) => setQTitle(e.target.value)}
              required
              className="rounded border border-gray-300 px-3 py-2 text-sm w-80"
            />
          </div>
          <div>
            <label className="block text-xs text-gray-500">QCTO type</label>
            <select
              value={qType}
              onChange={(e) => setQType(e.target.value as "fisa" | "eisa")}
              className="rounded border border-gray-300 px-3 py-2 text-sm"
            >
              <option value="eisa">EISA</option>
              <option value="fisa">FISA (legacy)</option>
            </select>
          </div>
          <div>
            <label className="block text-xs text-gray-500">SAQA qualification ID (optional)</label>
            <input
              value={qSaqaId}
              onChange={(e) => setQSaqaId(e.target.value)}
              placeholder="e.g. 4911"
              className="rounded border border-gray-300 px-3 py-2 text-sm w-40"
            />
          </div>
          <button className="rounded bg-brand-600 text-white px-4 py-2 text-sm font-medium hover:bg-brand-700">
            Add qualification
          </button>
        </form>
        <p className="text-xs text-gray-400 mt-3">
          The SAQA ID is the id= value from that qualification's page on allqs.saqa.org.za.
        </p>
      </section>

      <section className="bg-white rounded-lg shadow p-6">
        <h2 className="text-lg font-medium mb-4">All qualifications</h2>
        <ul className="text-sm divide-y divide-gray-100">
          {qualifications.map((q) => (
            <li key={q.id} className="py-2.5 flex items-center gap-2">
              <span className="flex-1">
                {q.title} <span className="text-gray-400">({q.qctoRegistrationType.toUpperCase()})</span>
              </span>
              {saqaEditId === q.id ? (
                <>
                  <input
                    autoFocus
                    value={saqaEditValue}
                    onChange={(e) => setSaqaEditValue(e.target.value)}
                    placeholder="SAQA ID"
                    className="rounded border border-gray-300 px-2 py-0.5 text-xs w-28"
                  />
                  <button onClick={() => saveSaqaId(q.id)} className="text-xs text-brand-600 underline">
                    Save
                  </button>
                  <button onClick={() => setSaqaEditId(null)} className="text-xs text-gray-400 underline">
                    Cancel
                  </button>
                </>
              ) : q.saqaQualificationId ? (
                <span className="text-xs text-gray-400">SAQA ID: {q.saqaQualificationId}</span>
              ) : (
                <button
                  onClick={() => {
                    setSaqaEditId(q.id);
                    setSaqaEditValue("");
                  }}
                  className="text-xs text-brand-600 underline"
                >
                  Set SAQA ID
                </button>
              )}
            </li>
          ))}
          {qualifications.length === 0 && <li className="py-2.5 text-gray-400">None yet.</li>}
        </ul>
      </section>
    </div>
  );
}
