import { lazy, Suspense } from "react";
import { useAuth } from "@/auth/AuthContext";

const LoginPage = lazy(() => import("@/auth/LoginPage").then((module) => ({ default: module.LoginPage })));
const SessionEndedPage = lazy(() => import("@/auth/LoginPage").then((module) => ({ default: module.SessionEndedPage })));
const ChangePasswordPage = lazy(() => import("@/auth/LoginPage").then((module) => ({ default: module.ChangePasswordPage })));
const AuthenticatedWorkspace = lazy(() => import("./App"));

function FullScreenStatus({ children }: { children: string }) {
  return (
    <div className="flex h-full items-center justify-center bg-[#101214] text-xs text-neutral-500">
      {children}
    </div>
  );
}

export function AuthGate() {
  const { user, loading, sessionEndReason, acknowledgeSessionEnd } = useAuth();
  if (loading) return <FullScreenStatus>正在验证登录状态…</FullScreenStatus>;
  if (sessionEndReason === "replaced") {
    return (
      <Suspense fallback={<FullScreenStatus>正在加载登录页…</FullScreenStatus>}>
        <SessionEndedPage onContinue={acknowledgeSessionEnd} />
      </Suspense>
    );
  }
  if (!user) {
    return (
      <Suspense fallback={<FullScreenStatus>正在加载登录页…</FullScreenStatus>}>
        <LoginPage />
      </Suspense>
    );
  }
  if (user.mustChangePassword) {
    return (
      <Suspense fallback={<FullScreenStatus>正在加载账号设置…</FullScreenStatus>}>
        <ChangePasswordPage />
      </Suspense>
    );
  }
  return (
    <Suspense fallback={<FullScreenStatus>正在加载工作台…</FullScreenStatus>}>
      <AuthenticatedWorkspace userId={user.id} />
    </Suspense>
  );
}
