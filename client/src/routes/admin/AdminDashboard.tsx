import { Routes, Route, NavLink } from "react-router-dom";
import { useAuth } from "../../lib/auth";
import AdminOverview from "./AdminOverview";
import AdminQualifications from "./AdminQualifications";
import AdminInstruments from "./AdminInstruments";
import AdminSittings from "./AdminSittings";
import AdminUsers from "./AdminUsers";

const ICONS = {
  overview: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="7" height="9" /><rect x="14" y="3" width="7" height="5" />
      <rect x="14" y="12" width="7" height="9" /><rect x="3" y="16" width="7" height="5" />
    </svg>
  ),
  quals: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M22 10v6M2 10l10-5 10 5-10 5z" /><path d="M6 12v5c3 3 9 3 12 0v-5" />
    </svg>
  ),
  instr: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <path d="M14 2v6h6M16 13H8M16 17H8M10 9H8" />
    </svg>
  ),
  sittings: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="4" width="18" height="18" rx="2" /><path d="M16 2v4M8 2v4M3 10h18" />
    </svg>
  ),
  users: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" />
      <path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  ),
};

const NAV_ITEMS = [
  { to: "/admin", end: true, label: "Overview", icon: ICONS.overview },
  { to: "/admin/qualifications", end: false, label: "Qualifications", icon: ICONS.quals },
  { to: "/admin/instruments", end: false, label: "Instruments", icon: ICONS.instr },
  { to: "/admin/sittings", end: false, label: "Sittings", icon: ICONS.sittings },
  { to: "/admin/users", end: false, label: "Users", icon: ICONS.users },
];

export default function AdminDashboard() {
  const { user, logout } = useAuth();

  return (
    <div className="min-h-screen flex bg-surface-bg">
      <aside className="w-[244px] shrink-0 bg-surface border-r border-line flex flex-col sticky top-0 h-screen">
        <div className="flex items-center gap-3 px-5 pt-5 pb-[18px] border-b border-line">
          <div
            className="h-[34px] w-[34px] shrink-0 rounded-[9px] grid place-items-center text-white font-display font-extrabold text-base shadow-btn"
            style={{ background: "linear-gradient(145deg, #6BBF3E 0%, #4C9127 100%)" }}
          >
            F
          </div>
          <div>
            <p className="font-display font-extrabold text-base leading-tight tracking-tight">FPT Exam</p>
            <p className="text-[11.5px] text-ink-faint mt-px">Secure Exam Centre</p>
          </div>
        </div>

        <nav className="flex-1 px-3 py-3 flex flex-col gap-0.5">
          {NAV_ITEMS.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) =>
                "flex items-center gap-[11px] rounded-lg px-3 py-[9px] text-sm transition " +
                (isActive
                  ? "bg-brand-50 text-brand-700 font-semibold"
                  : "text-ink-muted font-medium hover:bg-surface-2 hover:text-ink")
              }
            >
              <span className="h-[17px] w-[17px] shrink-0 [&>svg]:h-full [&>svg]:w-full">{item.icon}</span>
              {item.label}
            </NavLink>
          ))}
        </nav>

        <div className="px-4 py-4 border-t border-line">
          {user && (
            <>
              <p className="text-[13px] font-semibold truncate">{user.name}</p>
              <p className="text-[11.5px] text-ink-faint truncate">{user.email}</p>
            </>
          )}
          <button
            onClick={() => logout()}
            className="mt-2 text-xs text-ink-muted underline underline-offset-2 hover:text-ink"
          >
            Sign out
          </button>
        </div>
      </aside>

      <main className="flex-1 min-w-0">
        <div className="max-w-[1080px] px-[34px] py-7 pb-16">
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
