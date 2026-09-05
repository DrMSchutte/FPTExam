import { Routes, Route } from "react-router-dom";
import Shell, { NAV_ICONS } from "../../components/Shell";
import AdminOverview from "./AdminOverview";
import AdminQualifications from "./AdminQualifications";
import AdminInstruments from "./AdminInstruments";
import AdminSittings from "./AdminSittings";
import AdminUsers from "./AdminUsers";

const NAV_ITEMS = [
  { to: "/admin", end: true, label: "Overview", icon: NAV_ICONS.overview },
  { to: "/admin/qualifications", end: false, label: "Qualifications", icon: NAV_ICONS.quals },
  { to: "/admin/instruments", end: false, label: "Instruments", icon: NAV_ICONS.instr },
  { to: "/admin/sittings", end: false, label: "Sittings", icon: NAV_ICONS.sittings },
  { to: "/admin/users", end: false, label: "Users", icon: NAV_ICONS.users },
];

export default function AdminDashboard() {
  return (
    <Shell navItems={NAV_ITEMS} roleLabel="Secure Exam Centre">
      <Routes>
        <Route index element={<AdminOverview />} />
        <Route path="qualifications" element={<AdminQualifications />} />
        <Route path="instruments" element={<AdminInstruments />} />
        <Route path="sittings" element={<AdminSittings />} />
        <Route path="users" element={<AdminUsers />} />
      </Routes>
    </Shell>
  );
}
