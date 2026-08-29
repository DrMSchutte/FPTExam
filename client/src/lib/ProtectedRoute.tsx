import { Navigate } from "react-router-dom";
import type { ReactNode } from "react";
import { useAuth } from "./auth";
import type { UserRole } from "@shared/types";

/**
 * Gates a route behind authentication and, optionally, a set of allowed
 * roles. Mirrors the server's requireAuth/requireRole pair so the client
 * fails the same way the API would - this is a UX convenience, not the
 * security boundary (that's enforced server-side).
 */
export function ProtectedRoute({
  children,
  allow,
}: {
  children: ReactNode;
  allow?: UserRole[];
}) {
  const { user, loading } = useAuth();

  if (loading) return <div className="p-8 text-gray-500">Loading...</div>;
  if (!user) return <Navigate to="/login" replace />;
  if (allow && !user.roles.some((r) => allow.includes(r))) {
    return (
      <div className="p-8">
        <p className="text-red-600 font-medium">You don't have access to this page.</p>
        <p className="text-sm text-gray-500 mt-1">
          Required role: {allow.join(" or ")}. Your roles: {user.roles.join(", ")}.
        </p>
      </div>
    );
  }
  return <>{children}</>;
}
