import { Routes, Route } from "react-router-dom";
import Shell, { NAV_ICONS } from "../../components/Shell";
import AssessorQueue from "./AssessorQueue";
import AssessorDossier from "./AssessorDossier";

const NAV_ITEMS = [
  { to: "/assessor", end: true, label: "Marking queue", icon: NAV_ICONS.queue },
  { to: "/assessor/signed-off", end: false, label: "Signed off", icon: NAV_ICONS.signed },
];

export default function AssessorDashboard() {
  return (
    <Shell navItems={NAV_ITEMS} roleLabel="Assessor workspace" wide>
      <Routes>
        <Route index element={<AssessorQueue mode="open" />} />
        <Route path="signed-off" element={<AssessorQueue mode="signed" />} />
        <Route path="sessions/:id" element={<AssessorDossier />} />
      </Routes>
    </Shell>
  );
}
