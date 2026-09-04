import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../../lib/api";
import type { Qualification, AssessmentInstrument, ExamSitting, PublicUser } from "@shared/types";

interface Stat {
  label: string;
  value: number;
  to: string;
  linkLabel: string;
}

export default function AdminOverview() {
  const [stats, setStats] = useState<Stat[] | null>(null);

  useEffect(() => {
    (async () => {
      const [q, i, s, u] = await Promise.all([
        api.get<Qualification[]>("/qualifications"),
        api.get<AssessmentInstrument[]>("/instruments"),
        api.get<ExamSitting[]>("/sittings"),
        api.get<PublicUser[]>("/users"),
      ]);
      setStats([
        { label: "Qualifications", value: q.length, to: "/admin/qualifications", linkLabel: "Manage qualifications" },
        { label: "Assessment instruments", value: i.length, to: "/admin/instruments", linkLabel: "Manage instruments" },
        { label: "Exam sittings", value: s.length, to: "/admin/sittings", linkLabel: "Manage sittings" },
        { label: "Registered users", value: u.length, to: "/admin/users", linkLabel: "Manage users" },
      ]);
    })();
  }, []);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-brand-700">Overview</h1>
        <p className="text-sm text-gray-500 mt-1">A quick look at what's set up so far.</p>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {(stats ?? Array.from({ length: 4 })).map((stat, idx) => (
          <div key={idx} className="bg-white rounded-lg shadow p-5">
            {stat ? (
              <>
                <p className="text-3xl font-semibold text-brand-700">{(stat as Stat).value}</p>
                <p className="text-sm text-gray-500 mt-1">{(stat as Stat).label}</p>
                <Link
                  to={(stat as Stat).to}
                  className="inline-block mt-3 text-xs text-brand-600 underline"
                >
                  {(stat as Stat).linkLabel}
                </Link>
              </>
            ) : (
              <div className="h-16 animate-pulse bg-gray-100 rounded" />
            )}
          </div>
        ))}
      </div>

      <section className="bg-white rounded-lg shadow p-6">
        <h2 className="text-lg font-medium mb-3">Typical order of operations</h2>
        <ol className="text-sm text-gray-600 space-y-1.5 list-decimal list-inside">
          <li>Add a qualification (and its SAQA ID, if you have one)</li>
          <li>Create its assessment instrument — manually, or let the AI draft it</li>
          <li>Register the Assessor, Invigilator(s) and Learners involved</li>
          <li>Create the exam sitting and assign learners to it</li>
        </ol>
      </section>
    </div>
  );
}
