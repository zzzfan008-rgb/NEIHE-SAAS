import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const tsx = require.resolve("tsx/cli");
const { focusedTests } = JSON.parse(readFileSync(new URL("../provenance.json", import.meta.url), "utf8"));
const failures = [];
for (const file of ["tests/package.test.mjs", "tests/server-app.test.ts", ...focusedTests]) {
  const args = file.endsWith(".mjs") ? ["--test", file] : [tsx, file];
  const result = spawnSync(process.execPath, args, { stdio: "inherit", env: process.env });
  if (result.error) throw result.error;
  if (result.status !== 0) failures.push(file);
}
if (failures.length) {
  console.error(`image-workbench failed files: ${failures.join(", ")}`);
  process.exitCode = 1;
} else {
  console.log(`image-workbench: ${focusedTests.length + 2} test files passed`);
}
