import assert from "node:assert/strict";
import fs from "node:fs";

function read(relativePath: string): string {
  return fs.readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8");
}

console.log("Node.js 运行时版本契约测试");

const packageJson = JSON.parse(read("package.json")) as {
  engines?: { node?: string };
};
assert.equal(
  packageJson.engines?.node,
  ">=22.20.0",
  "package engines 必须声明 Node.js 22.20.0+",
);

for (const documentationPath of ["AGENTS.md", "README.md", "deploy/macos/README-MACMINI.md"]) {
  assert.match(
    read(documentationPath),
    /Node\.js 22\.20\.0 (?:or newer|或更高版本)/,
    `${documentationPath} 必须与 package engines 的 Node.js 下限一致`,
  );
}

const installer = read("deploy/macos/install.command");
assert.match(installer, /Node\.js 22\.20\.0\+ is required/);
assert.match(
  installer,
  /major > 22 \|\| \(major === 22 && minor >= 20\)/,
  "macOS 安装器必须拒绝 Node.js 22.20 以下版本",
);

assert.equal(read(".nvmrc").trim(), "22.20.0", ".nvmrc 必须固定最低受支持版本");
assert.equal(
  fs.existsSync(new URL("../.github/workflows/ci.yml", import.meta.url)),
  false,
  "GitHub Actions CI 已由本地 Codex 门禁替代",
);
const codexGate = read("scripts/codex-gate.mjs");
assert.match(
  codexGate,
  /const REQUIRED_NODE_VERSION = "22\.20\.0";/,
  "Codex 门禁必须在最低支持的 Node.js 22.20.0 上运行完整套件",
);
assert.match(
  codexGate,
  /packageManagerInstallArgs\(\)/,
  "Codex 门禁必须通过包管理器解析器执行锁定安装",
);
assert.match(
  codexGate,
  /packageManagerRunArgs\(script\)/,
  "Codex 门禁必须通过包管理器解析器执行验证脚本",
);
assert.match(
  codexGate,
  /for \(const script of \["check", "test:e2e", "build", "test:e2e:production"\]\)/,
  "Codex 门禁必须保持固定验证顺序",
);
assert.match(
  codexGate,
  /"codex", \[[\s\S]*?"exec",\s*"--ephemeral"/,
  "本地门禁必须调用结构化 Codex exec 审查",
);
assert.doesNotMatch(
  codexGate,
  /run\("codex", \[[\s\S]*?"--model"/,
  "Codex 门禁必须使用用户配置的默认模型",
);
const dockerfile = read("Dockerfile");
const pnpmWorkspace = read("pnpm-workspace.yaml");
const nodeImages = [...dockerfile.matchAll(/^FROM node:([^\s]+).*$/gm)].map((match) => match[1]);
assert.ok(nodeImages.length > 0, "Dockerfile 必须声明 Node.js 基础镜像");
assert.ok(
  nodeImages.every((image) => image.startsWith("22-")),
  `Dockerfile 中所有 Node.js 基础镜像必须使用 22.x，实际为：${nodeImages.join(", ")}`,
);
assert.match(
  dockerfile,
  /corepack enable && corepack prepare pnpm@11\.19\.0 --activate[\s\S]*pnpm install --frozen-lockfile[\s\S]*RUN pnpm run build/,
  "Docker 构建阶段必须使用锁定 pnpm 版本和 frozen lockfile",
);
for (const dependency of ["better-sqlite3", "esbuild", "sharp"]) {
  assert.match(
    pnpmWorkspace,
    new RegExp(`allowBuilds:[\\s\\S]*?${dependency.replace("-", "\\-")}: true`),
    `pnpm 必须显式批准 ${dependency} 的原生构建脚本`,
  );
}

console.log("  ✓ package、文档、安装器与本地 Codex 门禁统一为 Node.js 22.20+，Docker 保持 22.x 安全更新");
