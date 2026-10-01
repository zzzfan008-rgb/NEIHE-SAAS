import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

// This maintenance command is not needed to install, build, or run the delivered package.
const destination = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.resolve(process.argv[2] || "../../");
const tools = path.resolve(process.argv[3] || destination);
const ts = createRequire(path.join(tools, "package.json"))("typescript");
const originals = new Map();
const seen = new Set();
const dependencies = new Set();
const hash = (value) => createHash("sha256").update(value).digest("hex");
const inRoot = (name) => !path.isAbsolute(name) && !name.split(/[\\/]/).includes("..");
const exists = (name) => fs.existsSync(path.join(destination, name)) || fs.existsSync(path.join(source, name));
const variants = (name) => [name, ...[".ts", ".tsx", ".js", ".mjs", ".json", ".d.ts"].map((ext) => name + ext), ...["index.ts", "index.tsx", "index.js"].map((base) => path.join(name, base))];

function resolveLocal(name, importer) {
  const base = name.startsWith("@/") ? path.join("src", name.slice(2)) : path.join(path.dirname(importer), name);
  if (!inRoot(base)) throw new Error(`Import escapes package: ${importer} -> ${name}`);
  const result = variants(base).find((candidate) => exists(candidate) && [destination, source].some((root) => fs.existsSync(path.join(root, candidate)) && fs.statSync(path.join(root, candidate)).isFile()));
  if (!result) throw new Error(`Unresolved import: ${importer} -> ${name}`);
  return result;
}
function visit(file) {
  if (seen.has(file)) return;
  if (!inRoot(file) || /(^|\/)(?:\.env|data|node_modules|\.git)(?:\/|$)/.test(file)) throw new Error(`Unsafe source path: ${file}`);
  seen.add(file);
  const dest = path.join(destination, file);
  const origin = fs.existsSync(dest) ? dest : path.join(source, file);
  if (!fs.existsSync(origin)) throw new Error(`Missing source ${file}`);
  if (fs.lstatSync(origin).isSymbolicLink()) throw new Error(`Source symlink is not portable: ${file}`);
  let text = fs.readFileSync(origin, "utf8");
  const originalHash = hash(text);
  const refs = [];
  const edits = [];
  function inspect(literal) {
    if (!literal || !ts.isStringLiteralLike(literal)) return;
    const specifier = literal.text;
    if (!specifier.startsWith(".") && !specifier.startsWith("@/")) {
      if (!specifier.startsWith("node:")) dependencies.add(specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0]);
      return;
    }
    const target = resolveLocal(specifier, file);
    refs.push(target);
    if (specifier.startsWith("@/")) {
      let value = path.relative(path.dirname(file), path.join("src", specifier.slice(2))).split(path.sep).join("/");
      if (!value.startsWith(".")) value = `./${value}`;
      edits.push({ start: literal.getStart(ast) + 1, end: literal.getEnd() - 1, value });
    }
  }
  let ast;
  if (/\.(?:tsx?|m?js)$/.test(file)) {
    ast = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    function walk(node) {
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) inspect(node.moduleSpecifier);
      if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === "require"))) inspect(node.arguments[0]);
      if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) inspect(node.argument.literal);
      ts.forEachChild(node, walk);
    }
    walk(ast);
  } else if (file.endsWith(".css")) {
    for (const match of text.matchAll(/@import\s+["']([^"']+)["']/g)) {
      if (match[1].startsWith(".")) refs.push(resolveLocal(match[1], file));
      else dependencies.add(match[1].startsWith("@") ? match[1].split("/").slice(0, 2).join("/") : match[1].split("/")[0]);
    }
  }
  for (const edit of edits.sort((a, b) => b.start - a.start)) text = text.slice(0, edit.start) + edit.value + text.slice(edit.end);
  if (origin !== dest) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, text, { flag: "wx" });
    originals.set(file, { path: file, originalSha256: originalHash, extractedSha256: hash(text), aliasImportsRewritten: edits.length, dependencies: [...new Set(refs)].sort() });
  } else if (edits.length) {
    throw new Error(`Existing package source still has alias imports: ${file}. Refusing to overwrite.`);
  }
  if (origin === dest && fs.existsSync(path.join(source, file))) {
    const original = fs.readFileSync(path.join(source, file), "utf8");
    originals.set(file, { path: file, originalSha256: hash(original), extractedSha256: hash(text), aliasImportsRewritten: ts.preProcessFile(original, true, true).importedFiles.filter((entry) => entry.fileName.startsWith("@/")).length, dependencies: [...new Set(refs)].sort() });
  }
  for (const ref of refs) visit(ref);
}

const focusedTests = [
  "ti-angle", "ti-angle-geometry", "ti-angle-preview", "ti-angle-persistence", "ti-angle-ports", "ti-angle-basis", "ti-angle-execution", "ti-angle-node",
  "pose-analysis", "pose-topology", "pose-editing", "pose-editor-history", "pose-editor-model", "pose-ik", "pose-reference-runtime", "pose-prompt-runtime", "pose-document-persistence", "pose-references-api", "dwpose-analysis", "depth-analysis",
  "background-extract", "image-input-node", "image-conversation-rules", "image-conversation-inputs", "image-conversation-recovery", "image-conversation-ui", "image-conversation-planner", "image-conversation-queue", "image-conversation-storage", "image-conversation-api", "image-conversation-lifecycle",
  "active-document-boundary", "document-snapshot", "run-queue", "recent-results", "project-tabs-session", "mask-upload", "mask-processing", "authorization", "auth-storage", "auth-client", "generation-safety", "gpt-image25", "provider-contract", "multi-image-provider-recovery", "provider-retry", "exact-generation", "upload-image-normalization",
];
visit("pnpm-lock.yaml");
visit("pnpm-workspace.yaml");
visit("src/types/file-system-access.d.ts");
visit("templates/multi-image-try-on.workflow.json");
for (const file of ["tests/dwpose-service-protocol.test.py", "scripts/pose/service.py", "scripts/pose/requirements.txt", "scripts/pose/setup.sh", "scripts/depth/service.py", "scripts/depth/requirements.txt"]) visit(file);
const modelSources = JSON.parse(fs.readFileSync(path.join(source, "docs/ai/apiyi/sources.json"), "utf8"));
for (const file of new Set([...modelSources.localKnowledgeBase.documents, ...modelSources.sources.map((entry) => entry.localDocument)])) visit(`docs/ai/apiyi/${file}`);
for (const file of ["react/index.ts", "server/app.ts", "server/cli.ts", "scripts/test-with-postgres.mjs", "compose.test.yaml", ...focusedTests.map((name) => `tests/${name}.test.ts`)]) visit(file);

const previousFile = path.join(destination, "provenance.json");
const previous = fs.existsSync(previousFile) ? JSON.parse(fs.readFileSync(previousFile, "utf8")) : { files: [] };
for (const entry of previous.files) if (!originals.has(entry.path)) originals.set(entry.path, entry);
const manifest = {
  sourceCommit: execFileSync("git", ["-C", source, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  extraction: "Original React/TypeScript and Node/Express dependency closure; no Rust/Go or target-host adapter.",
  files: [...originals.values()].sort((a, b) => a.path.localeCompare(b.path)),
  externalPackages: [...dependencies].sort(),
  focusedTests: focusedTests.map((name) => `tests/${name}.test.ts`),
};
fs.writeFileSync(previousFile, JSON.stringify(manifest, null, 2) + "\n");
console.log(JSON.stringify({ extractedFiles: originals.size, externalPackages: manifest.externalPackages, focusedTests: focusedTests.length }));
