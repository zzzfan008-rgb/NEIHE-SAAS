import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  authChangeFromStorageEvent,
  bindWorkspaceToAuthenticatedUser,
  broadcastAuthChange,
  clearSessionEndNotice,
  isCurrentSessionRefresh,
  readSessionEndNotice,
  rememberSessionEndNotice,
  sessionRefreshFailureAction,
  shouldReloadForAuthenticatedUserTransition,
  type SessionEndReason,
} from "./session";
import { suppressWorkspaceUnloadWarning } from "@/lib/workspaceUnload";
import { suspendProjectTabSessionPersistence } from "@/lib/tabSessionStorage";
import { didRestoreProjectTabSessionWorkspace } from "@/lib/workspaceRestoreState";
import { browserDrawingDraftStore } from "@/lib/drawingDraftStore";
import { useCustomColors } from "@/store/customColors";
import { clearPoseCredential } from "@/lib/poseCredentials";

export interface CurrentUser {
  id: string;
  accountId: string;
  displayName: string;
  role: "admin" | "user";
  mustChangePassword: boolean;
}

interface AuthContextValue {
  user: CurrentUser | null;
  loading: boolean;
  sessionEndReason: SessionEndReason | null;
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
  acknowledgeSessionEnd: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const restoredSessionEndReason = useRef(readSessionEndNotice(window.sessionStorage)).current;
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [loading, setLoading] = useState(restoredSessionEndReason === null);
  const [sessionEndReason, setSessionEndReason] = useState<SessionEndReason | null>(restoredSessionEndReason);
  const refreshSequence = useRef(0);
  const sessionEnded = useRef(restoredSessionEndReason !== null);
  const authenticatedUserId = useRef<string | null>(null);

  const refresh = useCallback(async () => {
    if (sessionEnded.current) return;
    const requestId = ++refreshSequence.current;
    try {
      const response = await fetch("/api/auth/me", { cache: "no-store" });
      if (!response.ok) {
        if (response.status === 401) {
          const body = (await response.json().catch(() => ({}))) as { code?: unknown };
          if (!isCurrentSessionRefresh(requestId, refreshSequence.current, sessionEnded.current)) return;
          const action = sessionRefreshFailureAction(response.status, body.code);
          if (action === "end-replaced") {
            sessionEnded.current = true;
            authenticatedUserId.current = null;
            rememberSessionEndNotice(window.sessionStorage, "replaced");
            broadcastAuthChange(window.localStorage, "auth-changed");
            setSessionEndReason("replaced");
            setUser(null);
            useCustomColors.getState().bindOwner(null);
            // 整页重载会立即终止工作区和运行中的连接；不删除未保存草稿。
            suppressWorkspaceUnloadWarning();
            window.location.reload();
          } else if (action === "clear-user") {
            sessionEnded.current = true;
            authenticatedUserId.current = null;
            setUser(null);
            useCustomColors.getState().bindOwner(null);
          }
        }
        return;
      }
      const body = (await response.json()) as { user: CurrentUser };
      if (isCurrentSessionRefresh(requestId, refreshSequence.current, sessionEnded.current)) {
        const workspace = bindWorkspaceToAuthenticatedUser(
          window.sessionStorage,
          window.localStorage,
          body.user.id,
        );
        if (shouldReloadForAuthenticatedUserTransition(
          authenticatedUserId.current,
          body.user.id,
          workspace,
          didRestoreProjectTabSessionWorkspace(),
        )) {
          // 共享 cookie 可能已切换账号；即使存储不可用，也必须重载丢弃旧账号内存画布。
          suspendProjectTabSessionPersistence();
          authenticatedUserId.current = null;
          sessionEnded.current = true;
          refreshSequence.current += 1;
          setUser(null);
          setLoading(true);
          suppressWorkspaceUnloadWarning();
          window.location.reload();
          return;
        }
        authenticatedUserId.current = body.user.id;
        useCustomColors.getState().bindOwner(body.user.id);
        void useCustomColors.getState().refreshFavorites();
        setUser(body.user);
      }
    } catch {
      // 瞬时断网不主动注销已登录用户；首次加载则自然停留在登录页。
    } finally {
      if (requestId === refreshSequence.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (sessionEndReason || sessionEnded.current) return;
    void refresh();
    const timer = window.setInterval(() => void refresh(), 15_000);
    const onVisible = () => { if (document.visibilityState === "visible") void refresh(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refresh, sessionEndReason]);

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      const change = authChangeFromStorageEvent(event.key, event.newValue);
      if (!change) return;
      // Cookie 在同源页签间共享：先使当前工作区进入终态，再立即重载并重新绑定 owner。
      refreshSequence.current += 1;
      sessionEnded.current = true;
      authenticatedUserId.current = null;
      useCustomColors.getState().bindOwner(null);
      if (change.type === "logout" && user?.id) {
        clearPoseCredential(user.id);
        void browserDrawingDraftStore().clearOwner(user.id).catch(() => undefined);
      }
      clearSessionEndNotice(window.sessionStorage);
      setUser(null);
      setSessionEndReason(null);
      setLoading(true);
      suppressWorkspaceUnloadWarning();
      window.location.reload();
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [user?.id]);

  const logout = useCallback(async () => {
    const ownerId = authenticatedUserId.current;
    clearPoseCredential(ownerId);
    await fetch("/api/auth/logout", { method: "POST" }).catch(() => undefined);
    if (ownerId) await browserDrawingDraftStore().clearOwner(ownerId).catch(() => undefined);
    refreshSequence.current += 1;
    sessionEnded.current = true;
    authenticatedUserId.current = null;
    useCustomColors.getState().bindOwner(null);
    clearSessionEndNotice(window.sessionStorage);
    broadcastAuthChange(window.localStorage, "logout");
    // 保留按账号绑定的本机草稿；下次登录不同账号时再安全清理。
    suppressWorkspaceUnloadWarning();
    window.location.reload();
  }, []);

  const acknowledgeSessionEnd = useCallback(() => {
    clearSessionEndNotice(window.sessionStorage);
    // replaced cookie 留待下次成功登录自然覆盖，避免旧 /me 响应误删其他页签的新 cookie。
    setSessionEndReason(null);
    authenticatedUserId.current = null;
    setUser(null);
    setLoading(false);
  }, []);

  const value = useMemo(
    () => ({ user, loading, sessionEndReason, refresh, logout, acknowledgeSessionEnd }),
    [user, loading, sessionEndReason, refresh, logout, acknowledgeSessionEnd],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error("useAuth must be used inside AuthProvider");
  return value;
}
