import { Routes, Route, NavLink } from "react-router-dom";
import { useAuth } from "../../lib/auth";
import AdminOverview from "./AdminOverview";
import AdminQualifications from "./AdminQualifications";
import AdminInstruments from "./AdminInstruments";
import AdminSittings from "./AdminSittings";
import AdminUsers from "./AdminUsers";

const NAV_ITEMS = [
  { to: "/admin", end: true, label: "Overview" },
  { to: "/admin/qualifications", end: false, label: "Qualifications" },
  { to: "/admin/instruments", end: false, label: "Instruments" },
  { to: "/admin/sittings", end: false, label: "Sittings" },
  { to: "/admin/users", end: false, label: "Users" },
];

export default function AdminDashboard() {
  const { user, logout } = useAuth();

  return (
    <div className="min-h-screen flex bg-gray-50">
      <aside className="w-56 shrink-0 bg-white border-r border-gray-200 flex flex-col">
        <div className="px-5 py-6 border-b border-gray-100">
          <p className="text-lg font-semibold text-brand-700">FPT Exam</p>
          <p className="text-xs text-gray-400 mt-0.5">Administrator</p>
        </div>
        <nav className="flex-1 px-3 py-4 space-y-1">
          {NAV_ITEMS.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) =>
                "block rounded px-3 py-2 text-sm font-medium " +
                (isActive
                  ? "bg-brand-50 text-brand-700"
                  : "text-gray-600 hover:bg-gray-50 hover:text-gray-900")
              }
            >
              {item.label}
            </NavLink>
          ))}
        </nav>
        <div className="px-5 py-4 border-t border-gray-100">
          {user && <p className="text-xs text-gray-400 truncate mb-2">{user.email}</p>}
          <button onClick={() => logout()} className="text-xs text-gray-500 hover:text-gray-800 underline">
            Sign out
          </button>
        </div>
      </aside>

      <main className="flex-1 min-w-0 p-8">
        <div className="max-w-5xl mx-auto">
          <Routes>
            <Route index element={<AdminOverview />} />
            <Route path="qualifications" element={<AdminQualifications />} />
            <Route path="instruments" element={<AdminInstruments />} />
            <Route path="sittings" element={<AdminSittings />} />
            <Route path="users" element={<AdminUsers />} />
          </Routes>
        </div>
      </main>
    </div>
  );
}
