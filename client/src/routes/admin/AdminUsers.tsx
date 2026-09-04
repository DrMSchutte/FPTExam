import { useEffect, useState } from "react";
import { api } from "../../lib/api";
import type { PublicUser, UserRole } from "@shared/types";

const ROLE_OPTIONS: UserRole[] = [
  "administrator",
  "learner",
  "invigilator",
  "assessor",
  "moderator",
  "head_qa",
];

export default function AdminUsers() {
  const [users, setUsers] = useState<PublicUser[]>([]);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [roles, setRoles] = useState<UserRole[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);

  async function loadUsers() {
    setUsers(await api.get<PublicUser[]>("/users"));
  }

  useEffect(() => {
    loadUsers();
  }, []);

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
      });
      setMessage(
        created.mfaOtpAuthUrl
          ? "User created. Send them the MFA enrolment link (shown once, here) to scan into an authenticator app."
          : "User created."
      );
      setName("");
      setEmail("");
      setPassword("");
      setRoles([]);
      setShowCreate(false);
      await loadUsers();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-xl font-semibold text-brand-700">Users</h1>
          <p className="text-sm text-gray-500 mt-1">
            Every account other than Learner sign-up is created here — Invigilator, Assessor, Moderator and
            Head QA accounts all start as a registration, same as this.
          </p>
        </div>
        <button
          onClick={() => setShowCreate((v) => !v)}
          className="rounded bg-brand-600 text-white px-4 py-2 text-sm font-medium hover:bg-brand-700 whitespace-nowrap"
        >
          {showCreate ? "Close" : "+ Register a user"}
        </button>
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}
      {message && <p className="text-sm text-green-700">{message}</p>}

      {showCreate && (
        <section className="bg-white rounded-lg shadow p-6">
          <h2 className="text-lg font-medium mb-4">Register a user</h2>
          <form onSubmit={handleCreate} className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <input
                placeholder="Full name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                className="rounded border border-gray-300 px-3 py-2 text-sm"
              />
              <input
                placeholder="Email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                className="rounded border border-gray-300 px-3 py-2 text-sm"
              />
            </div>
            <input
              placeholder="Temporary password (min 10 chars)"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              className="w-full rounded border border-gray-300 px-3 py-2 text-sm"
            />
            <div className="flex flex-wrap gap-3">
              {ROLE_OPTIONS.map((role) => (
                <label key={role} className="flex items-center gap-1.5 text-sm">
                  <input type="checkbox" checked={roles.includes(role)} onChange={() => toggleRole(role)} />
                  {role}
                </label>
              ))}
            </div>
            <button className="rounded bg-brand-600 text-white px-4 py-2 text-sm font-medium hover:bg-brand-700">
              Create user
            </button>
          </form>
        </section>
      )}

      <section className="bg-white rounded-lg shadow p-6">
        <h2 className="text-lg font-medium mb-4">All users</h2>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-gray-500 border-b border-gray-100">
              <th className="py-2 font-medium">Name</th>
              <th className="font-medium">Email</th>
              <th className="font-medium">Roles</th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id} className="border-b border-gray-50 last:border-0">
                <td className="py-2.5">{u.name}</td>
                <td>{u.email}</td>
                <td>{u.roles.join(", ")}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {users.length === 0 && <p className="text-gray-400 text-sm mt-2">None yet.</p>}
      </section>
    </div>
  );
}
