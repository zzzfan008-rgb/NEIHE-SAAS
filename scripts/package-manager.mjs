import { spawnSync } from "node:child_process";
import { basename } from "node:path";

function executableExists(command) {
  const probe = process.platform === "win32"
    ? spawnSync("where.exe", [command], { stdio: "ignore" })
    : spawnSync("sh", ["-c", `command -v ${command}`], { stdio: "ignore" });
  return !probe.error && probe.status === 0;
}

function packageManagerKind(env, executable) {
  const userAgent = env.npm_config_user_agent ?? "";
  if (userAgent.startsWith("pnpm/") || basename(executable).startsWith("pnpm")) return "pnpm";
  return "npm";
}

export function resolvePackageManager(env = process.env) {
  const execPath = env.npm_execpath?.trim();
  if (execPath) {
    const kind = packageManagerKind(env, execPath);
    return {
      kind,
      command: process.execPath,
      prefix: [execPath],
    };
  }

  const candidates = process.platform === "win32"
    ? [
        { kind: "npm", command: "npm.cmd" },
        { kind: "pnpm", command: "pnpm.cmd" },
      ]
    : [
        { kind: "npm", command: "npm" },
        { kind: "pnpm", command: "pnpm" },
      ];
  const selected = candidates.find(({ command }) => executableExists(command));
  if (!selected) {
    throw new Error("Unable to find npm or pnpm; install a supported package manager or set npm_execpath");
  }
  return { ...selected, prefix: [] };
}

export function packageManagerCommand(args, env = process.env) {
  const manager = resolvePackageManager(env);
  return {
    ...manager,
    args: [...manager.prefix, ...args],
  };
}

export function packageManagerRunArgs(script, env = process.env, extraArgs = []) {
  return packageManagerCommand(["run", script, ...extraArgs], env);
}

export function packageManagerExecArgs(args, env = process.env) {
  return packageManagerCommand(["exec", "--", ...args], env);
}

export function packageManagerInstallArgs(env = process.env) {
  const manager = resolvePackageManager(env);
  return {
    ...manager,
    args: [...manager.prefix, ...(manager.kind === "pnpm" ? ["install", "--frozen-lockfile"] : ["ci"])],
  };
}
