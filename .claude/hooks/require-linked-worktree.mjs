import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { basename, resolve, sep } from "node:path";

function deny(message) {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

function gitPath(cwd, ...args) {
  try {
    return realpathSync(execFileSync("git", ["-C", cwd, "rev-parse", "--path-format=absolute", ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim());
  } catch {
    return null;
  }
}

function isLinkedWorktree(cwd) {
  const root = gitPath(cwd, "--show-toplevel");
  const commonDir = gitPath(cwd, "--git-common-dir");
  const gitDir = gitPath(cwd, "--git-dir");
  if (!root || !commonDir || !gitDir) return null;
  return gitDir !== commonDir;
}

function pathLooksSensitive(value) {
  const normalized = value.replaceAll("\\", "/");
  const segments = normalized.split("/").filter(Boolean);
  return segments.some((segment) => {
    if (segment === ".secrets" || segment.startsWith(".secrets.")) return true;
    if (segment === ".env.example") return false;
    return segment === ".env" || segment.startsWith(".env.");
  });
}

function containsSensitivePath(value) {
  if (typeof value !== "string" || !value) return false;
  if (pathLooksSensitive(value)) return true;
  return /(?:^|[\s/'"])(?:\.e\*|\.en\*|\.\?nv|\.\[e\]nv|\*\.env|\.env(?:\{[^}]*\}|[*?\[]))(?:$|[\s/'"])/.test(value);
}

function realpathNearestExisting(path) {
  let candidate = path;
  while (!existsSync(candidate)) {
    const parent = resolve(candidate, "..");
    if (parent === candidate) return null;
    candidate = parent;
  }
  return realpathSync(candidate);
}

function forbiddenBashReason(command) {
  if (containsSensitivePath(command)) {
    return "Access to private .env or .secrets files is blocked; use .env.example as the public contract.";
  }

  const normalized = command.trim();
  const forbidden = [
    [/\bgit\s+push\b/, "git push is blocked by the repository guardrail."],
    [/\bgh\s+pr\s+create\b/, "Creating pull requests is blocked by the repository guardrail."],
    [/\bgit\s+merge\b/, "git merge is blocked by the repository guardrail."],
    [/\bgit\s+rebase\b/, "git rebase is blocked by the repository guardrail."],
    [/\bgit\s+cherry-pick\b/, "git cherry-pick is blocked by the repository guardrail."],
    [/\bgit\s+reset\s+--hard\b/, "git reset --hard is blocked by the repository guardrail."],
    [/\bgit\s+clean\b/, "git clean is blocked by the repository guardrail."],
    [/\b(?:npm|pnpm|yarn|bun)\s+(?:install|ci)\b/, "Dependency installation is blocked by the repository guardrail."],
  ];
  for (const [pattern, reason] of forbidden) {
    if (pattern.test(normalized)) return reason;
  }
  return null;
}

function isReadOnlySegment(segment) {
  const trimmed = segment.trim();
  if (!trimmed || /[$`]|(^|\s)[A-Za-z_][A-Za-z0-9_]*=/.test(trimmed)) return false;
  if (/\b(?:sed|awk|perl)\b.*(?:\d+[we](?:\s|['"]|$)|(?:^|\s)-i(?:\s|$))/.test(trimmed)) return false;
  return /^(?:git\s+(?:status|diff|log|show|rev-parse|branch)|(?:rg|ls|pwd|find|head|tail|wc|sort|cat|sed)\b)/.test(trimmed);
}

function isReadOnlyBash(command) {
  if (forbiddenBashReason(command)) return false;
  if (/[;&|<>]/.test(command)) return false;
  return command.split(/\n/).every(isReadOnlySegment);
}

const input = JSON.parse(await new Response(process.stdin).text());
const cwd = typeof input.cwd === "string" && input.cwd ? input.cwd : process.cwd();
const toolName = input.tool_name;
const toolInput = input.tool_input ?? {};
const writeTools = new Set(["Write", "Edit", "NotebookEdit"]);
const readOnlyTools = new Set(["Read", "Grep", "Glob"]);

for (const candidate of [toolInput.file_path, toolInput.notebook_path, toolInput.path, toolInput.pattern]) {
  if (typeof candidate === "string" && containsSensitivePath(candidate)) {
    deny("Access to private .env or .secrets files is blocked; use .env.example as the public contract.");
  }
}

if (readOnlyTools.has(toolName)) process.exit(0);

if (toolName === "Bash") {
  if (typeof toolInput.command !== "string") deny("A Bash tool call without a command is blocked.");
  const linked = isLinkedWorktree(cwd);
  const reason = forbiddenBashReason(toolInput.command);
  if (reason) deny(reason);
  if (linked === null) deny("Claude could not verify that the current directory is a git worktree.");
  if (linked === true) process.exit(0);
  if (!isReadOnlyBash(toolInput.command)) {
    deny("Only a conservative read-only Bash allowlist is available in the primary worktree. Use Read/Grep/GitNexus, or restart with claude --worktree <task-name>.");
  }
  process.exit(0);
}

if (writeTools.has(toolName)) {
  const linked = isLinkedWorktree(cwd);
  if (linked !== true) deny("The primary worktree is audit-only. Restart with: claude --worktree <task-name>");
  const root = gitPath(cwd, "--show-toplevel");
  const rawTarget = toolInput.file_path ?? toolInput.notebook_path;
  if (!root || typeof rawTarget !== "string" || !rawTarget) deny("A write target could not be verified.");
  const target = resolve(cwd, rawTarget);
  const targetParent = realpathNearestExisting(resolve(target, ".."));
  const canonicalTarget = targetParent ? resolve(targetParent, basename(target)) : null;
  if (!canonicalTarget || !(canonicalTarget === root || canonicalTarget.startsWith(`${root}${sep}`))) {
    deny("Writes must stay inside the current linked worktree.");
  }
  if (existsSync(target)) {
    const resolvedTarget = realpathSync(target);
    if (!(resolvedTarget === root || resolvedTarget.startsWith(`${root}${sep}`))) {
      deny("Writes must stay inside the current linked worktree.");
    }
  }
  process.exit(0);
}

process.exit(0);
