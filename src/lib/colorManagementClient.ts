import { useEffect, useState } from "react";
import type {
  ColorImportCommit,
  ImportColorDecision,
  ManagedColorImport,
} from "../types/brandColors";

export interface ColorDirectoryPage<T> {
  items: T[];
  nextOffset: number | null;
}
export class ColorRequestError extends Error {
  readonly status: number | null;
  readonly code: string | null;
  readonly outcomeUnknown: boolean;
  constructor(
    message: string,
    status: number | null,
    code: string | null = null,
    outcomeUnknown = false,
  ) {
    super(message);
    this.name = "ColorRequestError";
    this.status = status;
    this.code = code;
    this.outcomeUnknown = outcomeUnknown;
  }
}

export async function colorRequest<T>(
  path: string,
  method = "GET",
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  signal?.throwIfAborted();
  const url = new URL(`/api/colors${path}`, "https://color-management.invalid");
  if (
    !path.startsWith("/") ||
    path.startsWith("//") ||
    !url.pathname.startsWith("/api/colors/") ||
    url.hash
  ) {
    throw new ColorRequestError("色彩请求路径无效", null, "invalid_path");
  }
  const encodedBody = body === undefined ? undefined : JSON.stringify(body);
  const writing = !["GET", "HEAD"].includes(method.toUpperCase());
  let response: Response;
  try {
    response = await fetch(`/api/colors${path}`, {
      method,
      signal,
      cache: "no-store",
      credentials: "same-origin",
      ...(encodedBody === undefined
        ? {}
        : {
            headers: { "Content-Type": "application/json" },
            body: encodedBody,
          }),
    });
  } catch {
    signal?.throwIfAborted();
    throw new ColorRequestError(
      writing
        ? "网络连接失败，保存结果可能未知；请先核对状态"
        : "网络连接失败，请重试",
      null,
      "network_error",
      writing,
    );
  }
  signal?.throwIfAborted();
  if (response.status === 204) return undefined as T;
  let text: string;
  try {
    text = await response.text();
  } catch {
    signal?.throwIfAborted();
    throw new ColorRequestError(
      `读取响应失败（HTTP ${response.status}）`,
      response.status,
      "response_read_failed",
      writing && (response.ok || response.status >= 500),
    );
  }
  signal?.throwIfAborted();
  let result: unknown;
  let validJson = true;
  try {
    result = JSON.parse(text);
  } catch {
    validJson = false;
  }
  if (!response.ok) {
    const data =
      result && typeof result === "object"
        ? (result as Record<string, unknown>)
        : {};
    const message =
      typeof data.error === "string" && data.error.trim()
        ? data.error.slice(0, 512)
        : `请求失败（HTTP ${response.status}）`;
    throw new ColorRequestError(
      message,
      response.status,
      typeof data.code === "string" ? data.code : null,
      writing && response.status >= 500,
    );
  }
  if (!validJson)
    throw new ColorRequestError(
      `服务返回了无效响应（HTTP ${response.status}）`,
      response.status,
      "invalid_response",
      writing,
    );
  return result as T;
}

export interface CreateColorImportInput {
  groupId: string;
  libraryKey: string;
  format: "ase" | "xlsx";
  base64: string;
}
export interface UpdateColorImportInput {
  revision: number;
  decisions: ImportColorDecision[];
}
export interface ConfirmColorImportInput {
  revision: number;
  groupRevision: number;
}

/** One editing/account context. Dispose on unmount or identity/resource change; abort is not a server rollback. */
export function createColorRequestScope() {
  let disposed = false;
  const controllers = new Set<AbortController>();
  async function request<T>(
    path: string,
    method = "GET",
    body?: unknown,
  ): Promise<T> {
    if (disposed) throw new DOMException("请求上下文已关闭", "AbortError");
    const controller = new AbortController();
    controllers.add(controller);
    try {
      const value = await colorRequest<T>(
        path,
        method,
        body,
        controller.signal,
      );
      controller.signal.throwIfAborted();
      return value;
    } finally {
      controllers.delete(controller);
    }
  }
  return {
    request,
    isActive: () => !disposed,
    dispose() {
      disposed = true;
      for (const controller of controllers) controller.abort();
      controllers.clear();
    },
    createImport: (input: CreateColorImportInput) =>
      request<ManagedColorImport>("/imports", "POST", input),
    updateImport: (id: string, input: UpdateColorImportInput) =>
      request<ManagedColorImport>(
        `/imports/${encodeURIComponent(id)}`,
        "PATCH",
        input,
      ),
    confirmImport: (id: string, input: ConfirmColorImportInput) =>
      request<ColorImportCommit>(
        `/imports/${encodeURIComponent(id)}/confirm`,
        "POST",
        input,
      ),
  };
}

/** CM-02 supplies an account/role scope key when wiring the management entry. */
export function useColorQuery<T>(
  path: string | null,
  revision = 0,
  scopeKey = "",
) {
  const key = JSON.stringify([scopeKey, path, revision]);
  const empty = { key, data: null, error: null, requestError: null };
  const [result, setResult] = useState<{
    key: string;
    data: T | null;
    error: string | null;
    requestError: ColorRequestError | null;
  }>(empty);
  useEffect(() => {
    if (!path) return;
    const scope = createColorRequestScope();
    void scope
      .request<T>(path)
      .then((data) => {
        if (scope.isActive())
          setResult({ key, data, error: null, requestError: null });
      })
      .catch((error: unknown) => {
        if (scope.isActive())
          setResult({
            key,
            data: null,
            error: error instanceof Error ? error.message : "读取失败",
            requestError: error instanceof ColorRequestError ? error : null,
          });
      });
    return () => scope.dispose();
  }, [key, path]);
  return result.key === key ? result : empty;
}
