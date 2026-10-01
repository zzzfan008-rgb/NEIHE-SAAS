import assert from "node:assert/strict";
import { readFileSync, existsSync, lstatSync } from "node:fs";
import { dirname, resolve, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createHash } from "node:crypto";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const required = [
  "react/index.ts", "react/WorkbenchRuntime.tsx", "server/app.ts", "server/cli.ts",
  "src/components/nodes/TiAngelNode.tsx", "src/components/nodes/ImageInputNode.tsx",
  "src/components/nodes/BackgroundExtractNode.tsx", "src/components/conversation/ConversationPanel.tsx",
  "src/store/flowStore.ts", "src/store/imageConversationStore.ts", "src/lib/imageConversationClient.ts",
  "server/routes/imageConversations.ts", "server/routes/poseReferences.ts",
  "server/engine/imageConversationExecution.ts", "server/engine/imageConversationReconciliation.ts",
  "server/engine/runQueue.ts", "server/lib/database.ts", "server/lib/auth.ts",
  "docs/ai/apiyi/model-contracts.json", "compose.test.yaml", "scripts/test-with-postgres.mjs",
];

test("four feature entry points include controllers, durable backend, and security dependencies", () => {
  for (const path of required) assert.ok(existsSync(resolve(root, path)), `Missing portable implementation: ${path}`);
});

test("every extracted dependency is contained in this package, not a source checkout or host", () => {
  assert.ok(existsSync(resolve(root, "provenance.json")), "Dependency closure manifest is missing");
  const manifest = JSON.parse(readFileSync(resolve(root, "provenance.json"), "utf8"));
  assert.ok(manifest.files.length > 0);
  for (const entry of manifest.files) {
    assert.ok(!isAbsolute(entry.path) && !entry.path.split("/").includes(".."), entry.path);
    const file = resolve(root, entry.path);
    assert.ok(existsSync(file), entry.path);
    assert.equal(lstatSync(file).isSymbolicLink(), false, entry.path);
    assert.ok(!/(^|\/)(node_modules|data|\.git|\.env|target|dist)(\/|$)|\.(?:rs|go)$/.test(entry.path), entry.path);
    assert.equal(createHash("sha256").update(readFileSync(file)).digest("hex"), entry.extractedSha256, `Stale provenance: ${entry.path}`);
    for (const target of entry.dependencies) {
      const normalized = relative(root, resolve(root, target));
      assert.ok(!normalized.startsWith("..") && !isAbsolute(normalized), `${entry.path} -> ${target}`);
      assert.ok(existsSync(resolve(root, target)), `${entry.path} -> ${target}`);
    }
  }
});

test("browser and server exports are separate and portable", () => {
  assert.ok(existsSync(resolve(root, "package.json")), "Package manifest is missing");
  const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
  for (const name of ["./react", "./server", "./styles.css"]) assert.ok(pkg.exports[name], name);
  assert.ok(!Object.values(pkg.dependencies).some((value) => /^(file:|link:|workspace:)/.test(value)));
  const api = readFileSync(resolve(root, "react/index.ts"), "utf8");
  for (const name of ["TiAngelNode", "ImageInputNode", "BackgroundExtractNode", "ConversationPanel", "WorkbenchRuntime"]) {
    assert.ok(api.includes(name), `Missing public export: ${name}`);
  }
});

test("all third-party imports are declared without relying on the source repository", () => {
  const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
  const manifest = JSON.parse(readFileSync(resolve(root, "provenance.json"), "utf8"));
  const declared = { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies };
  for (const name of manifest.externalPackages) assert.ok(declared[name], `Undeclared package: ${name}`);
});

test("runtime includes recovery gates and overlay controllers required by the original components", () => {
  const runtime = readFileSync(resolve(root, "react/WorkbenchRuntime.tsx"), "utf8");
  for (const marker of ["/api/history/active", "reconcileRunHistory", "resumeRecentResults", "setGenerationSafetyBlockReason", "<ConnectionRoleDialog", "<CompareOverlay", "<ImageViewer", "<AssetPickerOverlay", "<GenerationRecordDialog", "<ResultsPanel"]) {
    assert.ok(runtime.includes(marker), `Missing runtime controller: ${marker}`);
  }
});
