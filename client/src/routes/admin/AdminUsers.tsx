import { useEffect, useState } from "react";
import { api } from "../../lib/api";
import type { PublicUser, UserRole, EmploymentRelationship } from "@shared/types";
import { PageHeader, Card, CardHead, Notice, Badge, Empty, PlusIcon } from "../../components/ui";
import MfaSetupPanel from "../../components/MfaSetupPanel";
import type { BadgeTone } from "../../components/ui";

// What the Administrator is registering. Students, assessors and invigilators
// live in their own sections of FPTStaff, so the type both picks which FPTStaff
// section to search and pre-fills the role. Administrators are internal FPT
// Exam accounts created here directly.
type PersonType = "student" | "assessor" | "invigilator" | "administrator";

const PERSON_TYPES: { key: PersonType; label: string; role: UserRole; fromFptstaff: boolean }[] = [
  { key: "student", label: "Student", role: "learner", fromFptstaff: true },
  { key: "assessor", label: "Assessor", role: "assessor", fromFptstaff: true },
  { key: "invigilator", label: "Invigilator", role: "invigilator", fromFptstaff: true },
  { key: "administrator", label: "Administrator", role: "administrator", fromFptstaff: false },
];

// The four roles FPT Exam has. Moderation and QA live in FPTStaff.
const ROLE_OPTIONS: { value: UserRole; label: string }[] = [
  { value: "learner", label: "Learner" },
  { value: "assessor", label: "Assessor" },
  { value: "invigilator", label: "Invigilator" },
  { value: "administrator", label: "Administrator" },
];

const ROLE_TONE: Record<string, BadgeTone> = {
  administrator: "green",
  assessor: "blue",
  invigilator: "amber",
  learner: "gray",
};

// FPTStaff is not connected yet (see the project's moderation-signoff-policy.md).
// When it is, this flips and the search box below becomes live.
const FPTSTAFF_CONNECTED = false;

export default function AdminUsers() {
  const [users, setUsers] = useState<PublicUser[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  // Authenticator setup to show after creating (or resetting) a supervisory account.
  const [mfaSetup, setMfaSetup] = useState<{ name: string; email: string; otpAuthUrl: string } | null>(null);
  const [showCreate, setShowCreate] = useState(false);

  const [type, setType] = useState<PersonType>("student");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [roles, setRoles] = useState<UserRole[]>(["learner"]);
  const [employment, setEmployment] = useState<EmploymentRelationship | "">("");

  async function loadUsers() {
    setUsers(await api.get<PublicUser[]>("/users"));
  }

  useEffect(() => {
    loadUsers();
  }, []);

  function chooseType(t: PersonType) {
    setType(t);
    // The type pre-fills the role; the admin can still adjust it below.
    setRoles([PERSON_TYPES.find((p) => p.key === t)!.role]);
    if (t !== "invigilator" && t !== "assessor") setEmployment("");
  }

  function toggleRole(role: UserRole) {
    setRoles((prev) => (prev.includes(role) ? prev.filter((r) => r !== role) : [...prev, role]));
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setMessage(null);
    try {
      const created = await api.post<{ mfaOtpAuthUrl: string | null }>("/users", {
        name,
        email,
        password,
        roles,
        employmentRelationship: employment || undefined,
        source: "manual",
      });
      setMessage(`${name} registered.`);
      if (created.mfaOtpAuthUrl) setMfaSetup({ name, email, otpAuthUrl: created.mfaOtpAuthUrl });
      setName("");
      setEmail("");
      setPassword("");
      chooseType(type);
      setShowCreate(false);
      await loadUsers();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function resetMfa(u: PublicUser) {
    if (!window.confirm(`Issue a new authenticator setup for ${u.name}? Their current authenticator entry will stop working.`)) return;
    setError(null);
    try {
      const r = await api.post<{ mfaOtpAuthUrl: string }>(`/users/${u.id}/mfa/reset`);
      setMfaSetup({ name: u.name, email: u.email, otpAuthUrl: r.mfaOtpAuthUrl });
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (err) {
      setError((err as Error).message);
    }
  }

  const current = PERSON_TYPES.find((p) => p.key === type)!;

  return (
    <>
      <PageHeader
        title="Users"
        subtitle="Every account on the exam centre. Students, assessors and invigilators are pulled through from FPTStaff once it's connected."
        action={
          <button className="btn whitespace-nowrap" onClick={() => setShowCreate((v) => !v)}>
            {showCreate ? "Close" : <><PlusIcon /> Register a user</>}
          </button>
        }
      />

      {error && <Notice kind="error">{error}</Notice>}
      {message && <Notice kind="success">{message}</Notice>}
      {mfaSetup && (
        <MfaSetupPanel name={mfaSetup.name} email={mfaSetup.email} otpAuthUrl={mfaSetup.otpAuthUrl} onClose={() => setMfaSetup(null)} />
      )}

      {showCreate && (
        <Card className="mb-5">
          <CardHead title="Register a user" />
          <form onSubmit={handleCreate} className="px-5 pt-4 pb-5 space-y-5">
            {/* Step 1 - what are you registering? */}
            <div>
              <label className="field-lbl">What are you registering?</label>
              <div className="inline-flex rounded-lg border border-line-strong p-0.5 bg-surface-2">
                {PERSON_TYPES.map((p) => (
                  <button
                    key={p.key}
                    type="button"
                    onClick={() => chooseType(p.key)}
                    className={
                      "px-3.5 py-1.5 rounded-md font-display text-[13px] font-semibold transition " +
                      (type === p.key ? "bg-surface text-brand-700 shadow-card" : "text-ink-muted hover:text-ink")
                    }
                  >
                    {p.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Step 2 - find them in FPTStaff (live once connected) */}
            {current.fromFptstaff && (
              <div>
                <label className="field-lbl">
                  Find in FPTStaff <span className="normal-case font-normal text-ink-faint">— {current.label.toLowerCase()}s section</span>
                </label>
                <div className="relative">
                  <input
                    className="inp pl-9 disabled:bg-surface-2 disabled:text-ink-faint disabled:cursor-not-allowed"
                    placeholder={FPTSTAFF_CONNECTED ? `Search ${current.label.toLowerCase()}s by name or ID number…` : "Connects once FPTStaff is linked"}
                    disabled={!FPTSTAFF_CONNECTED}
                  />
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-ink-faint">
                    <circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" />
                  </svg>
                </div>
                {!FPTSTAFF_CONNECTED && (
                  <p className="text-xs text-ink-faint mt-1.5">
                    Until FPTStaff is connected, add their details below. Anyone added here is pushed across to FPTStaff automatically once the link is live.
                  </p>
                )}
              </div>
            )}

            {/* Add new / manual details */}
            <div className="rounded-lg border border-line bg-surface-2/60 p-4 space-y-3.5">
              <p className="text-[13px] font-semibold text-ink">
                {current.fromFptstaff ? "Not in FPTStaff yet? Add their details" : "Account details"}
              </p>
              <div className="grid grid-cols-2 gap-3.5">
                <div><label className="field-lbl">Full name</label><input className="inp" value={name} onChange={(e) => setName(e.target.value)} required /></div>
                <div><label className="field-lbl">Email</label><input className="inp" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required placeholder="name@fptacademy.co.za" /></div>
                <div>
                  <label className="field-lbl">Temporary password <span className="normal-case font-normal text-ink-faint">(min 10 characters)</span></label>
                  <input className="inp" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={10} />
                </div>
                {(type === "invigilator" || type === "assessor") && (
                  <div>
                    <label className="field-lbl">Employment</label>
                    <select className="inp" value={employment} onChange={(e) => setEmployment(e.target.value as EmploymentRelationship | "")}>
                      <option value="">Not specified</option>
                      <option value="internal">Internal — FPT staff</option>
                      <option value="external">External — independent</option>
                    </select>
                    {type === "invigilator" && (
                      <p className="text-xs text-ink-faint mt-1.5">Only external invigilators can be assigned to sittings that require independent invigilation.</p>
                    )}
                  </div>
                )}
              </div>
            </div>

            {/* Roles - pre-filled from the type, still adjustable */}
            <div>
              <label className="field-lbl">Roles <span className="normal-case font-normal text-ink-faint">— pre-filled from the type above; adjust if needed</span></label>
              <div className="flex flex-wrap gap-2">
                {ROLE_OPTIONS.map((r) => {
                  const on = roles.includes(r.value);
                  return (
                    <label
                      key={r.value}
                      className={"inline-flex items-center gap-2 rounded-lg border px-3 py-1.5 text-[13.5px] cursor-pointer transition " + (on ? "border-brand-600 bg-brand-50 text-brand-800" : "border-line-strong text-ink-muted hover:bg-surface-2")}
                    >
                      <input type="checkbox" className="accent-brand-600" checked={on} onChange={() => toggleRole(r.value)} />
                      {r.label}
                    </label>
                  );
                })}
              </div>
            </div>

            <button className="btn" disabled={roles.length === 0}>Register {current.label.toLowerCase()}</button>
          </form>
        </Card>
      )}

      <Card>
        <CardHead title="All users" subtitle={`${users.length} registered`} />
        <div className="px-2 pb-2">
          {users.length ? (
            <table className="data">
              <thead>
                <tr><th>Name</th><th>Email</th><th>Roles</th><th>Source</th><th className="text-right">Sign-in</th></tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.id}>
                    <td className="font-semibold">{u.name}</td>
                    <td className="text-ink-muted">{u.email}</td>
                    <td>
                      <span className="flex flex-wrap gap-1.5">
                        {u.roles.map((r) => (
                          <Badge key={r} tone={ROLE_TONE[r] ?? "gray"}>
                            {ROLE_OPTIONS.find((o) => o.value === r)?.label ?? r}
                            {r === "invigilator" && u.employmentRelationship === "external" && " · External"}
                          </Badge>
                        ))}
                      </span>
                    </td>
                    <td>
                      {u.source === "fptstaff" ? <Badge tone="blue">FPTStaff</Badge> : <Badge tone="gray">Added here</Badge>}
                    </td>
                    <td className="text-right">
                      {u.roles.length === 1 && u.roles[0] === "learner" ? (
                        <span className="t-sub">Password</span>
                      ) : (
                        <button type="button" className="lnk" onClick={() => resetMfa(u)}>
                          Authenticator setup
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <Empty>No users yet.</Empty>
          )}
        </div>
      </Card>
    </>
  );
}
