import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
} from "react";
import { useAuth } from "@/auth/AuthContext";
import {
  ColorRequestError,
  createColorRequestScope,
  useColorQuery,
} from "@/lib/colorManagementClient";

type RequestScope = ReturnType<typeof createColorRequestScope>;
interface ColorSession {
  key: string;
  request: RequestScope["request"];
  refreshAuth: () => Promise<void>;
}
const SessionContext = createContext<ColorSession | null>(null);

export function ColorManagementSession({ children }: { children: ReactNode }) {
  const { user, refresh } = useAuth();
  const key = JSON.stringify([user?.id, user?.role, user?.mustChangePassword]);
  const allowed = user?.role === "admin" && !user.mustChangePassword;
  const active = useRef<{ key: string; scope: RequestScope } | null>(null);
  useEffect(() => {
    if (!allowed) return;
    const session = { key, scope: createColorRequestScope() };
    active.current = session;
    return () => {
      session.scope.dispose();
      if (active.current === session) active.current = null;
    };
  }, [key, allowed]);
  const request = useCallback<RequestScope["request"]>(
    async (path, method, body) => {
      const session = active.current;
      if (!session || session.key !== key)
        throw new DOMException("管理上下文已关闭", "AbortError");
      try {
        return await session.scope.request(path, method, body);
      } catch (error) {
        if (
          session.scope.isActive() &&
          error instanceof ColorRequestError &&
          [401, 403].includes(error.status ?? 0)
        )
          void refresh();
        throw error;
      }
    },
    [key, refresh],
  );
  const value = useMemo(
    () => ({ key, request, refreshAuth: refresh }),
    [key, request, refresh],
  );
  if (!allowed) return null;
  return (
    <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
  );
}

function useColorSession() {
  const session = useContext(SessionContext);
  if (!session) throw new Error("色彩管理必须位于已认证的管理会话中");
  return session;
}
export function useColorManagementRequest() {
  return useColorSession().request;
}
export function useColorManagementQuery<T>(path: string | null, revision = 0) {
  const { key, refreshAuth } = useColorSession();
  const query = useColorQuery<T>(path, revision, key);
  useEffect(() => {
    if (
      query.requestError &&
      [401, 403].includes(query.requestError.status ?? 0)
    )
      void refreshAuth();
  }, [query.requestError, refreshAuth]);
  return query;
}
