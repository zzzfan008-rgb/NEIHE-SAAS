import assert from "node:assert/strict";
import { readPoseCredential, savePoseCredential, clearPoseCredential } from '../src/lib/poseCredentials';
import { readFileSync } from "node:fs";
import {
  isProjectTabSessionPersistenceSuspended,
  projectTabStorageKey,
} from "../src/lib/tabSessionStorage";
import {
  AUTH_CHANGE_STORAGE_KEY,
  authChangeFromStorageEvent,
  bindWorkspaceToAuthenticatedUser,
  broadcastAuthChange,
  clearLocalWorkspace,
  clearSessionEndNotice,
  isCurrentSessionRefresh,
  prepareWorkspaceForLogin,
  readSessionEndNotice,
  readWorkspaceOwner,
  rememberSessionEndNotice,
  sessionEndReasonFromCode,
  sessionRefreshFailureAction,
  shouldReloadForAuthenticatedUserTransition,
} from "../src/auth/session";

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
    key: (index: number) => [...values.keys()][index] ?? null,
    get length() { return values.size; },
    has: (key: string) => values.has(key),
  };
}

console.log("客户端会话失效体验回归测试");

const oldWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
try {
  const localStorage = memoryStorage();
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { localStorage } });
  assert.equal(savePoseCredential('user-a', 'test-key-a'), true);
  assert.equal(savePoseCredential('user-b', 'test-key-b'), true);
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { localStorage } });
  assert.equal(readPoseCredential('user-a'), 'test-key-a', 'Refresh keeps the account credential');
  assert.equal(readPoseCredential('user-b'), 'test-key-b');
  assert.equal(readPoseCredential('user-c'), '');
  clearPoseCredential('user-a');
  assert.equal(readPoseCredential('user-a'), '');
  assert.equal(readPoseCredential('user-b'), 'test-key-b', 'Logout clears only its owner');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { get localStorage() { throw new Error('blocked'); } } });
  assert.equal(savePoseCredential('user-a', 'test-key'), false);
  assert.equal(readPoseCredential('user-a'), '');
  clearPoseCredential('user-a');
} finally {
  if (oldWindow) Object.defineProperty(globalThis, 'window', oldWindow);
  else Reflect.deleteProperty(globalThis, 'window');
}

assert.equal(sessionEndReasonFromCode("SESSION_REPLACED"), "replaced");
assert.equal(sessionEndReasonFromCode("UNAUTHENTICATED"), null);
assert.equal(sessionEndReasonFromCode(undefined), null);
console.log("  ✓ 仅新设备替换会话触发专用退出页面");

assert.equal(sessionRefreshFailureAction(500, "SESSION_REPLACED"), "retain-user");
assert.equal(sessionRefreshFailureAction(401, "UNAUTHENTICATED"), "clear-user");
assert.equal(sessionRefreshFailureAction(401, "SESSION_REPLACED"), "end-replaced");
assert.equal(isCurrentSessionRefresh(2, 2, false), true);
assert.equal(isCurrentSessionRefresh(1, 2, false), false);
assert.equal(isCurrentSessionRefresh(2, 2, true), false);
console.log("  ✓ 5xx 保留当前用户，旧 replaced 响应不能覆盖较新的成功响应");

const noticeValues = new Map<string, string>();
noticeValues.set("garment-canvas-project-tabs", "unsaved-draft");
const noticeStorage = {
  getItem: (key: string) => noticeValues.get(key) ?? null,
  setItem: (key: string, value: string) => noticeValues.set(key, value),
  removeItem: (key: string) => { noticeValues.delete(key); },
};
assert.equal(readSessionEndNotice(noticeStorage), null);
rememberSessionEndNotice(noticeStorage, "replaced");
assert.equal(readSessionEndNotice(noticeStorage), "replaced");
assert.equal(noticeValues.get("garment-canvas-project-tabs"), "unsaved-draft");
clearSessionEndNotice(noticeStorage);
assert.equal(readSessionEndNotice(noticeStorage), null);
assert.equal(noticeValues.get("garment-canvas-project-tabs"), "unsaved-draft");
console.log("  ✓ 强制退出只记录原因，不删除未保存画布");

const removed: string[] = [];
assert.equal(isProjectTabSessionPersistenceSuspended(), false);
clearLocalWorkspace(
  { removeItem: (key) => removed.push(`session:${key}`) },
  { removeItem: (key) => removed.push(`local:${key}`) },
);
assert.equal(
  isProjectTabSessionPersistenceSuspended(),
  false,
  "低层定向清理本身不应永久关闭一个仍会继续使用的空工作区",
);
assert.deepEqual(removed, [
  "session:garment-canvas-project-tabs",
  "session:garment-canvas-ambiguous-run-requests",
  "local:garment-canvas-recent-results",
]);
console.log("  ✓ 需要切换账号时可定向清理项目页签、未决付费请求号与本地记录");

const cleanupAttempts: string[] = [];
clearLocalWorkspace({
  removeItem: (key) => {
    cleanupAttempts.push(`session:${key}`);
    if (key === "garment-canvas-project-tabs") throw new Error("storage failure");
  },
}, {
  removeItem: (key) => cleanupAttempts.push(`local:${key}`),
});
assert.deepEqual(cleanupAttempts, [
  "session:garment-canvas-project-tabs",
  "session:garment-canvas-ambiguous-run-requests",
  "local:garment-canvas-recent-results",
]);
console.log("  ✓ 单个缓存键清理失败不阻断其它跨账号状态清理");

const v2Manifest = JSON.stringify({
  schemaVersion: 2,
  activeTabId: "tab-a",
  tabIds: ["tab-a", "tab-b"],
});
const fragmentedSession = memoryStorage({
  "garment-canvas-workspace-owner-id": "user-a",
  "garment-canvas-project-tabs": v2Manifest,
  "garment-canvas-project-tab:tab-a": "draft-a",
  "garment-canvas-project-tab:tab-b": "draft-b",
  "garment-canvas-project-tab:orphan": "orphan-draft",
  "garment-canvas-ambiguous-run-requests": "request-a",
  "unrelated-session-key": "keep-me",
});
const fragmentedLocal = memoryStorage({ "garment-canvas-recent-results": "history-a" });
clearLocalWorkspace(fragmentedSession, fragmentedLocal);
assert.equal(fragmentedSession.has("garment-canvas-project-tabs"), false);
assert.equal(fragmentedSession.has("garment-canvas-project-tab:tab-a"), false);
assert.equal(fragmentedSession.has("garment-canvas-project-tab:tab-b"), false);
assert.equal(fragmentedSession.has("garment-canvas-project-tab:orphan"), false);
assert.equal(fragmentedSession.has("garment-canvas-ambiguous-run-requests"), false);
assert.equal(fragmentedLocal.has("garment-canvas-recent-results"), false);
assert.equal(fragmentedSession.has("garment-canvas-workspace-owner-id"), true);
assert.equal(fragmentedSession.has("unrelated-session-key"), true);
console.log("  ✓ 跨账号清理会删除 v2 manifest 引用草稿与可枚举孤儿草稿");

function storageWithBrokenEnumeration(
  brokenMember: "key" | "length",
  projectTabsRoot = v2Manifest,
) {
  const values = new Map(Object.entries({
    "garment-canvas-project-tabs": projectTabsRoot,
    "garment-canvas-project-tab:tab-a": "draft-a",
    "garment-canvas-project-tab:tab-b": "draft-b",
    "garment-canvas-project-tab:orphan": "orphan-draft",
    "garment-canvas-ambiguous-run-requests": "request-a",
  }));
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    removeItem: (key: string) => { values.delete(key); },
    has: (key: string) => values.has(key),
  } as {
    getItem(key: string): string | null;
    removeItem(key: string): void;
    has(key: string): boolean;
    key?: (index: number) => string | null;
    readonly length?: number;
  };
  if (brokenMember === "key") {
    Object.defineProperty(storage, "key", {
      get: () => { throw new Error("key unavailable"); },
    });
    Object.defineProperty(storage, "length", {
      get: () => values.size,
    });
  } else {
    storage.key = (index) => [...values.keys()][index] ?? null;
    Object.defineProperty(storage, "length", {
      get: () => { throw new Error("length unavailable"); },
    });
  }
  return storage;
}

for (const brokenMember of ["key", "length"] as const) {
  const brokenEnumerationSession = storageWithBrokenEnumeration(brokenMember);
  const brokenEnumerationLocal = memoryStorage({
    "garment-canvas-recent-results": "history-a",
  });
  clearLocalWorkspace(brokenEnumerationSession, brokenEnumerationLocal);
  assert.equal(brokenEnumerationSession.has("garment-canvas-project-tabs"), false, brokenMember);
  assert.equal(brokenEnumerationSession.has("garment-canvas-project-tab:tab-a"), false, brokenMember);
  assert.equal(brokenEnumerationSession.has("garment-canvas-project-tab:tab-b"), false, brokenMember);
  assert.equal(
    brokenEnumerationSession.has("garment-canvas-project-tab:orphan"),
    true,
    `${brokenMember} 不可用时无法发现孤儿 key，但不能阻断 manifest 引用清理`,
  );
  assert.equal(brokenEnumerationSession.has("garment-canvas-ambiguous-run-requests"), false, brokenMember);
  assert.equal(brokenEnumerationLocal.has("garment-canvas-recent-results"), false, brokenMember);
}
console.log("  ✓ key/length 枚举 getter 异常时仍清理 manifest 引用与其他账号缓存");

const interruptedMigrationSession = storageWithBrokenEnumeration("key", JSON.stringify({
  activeTabId: "tab-a",
  tabs: [{ id: "tab-a" }, { id: "tab-b" }],
}));
clearLocalWorkspace(interruptedMigrationSession, memoryStorage());
assert.equal(interruptedMigrationSession.has("garment-canvas-project-tab:tab-a"), false);
assert.equal(interruptedMigrationSession.has("garment-canvas-project-tab:tab-b"), false);
console.log("  ✓ legacy 迁移中断且无法枚举时仍按单体引用清理已写分片");

const malformedTabId = "\ud800";
const malformedTabKey = projectTabStorageKey(malformedTabId);
const malformedIdSession = memoryStorage({
  "garment-canvas-project-tabs": JSON.stringify({
    activeTabId: malformedTabId,
    tabs: [{ id: malformedTabId }],
  }),
  [malformedTabKey]: "malformed-id-draft",
});
assert.equal(clearLocalWorkspace(malformedIdSession, memoryStorage()), true);
assert.equal(malformedIdSession.has(malformedTabKey), false);
console.log("  ✓ 非法 UTF-16 tabId 不会中断跨账号草稿清理");

const sameAccountSession = memoryStorage({
  "garment-canvas-workspace-owner-id": "user-a",
  "garment-canvas-project-tabs": "draft-a",
});
const sameAccountLocal = memoryStorage({ "garment-canvas-recent-results": "history-a" });
assert.equal(
  prepareWorkspaceForLogin(sameAccountSession, sameAccountLocal, "user-a"),
  "preserved",
);
assert.equal(sameAccountSession.getItem("garment-canvas-project-tabs"), "draft-a");
assert.equal(sameAccountLocal.getItem("garment-canvas-recent-results"), "history-a");
console.log("  ✓ 同一账号重新登录保留未保存画布");

const firstAuthenticatedSession = memoryStorage();
assert.equal(
  bindWorkspaceToAuthenticatedUser(firstAuthenticatedSession, memoryStorage(), "user-first"),
  "preserved",
);
assert.equal(readWorkspaceOwner(firstAuthenticatedSession), "user-first");
assert.equal(
  isProjectTabSessionPersistenceSuspended(),
  false,
  "首次空工作区绑定后仍需允许本页写入新账号草稿",
);
console.log("  ✓ 首次空工作区绑定 owner 时不会误停用新账号草稿写入器");

const ownerOnlyTransition = memoryStorage({
  "garment-canvas-workspace-owner-id": "user-a",
});
assert.equal(
  bindWorkspaceToAuthenticatedUser(ownerOnlyTransition, memoryStorage(), "user-b"),
  "cleared",
  "即使磁盘草稿恰为空，A→B 仍需重载丢弃 A 的内存工作区",
);
assert.equal(readWorkspaceOwner(ownerOnlyTransition), "user-b");
console.log("  ✓ owner-only A→B 仍强制重载，不留下已停用但继续运行的工作区");

let failOldRootRemovalOnce = true;
const cleanupFailureValues = new Map(Object.entries({
  "garment-canvas-workspace-owner-id": "user-a",
  "garment-canvas-project-tabs": "legacy-a-draft",
}));
const cleanupFailureSession = {
  get length() { return cleanupFailureValues.size; },
  getItem: (key: string) => cleanupFailureValues.get(key) ?? null,
  key: (index: number) => [...cleanupFailureValues.keys()][index] ?? null,
  setItem: (key: string, value: string) => { cleanupFailureValues.set(key, value); },
  removeItem: (key: string) => {
    if (key === "garment-canvas-project-tabs" && failOldRootRemovalOnce) {
      failOldRootRemovalOnce = false;
      throw new Error("transient removal failure");
    }
    cleanupFailureValues.delete(key);
  },
};
assert.equal(
  bindWorkspaceToAuthenticatedUser(cleanupFailureSession, memoryStorage(), "user-b"),
  "cleared",
);
assert.equal(cleanupFailureSession.getItem("garment-canvas-project-tabs"), "legacy-a-draft");
assert.equal(
  cleanupFailureSession.getItem("garment-canvas-workspace-owner-id"),
  null,
  "旧草稿未确认删除时绝不能把 owner 绑定到新账号",
);
assert.equal(
  bindWorkspaceToAuthenticatedUser(cleanupFailureSession, memoryStorage(), "user-b"),
  "cleared",
);
assert.equal(cleanupFailureSession.getItem("garment-canvas-project-tabs"), null);
assert.equal(cleanupFailureSession.getItem("garment-canvas-workspace-owner-id"), "user-b");
console.log("  ✓ 定向清理失败时不绑定新 owner，重载重试成功后才允许账号接管");

const switchedSession = memoryStorage({
  "garment-canvas-workspace-owner-id": "user-a",
  "garment-canvas-project-tabs": "draft-a",
  "garment-canvas-ambiguous-run-requests": "request-a",
});
const switchedLocal = memoryStorage({ "garment-canvas-recent-results": "history-a" });
assert.equal(prepareWorkspaceForLogin(switchedSession, switchedLocal, "user-b"), "cleared");
assert.equal(isProjectTabSessionPersistenceSuspended(), true);
assert.equal(switchedSession.has("garment-canvas-project-tabs"), false);
assert.equal(switchedSession.has("garment-canvas-ambiguous-run-requests"), false);
assert.equal(switchedLocal.has("garment-canvas-recent-results"), false);
assert.equal(readWorkspaceOwner(switchedSession), "user-b");
console.log("  ✓ 切换到不同账号时清除旧画布并更新归属");

const unownedLoginSession = memoryStorage({ "garment-canvas-project-tabs": "unknown-owner-draft" });
const unownedLoginLocal = memoryStorage({ "garment-canvas-recent-results": "unknown-owner-history" });
assert.equal(
  prepareWorkspaceForLogin(unownedLoginSession, unownedLoginLocal, "user-a"),
  "cleared",
);
assert.equal(unownedLoginSession.has("garment-canvas-project-tabs"), false);
assert.equal(unownedLoginLocal.has("garment-canvas-recent-results"), false);
assert.equal(readWorkspaceOwner(unownedLoginSession), "user-a");
console.log("  ✓ 显式登录不会暴露无法证明归属的旧草稿");

const legacySession = memoryStorage({
  "garment-canvas-project-tabs": "legacy-draft",
  "garment-canvas-ambiguous-run-requests": "legacy-request",
});
const legacyLocal = memoryStorage({ "garment-canvas-recent-results": "legacy-history" });
assert.equal(
  bindWorkspaceToAuthenticatedUser(legacySession, legacyLocal, "user-a"),
  "cleared",
);
assert.equal(legacySession.has("garment-canvas-project-tabs"), false);
assert.equal(legacySession.has("garment-canvas-ambiguous-run-requests"), false);
assert.equal(legacyLocal.has("garment-canvas-recent-results"), false);
assert.equal(readWorkspaceOwner(legacySession), "user-a");
console.log("  ✓ 无 owner 的旧缓存按不可信数据清理后再绑定当前账号");

const ambiguousOnlySession = memoryStorage({
  "garment-canvas-ambiguous-run-requests": "unknown-owner-request",
});
assert.equal(
  bindWorkspaceToAuthenticatedUser(ambiguousOnlySession, memoryStorage(), "user-a"),
  "cleared",
);
assert.equal(ambiguousOnlySession.has("garment-canvas-ambiguous-run-requests"), false);
console.log("  ✓ 仅残留未决付费请求号时也会重载以清除旧账号内存状态");

const sameAccountOtherTab = memoryStorage({
  "garment-canvas-workspace-owner-id": "user-a",
  "garment-canvas-project-tabs": "draft-a-other-tab",
});
const sameAccountSharedLocal = memoryStorage({ "garment-canvas-recent-results": "history-a" });
broadcastAuthChange(sameAccountSharedLocal, "login", "user-a");
const sameAccountEvent = authChangeFromStorageEvent(
  AUTH_CHANGE_STORAGE_KEY,
  sameAccountSharedLocal.getItem(AUTH_CHANGE_STORAGE_KEY),
);
assert.equal(sameAccountEvent?.type, "login");
assert.equal(sameAccountEvent?.userId, "user-a");
assert.equal(
  bindWorkspaceToAuthenticatedUser(sameAccountOtherTab, sameAccountSharedLocal, sameAccountEvent?.userId ?? ""),
  "preserved",
);
assert.equal(sameAccountOtherTab.getItem("garment-canvas-project-tabs"), "draft-a-other-tab");
console.log("  ✓ 其他页签收到同账号登录事件后重载仍保留该账号草稿");

const switchedOtherTab = memoryStorage({
  "garment-canvas-workspace-owner-id": "user-a",
  "garment-canvas-project-tabs": "draft-a-other-tab",
});
const switchedSharedLocal = memoryStorage({ "garment-canvas-recent-results": "history-a" });
broadcastAuthChange(switchedSharedLocal, "login", "user-b");
const switchedEvent = authChangeFromStorageEvent(
  AUTH_CHANGE_STORAGE_KEY,
  switchedSharedLocal.getItem(AUTH_CHANGE_STORAGE_KEY),
);
assert.equal(switchedEvent?.userId, "user-b");
assert.equal(
  bindWorkspaceToAuthenticatedUser(switchedOtherTab, switchedSharedLocal, switchedEvent?.userId ?? ""),
  "cleared",
);
assert.equal(switchedOtherTab.has("garment-canvas-project-tabs"), false);
assert.equal(switchedSharedLocal.has("garment-canvas-recent-results"), false);
assert.equal(readWorkspaceOwner(switchedOtherTab), "user-b");
assert.equal(authChangeFromStorageEvent("unrelated", switchedSharedLocal.getItem(AUTH_CHANGE_STORAGE_KEY)), null);
assert.equal(authChangeFromStorageEvent(AUTH_CHANGE_STORAGE_KEY, "not-json"), null);
console.log("  ✓ 其他页签收到跨账号事件后重载并按 owner 隔离旧草稿");

const terminalEventStorage = memoryStorage();
broadcastAuthChange(terminalEventStorage, "auth-changed");
assert.equal(
  authChangeFromStorageEvent(
    AUTH_CHANGE_STORAGE_KEY,
    terminalEventStorage.getItem(AUTH_CHANGE_STORAGE_KEY),
  )?.type,
  "auth-changed",
);
broadcastAuthChange(terminalEventStorage, "logout");
assert.equal(
  authChangeFromStorageEvent(
    AUTH_CHANGE_STORAGE_KEY,
    terminalEventStorage.getItem(AUTH_CHANGE_STORAGE_KEY),
  )?.type,
  "logout",
);
console.log("  ✓ 会话替换和退出事件同样可通知其他页签立即终止工作区");

const mixedAvailabilitySession = memoryStorage({
  "garment-canvas-workspace-owner-id": "user-a",
  "garment-canvas-project-tabs": "draft-a",
});
const unavailableHistoryStorage = {
  getItem: (_key: string): string | null => { throw new Error("local history unavailable"); },
  removeItem: (_key: string): void => undefined,
};
assert.equal(
  bindWorkspaceToAuthenticatedUser(mixedAvailabilitySession, unavailableHistoryStorage, "user-b"),
  "cleared",
);
assert.equal(mixedAvailabilitySession.has("garment-canvas-project-tabs"), false);
assert.equal(readWorkspaceOwner(mixedAvailabilitySession), "user-b");
mixedAvailabilitySession.setItem("garment-canvas-project-tabs", "fresh-b-draft");
assert.equal(
  bindWorkspaceToAuthenticatedUser(mixedAvailabilitySession, unavailableHistoryStorage, "user-b"),
  "preserved",
  "local history 不可读不能让已隔离的 session workspace 永久 reload",
);
console.log("  ✓ local history 不可用时 session 草稿仍可完成一次隔离并稳定绑定新 owner");

const unavailableSessionStorage = {
  getItem: (_key: string): string | null => { throw new Error("storage disabled"); },
  setItem: (_key: string, _value: string): void => { throw new Error("storage disabled"); },
  removeItem: (_key: string): void => { throw new Error("storage disabled"); },
};
const unavailableLocalStorage = {
  getItem: (_key: string): string | null => { throw new Error("storage disabled"); },
  removeItem: (_key: string): void => { throw new Error("storage disabled"); },
};
assert.equal(
  bindWorkspaceToAuthenticatedUser(unavailableSessionStorage, unavailableLocalStorage, "user-a"),
  "unavailable",
);
console.log("  ✓ 浏览器存储不可用时不会返回 cleared 触发无限重载");

let authenticatedUserId: string | null = null;
assert.equal(
  shouldReloadForAuthenticatedUserTransition(authenticatedUserId, "user-a", "unavailable"),
  false,
  "首次加载且没有旧内存账号时无需重载",
);
authenticatedUserId = "user-a";
assert.equal(
  shouldReloadForAuthenticatedUserTransition(authenticatedUserId, "user-a", "unavailable"),
  false,
  "同账号轮询不应在存储不可用时无限重载",
);
assert.equal(
  shouldReloadForAuthenticatedUserTransition(authenticatedUserId, "user-b", "unavailable"),
  true,
  "A 的内存工作区遇到 B 的 cookie 时必须重载隔离",
);
assert.equal(
  shouldReloadForAuthenticatedUserTransition(null, "user-b", "cleared"),
  true,
  "已清理旧缓存时仍须重载丢弃模块初始化时恢复的内存画布",
);
assert.equal(
  shouldReloadForAuthenticatedUserTransition(null, "user-b", "unavailable", true),
  true,
  "启动已恢复 A 草稿后存储才失效时，首次 /me 不得将 A 内存画布交给 B",
);
console.log("  ✓ 存储完全不可用时仍以当前已认证 userId 阻断 A→B 内存画布复用");

const authContextSource = readFileSync(new URL("../src/auth/AuthContext.tsx", import.meta.url), "utf8");
assert.match(
  authContextSource,
  /if \(shouldReloadForAuthenticatedUserTransition[\s\S]{0,500}?didRestoreProjectTabSessionWorkspace\(\)[\s\S]{0,800}?suspendProjectTabSessionPersistence\(\);[\s\S]{0,500}?window\.location\.reload\(\)/,
  "A→B 内存身份变化必须在 reload/pagehide 前停用旧账号草稿写入器",
);
console.log("  ✓ A→B 内存身份变化在 reload 前停用旧页写入器");
