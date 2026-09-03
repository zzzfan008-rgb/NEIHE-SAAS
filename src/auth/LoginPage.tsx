import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAuth, type CurrentUser } from "./AuthContext";
import { broadcastAuthChange, prepareWorkspaceForLogin } from "./session";
import { suppressWorkspaceUnloadWarning } from "@/lib/workspaceUnload";

export function LoginPage() {
  const [accountId, setAccountId] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId, password }),
      });
      const body = (await response.json().catch(() => ({}))) as { error?: string; user?: CurrentUser };
      if (!response.ok) throw new Error(body.error ?? `登录失败（HTTP ${response.status}）`);
      if (!body.user?.id) throw new Error("登录响应缺少用户信息");
      // 同账号恢复本机草稿；只有切换到不同账号时才清除旧画布。
      prepareWorkspaceForLogin(window.sessionStorage, window.localStorage, body.user.id);
      broadcastAuthChange(window.localStorage, "login", body.user.id);
      suppressWorkspaceUnloadWarning();
      window.location.reload();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="relative isolate h-full overflow-y-auto bg-[#c9c5c0] text-[#151719]">
      <img
        aria-hidden="true"
        alt=""
        src="/assets/login/coin-ai-canvas-studio.webp"
        className="absolute inset-0 h-full w-full object-cover object-center"
      />
      <div
        aria-hidden="true"
        className="absolute inset-0 bg-[linear-gradient(90deg,rgba(10,12,14,0.04)_0%,rgba(10,12,14,0.01)_48%,rgba(246,244,240,0.08)_62%,rgba(246,244,240,0.24)_100%)]"
      />

      <section className="relative z-10 ml-auto flex min-h-full w-[46%] min-w-[440px] items-center justify-center px-[clamp(2rem,4vw,5.5rem)] py-10">
        <div className="w-full max-w-[440px] min-[1440px]:max-w-[500px]">
          <header className="text-center text-[#111315]" data-testid="login-brand">
            <h1 className="login-brand-title whitespace-nowrap text-[clamp(2.625rem,4vw,4rem)] leading-none font-light tracking-[-0.055em] motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-3 motion-safe:duration-500 motion-safe:[animation-fill-mode:both] motion-reduce:animate-none">
              <span className="block">COIN AI CANVAS</span>
            </h1>
            <p className="mt-5 whitespace-nowrap text-[clamp(1rem,1.35vw,1.125rem)] leading-7 font-medium tracking-[-0.02em] text-[#373a3d] motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-3 motion-safe:duration-500 motion-safe:[animation-delay:80ms] motion-safe:[animation-fill-mode:both] motion-reduce:animate-none">
              <span className="block">回到你的设计画布，继续这一季的创作吧！</span>
            </p>
          </header>

          <form
            onSubmit={submit}
            data-testid="login-card"
            className="relative mt-7 w-full overflow-hidden rounded-[28px] border border-white/60 bg-[#f8f6f1]/72 p-7 shadow-[0_28px_80px_rgba(22,24,26,0.16),inset_0_1px_0_rgba(255,255,255,0.38)] backdrop-blur-xl backdrop-saturate-125 before:pointer-events-none before:absolute before:inset-x-7 before:top-0 before:h-px before:bg-[linear-gradient(90deg,transparent,rgba(255,255,255,0.95),transparent)] before:content-[''] min-[1440px]:p-8 motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-4 motion-safe:duration-500 motion-safe:[animation-delay:160ms] motion-safe:[animation-fill-mode:both] motion-reduce:animate-none"
          >
            <div className="mb-6 min-[1440px]:mb-7">
              <p className="text-[10px] font-semibold tracking-[0.26em] text-[#62666a] uppercase min-[1440px]:text-[11px]">Designer workspace</p>
              <h2 className="mt-2 text-xl font-semibold tracking-[-0.025em] text-[#151719] min-[1440px]:text-[1.375rem]">登录服装设计工作台</h2>
              <p className="mt-1.5 text-xs leading-5 text-[#62666a] min-[1440px]:text-[13px]">账号由管理员创建，同一账号仅允许一个设备在线。</p>
            </div>

            <label className="block space-y-2">
              <span className="text-xs font-medium text-[#303337] min-[1440px]:text-[13px]">账号</span>
              <Input
                autoFocus
                name="accountId"
                value={accountId}
                onChange={(event) => setAccountId(event.target.value)}
                autoComplete="username"
                placeholder="请输入账号"
                className="h-12 rounded-xl border-[#202327]/15 bg-white/58 px-4 text-sm text-[#151719] shadow-[inset_0_1px_0_rgba(255,255,255,0.72)] placeholder:text-[#6b6f73] focus-visible:border-[#707b86] focus-visible:bg-white/72 focus-visible:ring-[#8a96a2]/22 min-[1440px]:h-14 min-[1440px]:text-[15px]"
              />
            </label>

            <div className="mt-4">
              <label htmlFor="login-password" className="block text-xs font-medium text-[#303337] min-[1440px]:text-[13px]">密码</label>
              <div className="mt-2 flex h-12 overflow-hidden rounded-xl border border-[#202327]/15 bg-white/58 shadow-[inset_0_1px_0_rgba(255,255,255,0.72)] transition-[border-color,box-shadow,background-color] focus-within:border-[#707b86] focus-within:bg-white/72 focus-within:ring-3 focus-within:ring-[#8a96a2]/22 min-[1440px]:h-14">
                <Input
                  id="login-password"
                  name="password"
                  type={showPassword ? "text" : "password"}
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  autoComplete="current-password"
                  placeholder="请输入密码"
                  className="h-full flex-1 rounded-none border-0 bg-transparent px-4 text-sm text-[#151719] shadow-none placeholder:text-[#6b6f73] focus-visible:border-transparent focus-visible:ring-0 min-[1440px]:text-[15px]"
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={showPassword ? "隐藏输入内容" : "显示输入内容"}
                  aria-pressed={showPassword}
                  onClick={() => setShowPassword((visible) => !visible)}
                  className="h-full w-12 shrink-0 rounded-none text-[#6b6f73] hover:bg-[#151719]/7 hover:text-[#151719] focus-visible:ring-[#8a96a2]/32 motion-reduce:transition-none min-[1440px]:w-14"
                >
                  <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                    <path d="M2.4 12s3.5-6 9.6-6 9.6 6 9.6 6-3.5 6-9.6 6-9.6-6-9.6-6Z" />
                    <circle cx="12" cy="12" r="2.8" />
                    {showPassword && <path d="m4 4 16 16" />}
                  </svg>
                </Button>
              </div>
            </div>

            {error && (
              <p role="alert" className="mt-4 rounded-xl border border-red-800/20 bg-red-50/70 px-3 py-2 text-xs text-red-800">
                {error}
              </p>
            )}

            <Button
              type="submit"
              disabled={submitting || !accountId || !password}
              aria-busy={submitting}
              className="mt-6 h-12 w-full rounded-xl bg-[#121416] text-sm font-semibold tracking-[0.08em] text-white shadow-[0_12px_28px_rgba(18,20,22,0.22)] transition-[transform,background-color,box-shadow] hover:-translate-y-px hover:bg-black hover:shadow-[0_16px_34px_rgba(18,20,22,0.28)] focus-visible:ring-[#8a96a2]/38 active:translate-y-0 disabled:opacity-60 motion-reduce:transform-none motion-reduce:transition-none min-[1440px]:h-14 min-[1440px]:text-[15px]"
            >
              {submitting ? "登录中…" : "登录"}
            </Button>

            <p className="mt-4 text-center text-[11px] leading-5 text-[#686c70] min-[1440px]:text-xs">如需重置密码，请联系管理员</p>
          </form>
        </div>
      </section>
    </main>
  );
}

export function SessionEndedPage({ onContinue }: { onContinue: () => void }) {
  return (
    <main className="flex h-full items-center justify-center bg-[#101214] px-4 text-neutral-200">
      <section className="w-full max-w-sm rounded-2xl border border-[#2b2d30] bg-[#17191c] p-7 shadow-2xl">
        <p className="text-[10px] font-medium uppercase tracking-[0.35em] text-[#9A7333]">GARMENT CANVAS</p>
        <h1 className="mt-3 text-xl font-semibold">账号已在其他设备登录</h1>
        <p className="mt-2 text-sm leading-6 text-neutral-400">
          为保护项目数据，本设备已退出工作区。已绑定当前账号的本机草稿会保留；使用其他账号登录时会安全清除，无法确认归属的旧缓存也不会继续加载。
        </p>
        <button
          type="button"
          onClick={onContinue}
          className="mt-5 w-full rounded-lg bg-[#9A7333] py-2.5 text-sm font-medium text-white hover:bg-[#ae8440]"
        >
          返回登录页
        </button>
      </section>
    </main>
  );
}

export function ChangePasswordPage() {
  const { user } = useAuth();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (newPassword !== confirm) {
      setError("两次输入的新密码不一致");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const response = await fetch("/api/auth/change-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) throw new Error(body.error ?? "修改密码失败");
      if (!user) throw new Error("登录状态已失效");
      broadcastAuthChange(window.localStorage, "auth-changed", user.id);
      suppressWorkspaceUnloadWarning();
      window.location.reload();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="flex h-full items-center justify-center bg-[#101214] px-4 text-neutral-200">
      <form onSubmit={submit} className="w-full max-w-sm rounded-2xl border border-[#2b2d30] bg-[#17191c] p-7 shadow-2xl">
        <h1 className="text-xl font-semibold">首次登录，请修改密码</h1>
        <p className="mt-1 text-xs text-neutral-500">新密码至少 10 位，并同时包含字母和数字。</p>
        {[
          ["当前临时密码", currentPassword, setCurrentPassword, "current-password"],
          ["新密码", newPassword, setNewPassword, "new-password"],
          ["再次输入新密码", confirm, setConfirm, "new-password"],
        ].map(([label, value, setter, auto]) => (
          <label key={label as string} className="mt-4 block space-y-1.5">
            <span className="text-xs text-neutral-400">{label as string}</span>
            <input type="password" value={value as string} onChange={(e) => (setter as (v: string) => void)(e.target.value)}
              autoComplete={auto as string} className="w-full rounded-lg border border-[#34363a] bg-[#0f1113] px-3 py-2.5 text-sm outline-hidden focus:border-[#9A7333]" />
          </label>
        ))}
        {error && <p className="mt-3 text-xs text-red-400">{error}</p>}
        <button type="submit" disabled={submitting || !currentPassword || !newPassword || !confirm}
          className="mt-5 w-full rounded-lg bg-[#9A7333] py-2.5 text-sm font-medium text-white disabled:opacity-50">
          {submitting ? "保存中…" : "修改密码并继续"}
        </button>
      </form>
    </main>
  );
}
