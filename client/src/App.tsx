import { Routes, Route, Navigate } from "react-router-dom";
import Login from "./routes/Login";
import { ProtectedRoute } from "./lib/ProtectedRoute";
import { useAuth } from "./lib/auth";
import AdminDashboard from "./routes/admin/AdminDashboard";
import LearnerDashboard from "./routes/learner/LearnerDashboard";
import InvigilatorDashboard from "./routes/invigilator/InvigilatorDashboard";
import AssessorDashboard from "./routes/assessor/AssessorDashboard";
import ModeratorDashboard from "./routes/moderator/ModeratorDashboard";
import HeadQADashboard from "./routes/headqa/HeadQADashboard";

const HOME_BY_ROLE: Record<string, string> = {
  administrator: "/admin",
  learner: "/learner",
  invigilator: "/invigilator",
  assessor: "/assessor",
  moderator: "/moderator",
  head_qa: "/headqa",
};

function Home() {
  const { user, loading, logout } = useAuth();
  if (loading) return <div className="p-8 text-gray-500">Loading...</div>;
  if (!user) return <Navigate to="/login" replace />;

  const primaryRole = user.roles[0];
  const target = HOME_BY_ROLE[primaryRole];
  if (target) return <Navigate to={target} replace />;

  return (
    <div className="p-8">
      <p>No dashboard configured for role(s): {user.roles.join(", ")}.</p>
      <button onClick={() => logout()} className="mt-4 text-sm text-brand-600 underline">
        Sign out
      </button>
    </div>
  );
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/" element={<Home />} />
      <Route
        path="/admin/*"
        element={
          <ProtectedRoute allow={["administrator"]}>
            <AdminDashboard />
          </ProtectedRoute>
        }
      />
      <Route
        path="/learner/*"
        element={
          <ProtectedRoute allow={["learner"]}>
            <LearnerDashboard />
          </ProtectedRoute>
        }
      />
      <Route
        path="/invigilator/*"
        element={
          <ProtectedRoute allow={["invigilator"]}>
            <InvigilatorDashboard />
          </ProtectedRoute>
        }
      />
      <Route
        path="/assessor/*"
        element={
          <ProtectedRoute allow={["assessor"]}>
            <AssessorDashboard />
          </ProtectedRoute>
        }
      />
      <Route
        path="/moderator/*"
        element={
          <ProtectedRoute allow={["moderator"]}>
            <ModeratorDashboard />
          </ProtectedRoute>
        }
      />
      <Route
        path="/headqa/*"
        element={
          <ProtectedRoute allow={["head_qa"]}>
            <HeadQADashboard />
          </ProtectedRoute>
        }
      />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
