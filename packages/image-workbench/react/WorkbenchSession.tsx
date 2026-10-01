import { lazy, Suspense, type ReactNode } from "react";
import { AuthProvider, useAuth } from "../src/auth/AuthContext";
import { WorkbenchRuntime } from "./WorkbenchRuntime";

const LoginPage = lazy(() => import("../src/auth/LoginPage").then((m) => ({ default: m.LoginPage })));
const SessionEndedPage = lazy(() => import("../src/auth/LoginPage").then((m) => ({ default: m.SessionEndedPage })));
const ChangePasswordPage = lazy(() => import("../src/auth/LoginPage").then((m) => ({ default: m.ChangePasswordPage })));

function AuthenticatedContent({ children }: { children: ReactNode }) {
  const { user, loading, sessionEndReason, acknowledgeSessionEnd } = useAuth();
  if (loading) return <span role="status">正在验证登录状态…</span>;
  if (sessionEndReason === "replaced") return <SessionEndedPage onContinue={acknowledgeSessionEnd} />;
  if (!user) return <LoginPage />;
  if (user.mustChangePassword) return <ChangePasswordPage />;
  return <WorkbenchRuntime userId={user.id}>{children}</WorkbenchRuntime>;
}

/** Uses this package's original cookie-session API; no host-account impersonation adapter. */
export function WorkbenchSession({ children }: { children: ReactNode }) {
  return <AuthProvider><Suspense fallback={<span role="status">正在加载工作台…</span>}>
    <AuthenticatedContent>{children}</AuthenticatedContent>
  </Suspense></AuthProvider>;
}
