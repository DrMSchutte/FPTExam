import { Routes, Route, Navigate } from "react-router-dom";
import Shell, { NAV_ICONS } from "../../components/Shell";
import AdminOverview from "./AdminOverview";
import AdminAssessments from "./AdminAssessments";
import AdminInstrumentDetail from "./AdminInstrumentDetail";
import AdminSittings from "./AdminSittings";
import AdminUsers from "./AdminUsers";
import AdminResults from "./AdminResults";

// Administrator structure per docs/restructure-2026-09-05.md §2: the three
// steps of organising an exam, plus the results that come out of it.
const NAV_ITEMS = [
  { to: "/admin", end: true, label: "Overview", icon: NAV_ICONS.overview },
  { to: "/admin/assessments", end: false, label: "Set up an Assessment", icon: NAV_ICONS.instr },
  { to: "/admin/people", end: false, label: "Register People", icon: NAV_ICONS.users },
  { to: "/admin/sittings", end: false, label: "Schedule the Sitting", icon: NAV_ICONS.sittings },
  { to: "/admin/results", end: false, label: "Results", icon: NAV_ICONS.signed },
];

export default function AdminDashboard() {
  return (
    <Shell navItems={NAV_ITEMS} roleLabel="Secure Exam Centre">
      <Routes>
        <Route index element={<AdminOverview />} />
        <Route path="assessments" element={<AdminAssessments />} />
        <Route path="assessments/:id" element={<AdminInstrumentDetail />} />
        <Route path="people" element={<AdminUsers />} />
        <Route path="sittings" element={<AdminSittings />} />
        <Route path="results" element={<AdminResults />} />
        {/* Old addresses still work. */}
        <Route path="qualifications" element={<Navigate to="/admin/assessments" replace />} />
        <Route path="instruments" element={<Navigate to="/admin/assessments" replace />} />
        <Route path="instruments/:id" element={<RedirectInstrument />} />
        <Route path="users" element={<Navigate to="/admin/people" replace />} />
      </Routes>
    </Shell>
  );
}

function RedirectInstrument() {
  const id = window.location.pathname.split("/").pop();
  return <Navigate to={`/admin/assessments/${id}`} replace />;
}
