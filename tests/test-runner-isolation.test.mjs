import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { acquireTestLock, createComposeProjectName } from "../scripts/test-with-postgres.mjs";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const runnerPath = join(repoRoot, "scripts/test-with-postgres.mjs");

const packageManifest = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
const registeredSuite = packageManifest.scripts?.["test:suite"] ?? "";
const unregisteredTypeScriptTests = readdirSync(join(repoRoot, "tests"))
  .filter((name) => name.endsWith(".test.ts"))
  .filter((name) => !registeredSuite.includes(`tests/${name}`))
  .sort();
assert.deepEqual(
  unregisteredTypeScriptTests,
  [],
  `every TypeScript contract test must be registered in test:suite; missing: ${unregisteredTypeScriptTests.join(", ")}`,
);

function readComposeConfig(projectName) {
  const args = ["compose"];
  if (projectName) args.push("--project-name", projectName);
  args.push("-f", join(repoRoot, "compose.test.yaml"), "config", "--format", "json");
  const env = { ...process.env };
  delete env.COMPOSE_PROJECT_NAME;
  return JSON.parse(execFileSync("docker", args, { cwd: repoRoot, encoding: "utf8", env }));
}

function writeCommandShim(path) {
  writeFileSync(
    path,
    `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const { basename } = require("node:path");
appendFileSync(
  process.env.RUNNER_CALL_LOG,
  JSON.stringify({ command: basename(process.argv[1]), args: process.argv.slice(2) }) + "\\n",
);
`,
    "utf8",
  );
  chmodSync(path, 0o755);
}

const first = createComposeProjectName({ cwd: "/tmp/worktree-a" });
const second = createComposeProjectName({ cwd: "/tmp/worktree-b" });
const repeat = createComposeProjectName({ cwd: "/tmp/worktree-a" });

assert.match(first, /^garment-canvas-test-[a-f0-9]{10}$/);
assert.equal(first, repeat, "the same worktree must reuse its Compose project after a crash");
assert.notEqual(first, second, "different worktrees must use different Compose projects");

const defaultComposeConfig = readComposeConfig();
assert.equal(
  defaultComposeConfig.name,
  "garment-canvas-test",
  "a bare compose.test.yaml command must never target the development Compose project",
);
const overriddenComposeConfig = readComposeConfig(first);
assert.equal(
  overriddenComposeConfig.name,
  first,
  "the runner's explicit project name must override compose.test.yaml's safe default",
);

const lockRoot = join(tmpdir(), `garment-canvas-lock-test-${process.pid}`);
mkdirSync(lockRoot, { recursive: true });
try {
  const release = acquireTestLock({
    projectName: first,
    lockRoot,
    isProcessActive: () => true,
  });
  assert.throws(
    () => acquireTestLock({ projectName: first, lockRoot, isProcessActive: () => true }),
    /Another PostgreSQL test run is active/,
    "a second run in the same worktree must fail before touching the active Compose project",
  );
  release();

  const staleLock = join(lockRoot, `${first}.lock`);
  writeFileSync(staleLock, "999999\n", "utf8");
  const releaseAfterCrash = acquireTestLock({
    projectName: first,
    lockRoot,
    isProcessActive: () => false,
  });
  assert.equal(existsSync(staleLock), true, "a stale lock must be replaced by the current run");
  releaseAfterCrash();
  assert.equal(existsSync(staleLock), false, "the current run must release its lock");
} finally {
  rmSync(lockRoot, { recursive: true, force: true });
}

const symlinkTestRoot = mkdtempSync(join(tmpdir(), "garment-canvas-runner-symlink-"));
try {
  const shimDir = join(symlinkTestRoot, "bin");
  const runnerCwd = join(symlinkTestRoot, "runner-cwd");
  const runnerSymlink = join(symlinkTestRoot, "postgres-test-runner.mjs");
  const callLog = join(symlinkTestRoot, "calls.jsonl");
  mkdirSync(shimDir);
  mkdirSync(runnerCwd);
  symlinkSync(process.execPath, join(shimDir, "node"));
  writeCommandShim(join(shimDir, "docker"));
  writeCommandShim(join(shimDir, process.platform === "win32" ? "npm.cmd" : "npm"));
  symlinkSync(runnerPath, runnerSymlink);

  const result = spawnSync(process.execPath, [runnerSymlink], {
    cwd: runnerCwd,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${shimDir}:${process.env.PATH ?? ""}`,
      npm_execpath: "",
      RUNNER_CALL_LOG: callLog,
    },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);

  const calls = readFileSync(callLog, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  const dockerCalls = calls.filter(({ command }) => command === "docker");
  const npmCalls = calls.filter(({ command }) => basename(command).startsWith("npm"));
  assert.equal(dockerCalls.length, 3, "a symlinked runner must perform initial cleanup, startup, and final cleanup");
  assert.deepEqual(npmCalls.map(({ args }) => args), [["run", "test:suite"]]);
  assert.equal(dockerCalls.some(({ args }) => args.includes("up")), true, "the symlinked runner must start PostgreSQL");

  const expectedProject = createComposeProjectName({ cwd: realpathSync(runnerCwd) });
  for (const { args } of dockerCalls) {
    const projectNameIndex = args.indexOf("--project-name") + 1;
    assert.equal(args[projectNameIndex], expectedProject, "every lifecycle call must use the stable worktree project");
  }
} finally {
  rmSync(symlinkTestRoot, { recursive: true, force: true });
}

console.log("test runner isolation tests passed");
