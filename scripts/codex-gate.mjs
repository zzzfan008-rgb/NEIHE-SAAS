import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { packageManagerCommand, packageManagerInstallArgs, packageManagerRunArgs } from "./package-manager.mjs";

const REQUIRED_NODE_VERSION = "22.20.0";

const REVIEW_SCHEMA = {
  type: "object",
  description:
    "Final merge-gate review result. Fail for any actionable P0-P3 correctness, security, data-loss, authorization, paid-provider, document-isolation, regression, or missing-test finding. Pass only with an empty findings array.",
  additionalProperties: false,
  required: ["verdict", "summary", "findings", "gitnexus"],
  properties: {
    verdict: { type: "string", enum: ["pass", "fail"] },
    summary: { type: "string" },
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["severity", "title", "file", "line", "reason"],
        properties: {
          severity: { type: "string", enum: ["P0", "P1", "P2", "P3"] },
          title: { type: "string" },
          file: { type: "string" },
          line: { type: "integer", minimum: 0 },
          reason: { type: "string" },
        },
      },
    },
    gitnexus: {
      type: "object",
      additionalProperties: false,
      required: ["status", "evidence"],
      properties: {
        status: { type: "string", enum: ["pass", "fail", "degraded"] },
        evidence: { type: "string" },
      },
    },
  },
};

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: "inherit", ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const error = new Error(`${command} ${args.join(" ")} exited with ${result.status ?? 1}`);
    error.exitCode = result.status ?? 1;
    throw error;
  }
}

function checkSelectedDiff(selection) {
  if (selection.finalEvidence) {
    run("git", ["diff", "--check", `${selection.baseSha}..${selection.headSha}`, "--"]);
    return;
  }

  run("git", ["diff", "--check", "HEAD", "--"]);
  const untracked = output("git", ["ls-files", "--others", "--exclude-standard", "-z"]);
  for (const path of untracked.split("\0").filter(Boolean)) {
    const result = spawnSync("git", ["diff", "--no-index", "--check", "/dev/null", path], {
      stdio: "inherit",
    });
    if (result.error) throw result.error;
    // --no-index returns 1 for a clean textual difference and 3 for whitespace errors.
    if (result.status !== 0 && result.status !== 1) process.exit(result.status ?? 1);
  }
}

function output(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    process.stderr.write(result.stderr || "");
    const error = new Error(`${command} ${args.join(" ")} exited with ${result.status ?? 1}`);
    error.exitCode = result.status ?? 1;
    throw error;
  }
  return result.stdout.trim();
}

function succeeds(command, args) {
  const result = spawnSync(command, args, { stdio: "ignore" });
  if (result.error) throw result.error;
  return result.status === 0;
}

function gitNexusOutput(args) {
  return output("gitnexus", args, {
    env: { ...process.env, GITNEXUS_LANG: "en" },
  });
}

function verifyGitNexus(selection) {
  const status = gitNexusOutput(["status"]);
  if (!/Status:\s+.*up-to-date/.test(status)) {
    throw new Error(`GitNexus 索引未与当前 HEAD 对齐：\n${status}`);
  }

  const args = [
    "detect-changes",
    "--scope",
    selection.finalEvidence ? "compare" : "all",
    "--repo",
    process.cwd(),
  ];
  if (selection.finalEvidence) args.push("--base-ref", selection.baseSha);
  const evidence = gitNexusOutput(args);
  if (!/^Changes: .+$/m.test(evidence) || !/^Affected processes: \d+$/m.test(evidence) || !/^Risk level: .+$/m.test(evidence)) {
    throw new Error(`GitNexus detect-changes 未返回完整的可验证证据：\n${evidence}`);
  }
  console.log(`GitNexus deterministic check:\n${evidence}`);
  return evidence;
}

function workspaceSnapshot() {
  const status = output("git", ["status", "--porcelain=v1", "--untracked-files=all"]);
  const trackedDiff = output("git", ["diff", "--binary", "HEAD", "--"]);
  const untracked = output("git", ["ls-files", "--others", "--exclude-standard", "-z"])
    .split("\0")
    .filter(Boolean)
    .map((path) => [path, output("git", ["hash-object", path])]);
  return JSON.stringify({ status, trackedDiff, untracked });
}

function reviewSelection(args) {
  const selected = ["--base", "--commit", "--uncommitted"].filter((arg) => args.includes(arg));
  if (selected.length > 1) throw new Error("--base、--commit 与 --uncommitted 只能选择一个");

  if (args.includes("--uncommitted")) {
    return { label: "uncommitted changes against HEAD", finalEvidence: false };
  }

  const commitIndex = args.indexOf("--commit");
  if (commitIndex >= 0) {
    if (!args[commitIndex + 1]) throw new Error("--commit 需要一个 Git ref");
    const sha = output("git", ["rev-parse", args[commitIndex + 1]]);
    return { label: `commit ${sha}`, finalEvidence: true, headSha: sha, baseSha: `${sha}^` };
  }

  const baseIndex = args.indexOf("--base");
  const base = baseIndex >= 0 ? args[baseIndex + 1] : "origin/main";
  if (!base) throw new Error("--base 需要一个 Git ref");
  if (base === "origin/main") run("git", ["fetch", "--quiet", "origin", "main"]);
  const selection = {
    label: `diff ${base}..HEAD`,
    finalEvidence: true,
    headSha: output("git", ["rev-parse", "HEAD"]),
    baseSha: output("git", ["rev-parse", base]),
  };
  if (!succeeds("git", ["merge-base", "--is-ancestor", selection.baseSha, selection.headSha])) {
    throw new Error(`${base} 不是当前 HEAD 的祖先；请先更新分支并在实际集成结果上重新运行门禁`);
  }
  return selection;
}

if (process.argv.includes("--help")) {
  console.log(`Usage: pnpm run gate:codex -- [--base REF | --commit SHA | --uncommitted] [--review-only]

Runs deterministic local verification, then an exact-diff structured Codex exec review. The review intentionally
omits --model so Codex uses the user's configured default model. Any P0-P3 finding fails the gate.
--review-only reruns only the model stage for gate maintenance and is not complete gate evidence.`);
  process.exit(0);
}

if (!process.argv.includes("--review-only") && process.versions.node !== REQUIRED_NODE_VERSION) {
  throw new Error(
    `Codex 门禁必须在最低受支持的 Node.js ${REQUIRED_NODE_VERSION} 上运行；当前为 ${process.versions.node}。请先执行 nvm use。`,
  );
}

const selection = reviewSelection(process.argv.slice(2));
console.log(`Codex local gate: ${selection.label}`);

const initialHead = output("git", ["rev-parse", "HEAD"]);
const initialStatus = output("git", ["status", "--porcelain=v1", "--untracked-files=all"]);
const initialSnapshot = workspaceSnapshot();
if (selection.finalEvidence) {
  if (initialStatus) throw new Error("最终 Codex 门禁要求干净工作树；未提交改动请使用 --uncommitted 预审");
  if (selection.headSha !== initialHead) {
    throw new Error(`--commit 必须等于当前 HEAD：选择 ${selection.headSha}，当前 ${initialHead}`);
  }
}

if (!process.argv.includes("--review-only")) {
  const install = packageManagerInstallArgs();
  run(install.command, install.args);
  for (const script of ["check", "test:e2e", "build", "test:e2e:production"]) {
    const manager = packageManagerRunArgs(script);
    run(manager.command, manager.args);
  }
  checkSelectedDiff(selection);
  const finalHead = output("git", ["rev-parse", "HEAD"]);
  const finalSnapshot = workspaceSnapshot();
  if (finalHead !== initialHead || finalSnapshot !== initialSnapshot) {
    throw new Error("门禁运行期间 HEAD 或工作树发生变化；本次结果作废，请重新运行");
  }
} else {
  console.warn("仅重跑 Codex 模型审查；该结果不能单独作为完整门禁证据。");
}

const gitNexusEvidence = verifyGitNexus(selection);

const workDir = mkdtempSync(join(tmpdir(), "garment-canvas-codex-gate-"));
const schemaPath = join(workDir, "review-schema.json");
const resultPath = join(workDir, "review-result.json");

try {
  writeFileSync(schemaPath, `${JSON.stringify(REVIEW_SCHEMA, null, 2)}\n`, "utf8");
  const reviewTarget = selection.finalEvidence
    ? `Review only the exact Git diff ${selection.baseSha}..${selection.headSha}.`
    : "Review all staged, unstaged, and untracked changes against the current HEAD.";
  const prompt = `${reviewTarget}
Act as the final Garment Canvas merge gate. Do not modify files. Follow AGENTS.md.
The gate already ran GitNexus CLI status and detect-changes successfully for this exact scope:
${gitNexusEvidence}
You MUST also call GitNexus detect_changes for this exact scope and report its result in gitnexus.
If GitNexus is unavailable, stale, or degraded, set gitnexus.status to degraded and verdict to fail.
Prioritize correctness, security, data loss, authorization, paid-provider duplicate submission,
document/session isolation, regressions, and missing tests. Any actionable P0-P3 finding fails.
Return only the JSON object required by the supplied schema.`;

  run("codex", [
    "--ask-for-approval",
    "never",
    "--config",
    'model_reasoning_effort="high"',
    "exec",
    "--ephemeral",
    "--sandbox",
    "read-only",
    "--output-schema",
    schemaPath,
    "--output-last-message",
    resultPath,
    prompt,
  ]);

  const reviewedHead = output("git", ["rev-parse", "HEAD"]);
  const reviewedSnapshot = workspaceSnapshot();
  if (reviewedHead !== initialHead || reviewedSnapshot !== initialSnapshot) {
    throw new Error("Codex 审查期间 HEAD 或工作树发生变化；本次结果作废，请重新运行");
  }

  const review = JSON.parse(readFileSync(resultPath, "utf8"));
  console.log(`Codex verdict: ${review.verdict} — ${review.summary}`);
  for (const finding of review.findings) {
    console.error(
      `${finding.severity} ${finding.file}:${finding.line || 1} ${finding.title}: ${finding.reason}`,
    );
  }
  console.log(`GitNexus: ${review.gitnexus.status} — ${review.gitnexus.evidence}`);
  if (
    review.verdict !== "pass" ||
    review.findings.length > 0 ||
    review.gitnexus.status !== "pass"
  ) {
    process.exitCode = 1;
  }
} finally {
  rmSync(workDir, { recursive: true, force: true });
}
