import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const playwrightCli = resolve(root, "node_modules/@playwright/test/cli.js");
const dataDir = mkdtempSync(join(tmpdir(), "garment-canvas-e2e-safety-"));
const safeEnv = {
  ...process.env,
  E2E_ISOLATED_RUN: "1",
  NODE_ENV: "test",
  COOKIE_SECURE: "false",
  APIYI_API_KEY: "e2e-disabled",
  APIYI_BASE_URL: "https://127.0.0.1:9",
  E2E_BASE_URL: "http://127.0.0.1:45173",
  E2E_API_URL: "http://127.0.0.1:43001",
  DATABASE_URL: "postgresql://garment_test:garment_test@127.0.0.1:45432/garment_canvas_test",
  DATA_DIR: dataDir,
  E2E_AUTH_STATE_PATH: join(dataDir, "auth.json"),
};

function listTests(overrides = {}, omitted = []) {
  const env = { ...safeEnv, ...overrides };
  for (const key of omitted) delete env[key];
  return spawnSync(process.execPath, [playwrightCli, "test", "--list"], {
    cwd: root,
    env,
    encoding: "utf8",
  });
}

try {
  const baseline = listTests();
  assert.equal(baseline.status, 0, `${baseline.stdout}\n${baseline.stderr}`);
  assert.match(baseline.stdout, /Total: \d+ tests in \d+ files/);
  assert.match(
    baseline.stdout,
    /\[golden-path\].*upload and text starters complete the isolated first-generation golden path/,
    "isolated golden-path project must remain in the browser regression matrix",
  );
  assert.match(
    baseline.stdout,
    /\[initial-draft\].*hard refresh, a second tab, and relogin restore the same initial draft/,
    "initial-draft recovery must remain in the isolated browser regression matrix",
  );
  for (const width of [1024, 1280, 1440]) {
    assert.match(
      baseline.stdout,
      new RegExp(`\\[desktop-${width}\\].*node drag is one undo transaction`),
      `desktop-${width} must include the real drag transaction regression`,
    );
    assert.match(
      baseline.stdout,
      new RegExp(`\\[desktop-${width}\\].*node title and media actions keep stable keyboard-accessible controls`),
      `desktop-${width} must include node action focus and keyboard coverage`,
    );
    assert.match(
      baseline.stdout,
      new RegExp(`\\[desktop-${width}\\].*tool rail, right dock and horizontal zoom controls preserve canvas identity`),
      `desktop-${width} must include the stable workbench regression`,
    );
    assert.match(
      baseline.stdout,
      new RegExp(`\\[desktop-${width}\\].*single current theme remains applied without a picker`),
      `desktop-${width} must include the single-theme contract regression`,
    );
    assert.match(
      baseline.stdout,
      new RegExp(`\\[desktop-${width}\\].*results and project center follow desktop density`),
      `desktop-${width} must include Results actions, long-label and three-theme geometry`,
    );
    assert.match(
      baseline.stdout,
      new RegExp(`\\[desktop-${width}\\].*five tool groups support hover keyboard click drag and disabled no-op`),
      `desktop-${width} must include tool-flyout interaction and collision geometry`,
    );
    assert.match(
      baseline.stdout,
      new RegExp(`\\[desktop-${width}\\].*approved video capabilities open complete workflows without triggering generation`),
      `desktop-${width} must include approved video workflows without paid generation`,
    );
  }

  const cases = [
    {
      name: "missing runner marker",
      result: listTests({}, ["E2E_ISOLATED_RUN"]),
      message: /use pnpm run test:e2e/,
    },
    {
      name: "real AI key",
      result: listTests({ APIYI_API_KEY: "real-key-must-be-rejected" }),
      message: /real AI key must never reach browser regressions/,
    },
    {
      name: "non-loopback API",
      result: listTests({ E2E_API_URL: "https://example.com" }),
      message: /E2E_API_URL must use http:\/\/127\.0\.0\.1/,
    },
    {
      name: "non-test database",
      result: listTests({ DATABASE_URL: "postgresql://user:pass@127.0.0.1:5432/garment_canvas" }),
      message: /DATABASE_URL must target garment_canvas_test/,
    },
    {
      name: "auth state outside temp data",
      result: listTests({ E2E_AUTH_STATE_PATH: resolve(dataDir, "../outside-auth.json") }),
      message: /auth state must live inside the temporary DATA_DIR/,
    },
  ];

  for (const safetyCase of cases) {
    assert.notEqual(safetyCase.result.status, 0, `${safetyCase.name} must fail closed`);
    assert.match(
      `${safetyCase.result.stdout}\n${safetyCase.result.stderr}`,
      safetyCase.message,
      `${safetyCase.name} must report the matching guard`,
    );
  }
} finally {
  rmSync(dataDir, { recursive: true, force: true });
}

console.log("E2E isolation safety test passed");
