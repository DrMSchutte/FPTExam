import { useEffect, useState } from "react";
import { Routes, Route } from "react-router-dom";
import Shell, { NAV_ICONS } from "../../components/Shell";
import { api } from "../../lib/api";
import type { AssessorQueueItem } from "@shared/types";
import AssessorQueue from "./AssessorQueue";
import AssessorDossier from "./AssessorDossier";

export default function AssessorDashboard() {
  // Scripts waiting for this assessor, shown as a badge on the queue item and
  // refreshed every minute - until email notifications land (Phase D) this is
  // how an assessor knows there is work.
  const [waiting, setWaiting] = useState(0);
  useEffect(() => {
    const load = () =>
      api
        .get<AssessorQueueItem[]>("/assessor/queue")
        .then((q) => setWaiting(q.filter((i) => i.decisionState !== "signed_off").length))
        .catch(() => undefined);
    load();
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, []);

  const NAV_ITEMS = [
    { to: "/assessor", end: true, label: "Marking queue", icon: NAV_ICONS.queue, badge: waiting },
    { to: "/assessor/signed-off", end: false, label: "Signed off", icon: NAV_ICONS.signed },
  ];

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
