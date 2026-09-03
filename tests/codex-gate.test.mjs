import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  realpathSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const source = new URL("../scripts/codex-gate.mjs", import.meta.url);
const fixtureRoots = new Set();

function cleanupFixtures() {
  for (const root of fixtureRoots) rmSync(root, { recursive: true, force: true });
  fixtureRoots.clear();
}

process.once("exit", cleanupFixtures);

function command(cwd, executable, args, env = process.env) {
  return spawnSync(executable, args, { cwd, env, encoding: "utf8" });
}

function git(cwd, ...args) {
  const result = command(cwd, "git", args);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function fixture({ requiredNodeVersion = process.versions.node } = {}) {
  const root = mkdtempSync(join(tmpdir(), "codex-gate-test-"));
  fixtureRoots.add(root);
  const bin = join(root, "bin");
  mkdirSync(join(root, "scripts"));
  mkdirSync(bin);
  const gateSource = readFileSync(source, "utf8").replace(
    'const REQUIRED_NODE_VERSION = "22.20.0";',
    `const REQUIRED_NODE_VERSION = ${JSON.stringify(requiredNodeVersion)};`,
  );
  writeFileSync(join(root, "scripts/codex-gate.mjs"), gateSource);
  writeFileSync(
    join(root, ".gitignore"),
    ".gate-npm-log\n.gate-gitnexus-log\n.gate-codex-log\n",
  );
  writeFileSync(join(root, "tracked.txt"), "initial\n");
  writeFileSync(
    join(bin, "npm"),
    '#!/bin/sh\nif [ -n "$GATE_NPM_LOG" ]; then printf \'%s\\n\' "$*" >> "$GATE_NPM_LOG"; fi\nexit 0\n',
  );
  writeFileSync(
    join(bin, "codex"),
    `#!/bin/sh
out=""
if [ -n "$GATE_CODEX_LOG" ]; then
  for arg in "$@"; do printf '%s\\n' "$arg" >> "$GATE_CODEX_LOG"; done
fi
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--output-last-message" ]; then out="$2"; shift 2; else shift; fi
done
if [ -n "$GATE_MUTATE_FILE" ]; then printf '%s\\n' mutation >> "$GATE_MUTATE_FILE"; fi
if [ -n "$GATE_CODEX_EXIT" ]; then exit "$GATE_CODEX_EXIT"; fi
review_json="$GATE_REVIEW_JSON"
if [ -z "$review_json" ]; then
  review_json='{"verdict":"pass","summary":"ok","findings":[],"gitnexus":{"status":"pass","evidence":"test"}}'
fi
printf '%s\\n' "$review_json" > "$out"
if [ -n "$GATE_BREAK_REPO" ]; then mv "$GATE_BREAK_REPO/.git" "$GATE_BREAK_REPO/.git-broken"; fi
`,
  );
  writeFileSync(
    join(bin, "gitnexus"),
    `#!/bin/sh
if [ -n "$GATE_GITNEXUS_LOG" ]; then printf '%s\\n' "$*" >> "$GATE_GITNEXUS_LOG"; fi
if [ -n "$GATE_GITNEXUS_EXIT" ]; then exit "$GATE_GITNEXUS_EXIT"; fi
if [ "$GITNEXUS_LANG" = "en" ]; then
  if [ "$1" = "status" ]; then
    printf '%s\\n' 'Indexed commit: test' 'Current commit: test' 'Status: ✅ up-to-date'
  else
    printf '%s\\n' 'Changes: 1 files, 1 symbols' 'Affected processes: 0' 'Risk level: low'
  fi
elif [ "$1" = "status" ]; then
  printf '%s\\n' '索引提交: test' '当前提交: test' '状态: ✅ 已是最新'
else
  printf '%s\\n' '变更：1 个文件，1 个符号' '受影响流程：0' '风险等级：low'
fi
`,
  );
  chmodSync(join(bin, "npm"), 0o755);
  chmodSync(join(bin, "codex"), 0o755);
  chmodSync(join(bin, "gitnexus"), 0o755);
  git(root, "init", "-q");
  git(root, "config", "user.email", "gate@example.test");
  git(root, "config", "user.name", "Gate Test");
  git(root, "add", ".");
  git(root, "commit", "-qm", "initial");
  const base = git(root, "rev-parse", "HEAD");
  const initialBranch = git(root, "branch", "--show-current");
  return { root, base, initialBranch, env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } };
}

function gateTempDirs() {
  return readdirSync(tmpdir())
    .filter((name) => name.startsWith("garment-canvas-codex-gate-"))
    .sort();
}

{
  const f = fixture();
  git(f.root, "checkout", "-qb", "other", f.base);
  writeFileSync(join(f.root, "other.txt"), "other\n");
  git(f.root, "add", "other.txt");
  git(f.root, "commit", "-qm", "other branch");
  const divergentBase = git(f.root, "rev-parse", "HEAD");
  git(f.root, "checkout", "-q", f.initialBranch);
  writeFileSync(join(f.root, "tracked.txt"), "candidate\n");
  git(f.root, "add", "tracked.txt");
  git(f.root, "commit", "-qm", "candidate");
  const result = runGate(f, "--base", divergentBase);
  assert.notEqual(result.status, 0, "--base 必须拒绝不是 HEAD 祖先的分叉基线");
}

function runGate(f, ...args) {
  return command(f.root, process.execPath, ["scripts/codex-gate.mjs", ...args], f.env);
}

{
  const f = fixture({ requiredNodeVersion: "0.0.0-test" });
  const result = runGate(f, "--uncommitted");
  assert.notEqual(result.status, 0, "门禁必须拒绝不是 Node.js 22.20.0 的运行时");
  assert.match(result.stderr, /最低受支持的 Node\.js/);
}

{
  const f = fixture();
  writeFileSync(join(f.root, "tracked.txt"), "bad trailing whitespace   \n");
  git(f.root, "add", "tracked.txt");
  git(f.root, "commit", "-qm", "bad commit");
  const result = runGate(f, "--base", f.base);
  assert.notEqual(result.status, 0, "--base 必须检查所选已提交差异的空白错误");
}

{
  const f = fixture();
  writeFileSync(join(f.root, "tracked.txt"), "bad staged whitespace   \n");
  git(f.root, "add", "tracked.txt");
  const result = runGate(f, "--uncommitted");
  assert.notEqual(result.status, 0, "--uncommitted 必须检查 staged 差异");
}

{
  const f = fixture();
  writeFileSync(join(f.root, "untracked.txt"), "bad untracked whitespace   \n");
  const result = runGate(f, "--uncommitted");
  assert.notEqual(result.status, 0, "--uncommitted 必须检查 untracked 文件");
}

{
  const f = fixture();
  writeFileSync(join(f.root, "tracked.txt"), "valid change\n");
  const result = runGate(f, "--uncommitted");
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /Codex verdict: pass/);
}

{
  const f = fixture();
  writeFileSync(join(f.root, "tracked.txt"), "committed candidate\n");
  git(f.root, "add", "tracked.txt");
  git(f.root, "commit", "-qm", "candidate");
  const npmLog = join(f.root, ".gate-npm-log");
  const gitNexusLog = join(f.root, ".gate-gitnexus-log");
  const codexLog = join(f.root, ".gate-codex-log");
  f.env.GATE_NPM_LOG = npmLog;
  f.env.GATE_GITNEXUS_LOG = gitNexusLog;
  f.env.GATE_CODEX_LOG = codexLog;
  f.env.GITNEXUS_LANG = "zh-CN";
  const result = runGate(f, "--base", f.base);
  assert.equal(result.status, 0, `最终 clean-HEAD 门禁应通过：${result.stdout}\n${result.stderr}`);
  assert.deepEqual(
    readFileSync(npmLog, "utf8").trim().split("\n"),
    ["ci", "run check", "run test:e2e", "run build", "run test:e2e:production"],
    "完整门禁必须先执行 npm ci，再按固定顺序执行验证套件",
  );
  assert.deepEqual(
    readFileSync(gitNexusLog, "utf8").trim().split("\n"),
    ["status", `detect-changes --scope compare --repo ${realpathSync(f.root)} --base-ref ${f.base}`],
    "完整门禁必须独立验证 GitNexus 索引并绑定所选 base..HEAD 范围",
  );
  const codexArgs = readFileSync(codexLog, "utf8").trim().split("\n");
  const approvalIndex = codexArgs.indexOf("--ask-for-approval");
  const sandboxIndex = codexArgs.indexOf("--sandbox");
  const schemaIndex = codexArgs.indexOf("--output-schema");
  assert.equal(codexArgs[approvalIndex + 1], "never", "Codex 审查必须禁用交互式授权");
  assert.equal(codexArgs[sandboxIndex + 1], "read-only", "Codex 审查必须使用只读沙箱");
  assert.ok(schemaIndex >= 0 && codexArgs[schemaIndex + 1], "Codex 审查必须提供输出 schema");
  assert.ok(!codexArgs.includes("--model"), "Codex 审查不得覆盖用户配置的默认模型");
}

{
  const f = fixture();
  writeFileSync(join(f.root, "inherited.txt"), "pre-existing whitespace   \n");
  git(f.root, "add", "inherited.txt");
  git(f.root, "commit", "-qm", "pre-existing parent");
  const parent = git(f.root, "rev-parse", "HEAD");
  writeFileSync(join(f.root, "tracked.txt"), "single commit candidate\n");
  git(f.root, "add", "tracked.txt");
  git(f.root, "commit", "-qm", "single commit candidate");
  const candidate = git(f.root, "rev-parse", "HEAD");

  const exactResult = runGate(f, "--commit", candidate);
  assert.equal(
    exactResult.status,
    0,
    `--commit 必须只审查所选 HEAD 的父提交差异：${exactResult.stdout}\n${exactResult.stderr}`,
  );

  const staleResult = runGate(f, "--commit", parent);
  assert.notEqual(staleResult.status, 0, "--commit 必须拒绝不等于当前 HEAD 的旧提交");
}

for (const review of [
  { verdict: "fail", summary: "failed", findings: [], gitnexus: { status: "pass", evidence: "test" } },
  {
    verdict: "pass",
    summary: "finding",
    findings: [
      { severity: "P2", title: "blocking", file: "x.js", line: 1, reason: "test" },
    ],
    gitnexus: { status: "pass", evidence: "test" },
  },
  {
    verdict: "pass",
    summary: "degraded",
    findings: [],
    gitnexus: { status: "degraded", evidence: "test" },
  },
]) {
  const f = fixture();
  f.env.GATE_REVIEW_JSON = JSON.stringify(review);
  const result = runGate(f, "--uncommitted", "--review-only");
  assert.notEqual(result.status, 0, `审查阻断矩阵必须失败：${JSON.stringify(review)}`);
}

{
  const f = fixture();
  writeFileSync(join(f.root, "tracked.txt"), "valid change\n");
  f.env.GATE_MUTATE_FILE = join(f.root, "tracked.txt");
  const result = runGate(f, "--uncommitted", "--review-only");
  assert.notEqual(result.status, 0, "Codex 审查期间发生工作树变化时必须作废结果");
}

{
  const f = fixture();
  f.env.GATE_GITNEXUS_EXIT = "9";
  const result = runGate(f, "--uncommitted", "--review-only");
  assert.notEqual(result.status, 0, "GitNexus CLI 检查失败时不得仅信任模型自报结果");
}

{
  const f = fixture();
  const before = gateTempDirs();
  f.env.GATE_CODEX_EXIT = "7";
  const result = runGate(f, "--uncommitted", "--review-only");
  assert.notEqual(result.status, 0, "Codex 进程失败必须阻断门禁");
  assert.deepEqual(gateTempDirs(), before, "Codex 进程失败后必须清理门禁临时目录");
}

{
  const f = fixture();
  const before = gateTempDirs();
  f.env.GATE_BREAK_REPO = f.root;
  const result = runGate(f, "--uncommitted", "--review-only");
  assert.notEqual(result.status, 0, "Codex 审查后的 Git 读取失败必须阻断门禁");
  assert.deepEqual(gateTempDirs(), before, "审查后的 Git 读取失败仍必须清理门禁临时目录");
}

const roots = [...fixtureRoots];
cleanupFixtures();
assert.ok(roots.every((root) => !existsSync(root)), "Codex 门禁测试必须清理所有临时 Git fixture");

console.log(
  "  ✓ Codex 门禁覆盖 Node 下限、npm ci 锁定安装、GitNexus 独立证据、clean-HEAD、--commit 精确范围、差异范围、阻断矩阵、状态漂移与临时目录清理",
);
