import { Routes, Route } from "react-router-dom";
import Shell, { NAV_ICONS } from "../../components/Shell";
import MySittings from "./MySittings";
import LiveConsole from "./LiveConsole";

// Block 5c: the invigilator's workspace - the sittings they are on, and the
// live console for each.
export default function InvigilatorDashboard() {
  const NAV_ITEMS = [{ to: "/invigilator", end: true, label: "My sittings", icon: NAV_ICONS.sittings }];
  return (
    <Shell navItems={NAV_ITEMS} roleLabel="Invigilator workspace" wide>
      <Routes>
        <Route index element={<MySittings consolePath={(id) => `/invigilator/sittings/${id}`} />} />
        <Route path="sittings/:id" element={<LiveConsole backTo="/invigilator" />} />
      </Routes>
    </Shell>
  );
}
