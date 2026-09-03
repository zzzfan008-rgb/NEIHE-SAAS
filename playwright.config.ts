import { defineConfig, devices } from "@playwright/test";
import { isAbsolute, relative, resolve } from "node:path";

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`E2E safety check failed: missing ${name}; use npm run test:e2e`);
  return value;
}

function loopbackUrl(name: string, expectedProtocol: "http:" | "https:" | "postgresql:"): URL {
  const value = new URL(requiredEnv(name));
  if (value.protocol !== expectedProtocol || value.hostname !== "127.0.0.1") {
    throw new Error(`E2E safety check failed: ${name} must use ${expectedProtocol}//127.0.0.1`);
  }
  return value;
}

if (process.env.E2E_ISOLATED_RUN !== "1") {
  throw new Error("E2E safety check failed: use npm run test:e2e so data and AI calls stay isolated");
}
if (process.env.NODE_ENV !== "test" || process.env.COOKIE_SECURE !== "false") {
  throw new Error("E2E safety check failed: NODE_ENV=test and COOKIE_SECURE=false are required");
}
if (requiredEnv("APIYI_API_KEY") !== "e2e-disabled") {
  throw new Error("E2E safety check failed: the real AI key must never reach browser regressions");
}

const baseURL = loopbackUrl("E2E_BASE_URL", "http:").href.replace(/\/$/, "");
const apiURL = loopbackUrl("E2E_API_URL", "http:").href.replace(/\/$/, "");
loopbackUrl("APIYI_BASE_URL", "https:");
const databaseURL = loopbackUrl("DATABASE_URL", "postgresql:");
if (databaseURL.pathname !== "/garment_canvas_test") {
  throw new Error("E2E safety check failed: DATABASE_URL must target garment_canvas_test");
}

const dataDir = resolve(requiredEnv("DATA_DIR"));
const authStatePath = resolve(requiredEnv("E2E_AUTH_STATE_PATH"));
const authRelativePath = relative(dataDir, authStatePath);
if (!authRelativePath || authRelativePath.startsWith("..") || isAbsolute(authRelativePath)) {
  throw new Error("E2E safety check failed: auth state must live inside the temporary DATA_DIR");
}
const webPort = new URL(baseURL).port || "80";

export default defineConfig({
  testDir: "./e2e",
  outputDir: "test-results",
  timeout: 30_000,
  expect: { timeout: 8_000 },
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI
    ? [["line"], ["html", { open: "never" }]]
    : [["list"], ["html", { open: "never" }]],
  use: {
    baseURL,
    browserName: "chromium",
    locale: "zh-CN",
    timezoneId: "Asia/Shanghai",
    contextOptions: { reducedMotion: "reduce" },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
  },
  webServer: [
    {
      command: "tsx server/index.ts",
      url: `${apiURL}/api/ready`,
      reuseExistingServer: false,
      timeout: 120_000,
      stdout: "pipe",
      stderr: "pipe",
    },
    {
      command: `vite --host 127.0.0.1 --port ${webPort} --strictPort`,
      url: baseURL,
      reuseExistingServer: false,
      timeout: 120_000,
      stdout: "pipe",
      stderr: "pipe",
    },
  ],
  projects: [
    {
      name: "login",
      testMatch: /login\.spec\.ts/,
      use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 720 } },
    },
    {
      name: "setup",
      testMatch: /auth\.setup\.ts/,
      use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 720 } },
    },
    {
      name: "desktop-1024",
      testMatch: /workbench\.spec\.ts/,
      dependencies: ["setup"],
      use: {
        ...devices["Desktop Chrome"],
        storageState: authStatePath,
        viewport: { width: 1024, height: 768 },
      },
    },
    {
      name: "desktop-1280",
      testMatch: /workbench\.spec\.ts/,
      dependencies: ["setup"],
      use: {
        ...devices["Desktop Chrome"],
        storageState: authStatePath,
        viewport: { width: 1280, height: 720 },
      },
    },
    {
      name: "desktop-1440",
      testMatch: /workbench\.spec\.ts/,
      dependencies: ["setup"],
      use: {
        ...devices["Desktop Chrome"],
        storageState: authStatePath,
        viewport: { width: 1440, height: 900 },
      },
    },
    {
      name: "golden-path",
      testMatch: /golden-path\.spec\.ts/,
      dependencies: ["setup"],
      use: {
        ...devices["Desktop Chrome"],
        storageState: authStatePath,
        viewport: { width: 1280, height: 720 },
      },
    },
    {
      name: "initial-draft",
      testMatch: /initial-draft\.spec\.ts/,
      dependencies: ["desktop-1024", "desktop-1280", "desktop-1440", "golden-path"],
      use: {
        ...devices["Desktop Chrome"],
        storageState: authStatePath,
        viewport: { width: 1280, height: 720 },
      },
    },
  ],
});
