import { useAuth } from "../../lib/auth";

// Invigilator's real screens arrive in Phase D. Until then this page keeps the
// login → role → routing loop honest and tells the person what's coming.
export default function InvigilatorDashboard() {
  const { user, logout } = useAuth();
  return (
    <div className="min-h-screen bg-surface-bg flex items-center justify-center px-4">
      <div className="card p-8 max-w-md w-full text-center">
        <div
          className="mx-auto h-11 w-11 rounded-[11px] grid place-items-center text-white font-display font-extrabold text-lg shadow-btn mb-4"
          style={{ background: "linear-gradient(145deg, #6BBF3E 0%, #4C9127 100%)" }}
        >
          F
        </div>
        <h1 className="text-xl font-bold tracking-tight">Invigilator workspace</h1>
        <p className="text-sm text-ink-muted mt-2">
          The live invigilation console — video wall, flag feed, and incident log — arrives with the proctoring phase. Your login is set up and ready for when it lands.
        </p>
        {user && <p className="text-xs text-ink-faint mt-5">Signed in as {user.email}</p>}
        <button onClick={() => logout()} className="mt-3 text-xs text-ink-muted underline underline-offset-2 hover:text-ink">
          Sign out
        </button>
      </div>
    </div>
  );
}
