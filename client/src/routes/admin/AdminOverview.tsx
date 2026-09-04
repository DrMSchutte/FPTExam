import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../../lib/api";
import type { Qualification, AssessmentInstrument, ExamSitting, PublicUser } from "@shared/types";
import { PageHeader, Card, CardHead, Badge, Empty } from "../../components/ui";

interface Data {
  qualifications: Qualification[];
  instruments: AssessmentInstrument[];
  sittings: ExamSitting[];
  users: PublicUser[];
}

const fmtDate = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
const fmtTime = (iso: string) =>
  new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

export default function AdminOverview() {
  const [data, setData] = useState<Data | null>(null);

  useEffect(() => {
    (async () => {
      const [qualifications, instruments, sittings, users] = await Promise.all([
        api.get<Qualification[]>("/qualifications"),
        api.get<AssessmentInstrument[]>("/instruments"),
        api.get<ExamSitting[]>("/sittings"),
        api.get<PublicUser[]>("/users"),
      ]);
      setData({ qualifications, instruments, sittings, users });
    })();
  }, []);

  const now = Date.now();
  const upcoming = (data?.sittings ?? [])
    .filter((s) => new Date(s.endTime).getTime() >= now)
    .sort((a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime())
    .slice(0, 5);

  const count = (role: string) => data?.users.filter((u) => u.roles.includes(role as never)).length ?? 0;
  const eisa = data?.qualifications.filter((q) => q.qctoRegistrationType === "eisa").length ?? 0;
  const fisa = data?.qualifications.filter((q) => q.qctoRegistrationType === "fisa").length ?? 0;
  const aiDrafted = data?.instruments.filter((i) => i.source !== "manual").length ?? 0;

  const tiles = [
    {
      label: "Qualifications",
      value: data?.qualifications.length,
      sub: `${eisa} EISA · ${fisa} FISA`,
      tone: "bg-brand-50 text-brand-700",
      icon: <path d="M22 10v6M2 10l10-5 10 5-10 5zM6 12v5c3 3 9 3 12 0v-5" />,
    },
    {
      label: "Instruments",
      value: data?.instruments.length,
      sub: `${aiDrafted} AI-drafted · ${(data?.instruments.length ?? 0) - aiDrafted} manual`,
      tone: "bg-blue-50 text-blue-700",
      icon: <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6" />,
    },
    {
      label: "Upcoming sittings",
      value: upcoming.length,
      sub: upcoming[0] ? `Next: ${fmtDate(upcoming[0].startTime)}, ${fmtTime(upcoming[0].startTime)}` : "None scheduled",
      tone: "bg-amber-50 text-amber-700",
      icon: <><rect x="3" y="4" width="18" height="18" rx="2" /><path d="M16 2v4M8 2v4M3 10h18" /></>,
    },
    {
      label: "Registered users",
      value: data?.users.length,
      sub: `${count("assessor")} assessors · ${count("learner")} learners`,
      tone: "bg-teal-50 text-teal-700",
      icon: <><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /></>,
    },
  ];

  const qualTitle = (id: string) => data?.qualifications.find((q) => q.id === id)?.title ?? "—";
  const assessorName = (id: string) => data?.users.find((u) => u.id === id)?.name ?? "—";

  return (
    <>
      <PageHeader title="Overview" subtitle="A quick look at what's set up across the exam centre." />

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        {tiles.map((t) => (
          <div key={t.label} className="card p-[18px] pb-4">
            <div className="flex items-center justify-between">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-faint">{t.label}</p>
              <span className={"h-8 w-8 rounded-lg grid place-items-center " + t.tone}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-[17px] w-[17px]">
                  {t.icon}
                </svg>
              </span>
            </div>
            <p className="font-display font-extrabold text-[30px] tracking-tight mt-3 tabular">
              {t.value ?? <span className="inline-block h-8 w-10 rounded bg-surface-2 animate-pulse" />}
            </p>
            <p className="text-[13px] text-ink-muted mt-px">{t.sub}</p>
          </div>
        ))}
      </div>

      <Card className="mb-5">
        <CardHead
          title="Upcoming sittings"
          subtitle="Scheduled exam windows, soonest first"
          right={<Link to="/admin/sittings" className="lnk">View all →</Link>}
        />
        <div className="px-2 pb-2">
          {upcoming.length ? (
            <table className="data">
              <thead>
                <tr><th>Qualification</th><th>Window</th><th>Assessor</th><th>Proctoring</th></tr>
              </thead>
              <tbody>
                {upcoming.map((s) => (
                  <tr key={s.id}>
                    <td>
                      <div className="font-semibold">{qualTitle(s.qualificationId)}</div>
                      <div className="t-sub">{data?.qualifications.find((q) => q.id === s.qualificationId)?.qctoRegistrationType.toUpperCase()}</div>
                    </td>
                    <td>
                      {fmtDate(s.startTime)}
                      <div className="t-sub">{fmtTime(s.startTime)} – {fmtTime(s.endTime)}</div>
                    </td>
                    <td>{assessorName(s.assignedAssessorId)}</td>
                    <td>
                      {s.proctoringProfile?.fullRecordingEnabled ? (
                        <Badge tone="amber">Full recording</Badge>
                      ) : (
                        <Badge tone="blue">Screen capture</Badge>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <Empty>No upcoming sittings. Create one from the Sittings page.</Empty>
          )}
        </div>
      </Card>

      <Card>
        <CardHead title="Setting up an exam" subtitle="The usual order of operations" />
        <div className="grid grid-cols-2 lg:grid-cols-4">
          {[
            ["Add a qualification", "With its SAQA ID, if you have one"],
            ["Build the instrument", "Manually, AI-drafted, or from Curricula Builder (FISA)"],
            ["Register people", "Assessor, invigilators, learners — from FPTStaff once connected"],
            ["Schedule the sitting", "Assign learners to it"],
          ].map(([t, d], i) => (
            <div key={t} className="px-[18px] py-4 border-r border-line last:border-r-0">
              <div className="h-6 w-6 rounded-[7px] bg-brand-50 text-brand-600 font-display font-extrabold text-[13px] grid place-items-center mb-2">
                {i + 1}
              </div>
              <p className="font-semibold text-[13.5px]">{t}</p>
              <p className="text-[12.5px] text-ink-muted mt-0.5">{d}</p>
            </div>
          ))}
        </div>
      </Card>
    </>
  );
}
