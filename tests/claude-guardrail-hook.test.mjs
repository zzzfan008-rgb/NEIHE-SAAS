import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const hookPath = join(repoRoot, ".claude/hooks/require-linked-worktree.mjs");

function gitPath(flag) {
  return execFileSync("git", ["-C", repoRoot, "rev-parse", "--path-format=absolute", flag], {
    encoding: "utf8",
  }).trim();
}

function runHook(cwd, toolName, toolInput) {
  return spawnSync(process.execPath, [hookPath], {
    cwd: repoRoot,
    encoding: "utf8",
    input: JSON.stringify({ cwd, tool_name: toolName, tool_input: toolInput }),
  });
}

function expectExit(label, result, expected) {
  assert.equal(result.status, expected, `${label}: ${result.stderr || result.stdout}`);
}

function trailingWildcardRuleMatches(rule, command) {
  const match = rule.match(/^Bash\((.*?)(?::\*| \*)\)$/);
  if (!match) return false;
  const prefix = match[1];
  return command === prefix || command.startsWith(`${prefix} `);
}

function createWorktreeFixture() {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "garment-canvas-hook-worktree-"));
  const primary = join(fixtureRoot, "primary");
  const linked = join(fixtureRoot, "linked");
  mkdirSync(primary);
  execFileSync("git", ["init", "--initial-branch=main", primary], { stdio: "ignore" });
  execFileSync("git", ["-C", primary, "commit", "--allow-empty", "-m", "test fixture"], {
    stdio: "ignore",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Guardrail Test",
      GIT_AUTHOR_EMAIL: "guardrail@example.invalid",
      GIT_COMMITTER_NAME: "Guardrail Test",
      GIT_COMMITTER_EMAIL: "guardrail@example.invalid",
    },
  });
  execFileSync("git", ["-C", primary, "worktree", "add", "-b", "linked-test", linked], { stdio: "ignore" });
  return { fixtureRoot, linked, primary };
}

const commonGitDir = gitPath("--git-common-dir");
const primaryRoot = dirname(commonGitDir);
const settings = JSON.parse(readFileSync(join(repoRoot, ".claude/settings.json"), "utf8"));

const preToolUseMatchers = settings.hooks.PreToolUse.map(({ matcher }) => matcher.split("|")).flat();
for (const toolName of ["Write", "Edit", "Bash", "Read", "Grep", "Glob", "NotebookEdit"]) {
  assert.equal(preToolUseMatchers.includes(toolName), true, `${toolName} must be covered by the guardrail hook matcher`);
}

for (const command of [
  "git push origin main",
  "gh pr create --title blocked",
  "git merge feature",
  "git rebase main",
  "git cherry-pick deadbeef",
  "git reset --hard HEAD~1",
  "git clean -fd",
  "npm install package-name",
  "npm ci --ignore-scripts",
  "pnpm install package-name",
  "yarn install package-name",
  "bun install package-name",
]) {
  assert.equal(
    settings.permissions.deny.some((rule) => trailingWildcardRuleMatches(rule, command)),
    true,
    `${command} must match a documented trailing-wildcard Bash deny rule`,
  );
}

const primaryWrite = runHook(primaryRoot, "Write", { file_path: join(primaryRoot, "blocked.txt") });
expectExit("primary Write", primaryWrite, 2);
assert.doesNotMatch(primaryWrite.stderr, /^\s*\{/, "exit-2 denial should be a readable plain-text reason");
expectExit(
  "primary reviews Write",
  runHook(primaryRoot, "Write", { file_path: join(primaryRoot, "reviews", "blocked.md") }),
  2,
);
expectExit("Read .env", runHook(primaryRoot, "Read", { file_path: join(primaryRoot, ".env") }), 2);
expectExit(
  "Read public .env.example",
  runHook(primaryRoot, "Read", { file_path: join(primaryRoot, ".env.example") }),
  0,
);
expectExit(
  "Read private .env.example.local",
  runHook(primaryRoot, "Read", { file_path: join(primaryRoot, ".env.example.local") }),
  2,
);
expectExit("Grep .env", runHook(primaryRoot, "Grep", { path: ".env", pattern: "KEY" }), 2);
expectExit("Glob .env", runHook(primaryRoot, "Glob", { path: ".", pattern: "**/.env*" }), 2);
expectExit(
  "primary NotebookEdit",
  runHook(primaryRoot, "NotebookEdit", { notebook_path: join(primaryRoot, "blocked.ipynb") }),
  2,
);
expectExit("ordinary Read", runHook(primaryRoot, "Read", { file_path: join(primaryRoot, "AGENTS.md") }), 0);
expectExit("ordinary Grep", runHook(primaryRoot, "Grep", { path: "src", pattern: "canvas" }), 0);
expectExit("ordinary Glob", runHook(primaryRoot, "Glob", { path: "src", pattern: "**/*.ts" }), 0);
expectExit("read-only git", runHook(primaryRoot, "Bash", { command: "git status --short" }), 0);
for (const [label, command] of [
  ["sed write command", "sed -n '1w /tmp/x' AGENTS.md"],
  ["sed execute command", "sed -n '1e touch /tmp/x' AGENTS.md"],
  ["git grep pager command", "git grep -O touch canvas"],
  ["git grep long pager command", "git grep --open-files-in-pager=touch canvas"],
  ["secret suffix glob", "cat *.env"],
  ["secret brace expansion", "cat .env{,}"],
  ["secret partial glob", "cat .e*"],
  ["leading environment assignment", "FOO=bar git status --short"],
  ["variable expansion", "p=push; git $p origin main"],
  ["braced variable expansion", "p=push; git ${p} origin main"],
  ["command substitution", "git $(printf push) origin main"],
  ["backtick substitution", "git `printf push` origin main"],
]) {
  expectExit(label, runHook(primaryRoot, "Bash", { command }), 2);
}

const worktreeFixture = createWorktreeFixture();
try {
  expectExit(
    "linked in-root Write",
    runHook(worktreeFixture.linked, "Write", { file_path: join(worktreeFixture.linked, "tmp/allowed.txt") }),
    0,
  );
  expectExit(
    "linked Write into primary",
    runHook(worktreeFixture.linked, "Write", { file_path: join(worktreeFixture.primary, "blocked-from-linked.txt") }),
    2,
  );
  expectExit(
    "linked Write into primary reviews",
    runHook(worktreeFixture.linked, "Write", { file_path: join(worktreeFixture.primary, "reviews", "blocked.md") }),
    2,
  );
  for (const command of ["cat .e*", "cat .en*", "cat .?nv", "cat .[e]nv"]) {
    expectExit(
      `linked sensitive glob: ${command}`,
      runHook(worktreeFixture.linked, "Bash", { command }),
      2,
    );
  }
  expectExit(
    "linked non-sensitive hidden-file glob",
    runHook(worktreeFixture.linked, "Bash", { command: "cat .eslint*" }),
    0,
  );

  const insideRoot = join(worktreeFixture.linked, "tmp", `guardrail-hook-${process.pid}`);
  const outsideRoot = join(worktreeFixture.fixtureRoot, "outside");
  mkdirSync(insideRoot, { recursive: true });
  mkdirSync(outsideRoot);
  symlinkSync(outsideRoot, join(insideRoot, "escape"));
  expectExit(
    "linked Write through escaping symlink",
    runHook(worktreeFixture.linked, "Write", { file_path: join(insideRoot, "escape", "blocked.txt") }),
    2,
  );
} finally {
  rmSync(worktreeFixture.fixtureRoot, { recursive: true, force: true });
}

console.log("Claude guardrail hook tests passed");
