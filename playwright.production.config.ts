import { defineConfig, devices } from "@playwright/test";
import { isAbsolute, relative, resolve } from "node:path";

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Production smoke safety check failed: missing ${name}`);
  return value;
}

function loopbackUrl(name: string, protocol: "http:" | "https:" | "postgresql:"): URL {
  const value = new URL(requiredEnv(name));
  if (value.protocol !== protocol || value.hostname !== "127.0.0.1") {
    throw new Error(`Production smoke safety check failed: ${name} must use ${protocol}//127.0.0.1`);
  }
  return value;
}

if (process.env.E2E_ISOLATED_RUN !== "1" || process.env.E2E_PRODUCTION_SMOKE !== "1") {
  throw new Error("Production smoke safety check failed: use npm run test:e2e:production");
}
if (process.env.NODE_ENV !== "production" || process.env.API_ONLY === "true") {
  throw new Error("Production smoke safety check failed: NODE_ENV=production and API_ONLY=false are required");
}
if (requiredEnv("APIYI_API_KEY") !== "e2e-disabled") {
  throw new Error("Production smoke safety check failed: the real AI key must never reach browser smoke");
}
loopbackUrl("APIYI_BASE_URL", "https:");
const databaseUrl = loopbackUrl("DATABASE_URL", "postgresql:");
if (databaseUrl.pathname !== "/garment_canvas_test") {
  throw new Error("Production smoke safety check failed: DATABASE_URL must target garment_canvas_test");
}

const baseURL = loopbackUrl("E2E_BASE_URL", "http:").href.replace(/\/$/, "");
const apiURL = loopbackUrl("E2E_API_URL", "http:").href.replace(/\/$/, "");
const dataDir = resolve(requiredEnv("DATA_DIR"));
const authStatePath = resolve(requiredEnv("E2E_AUTH_STATE_PATH"));
const authRelativePath = relative(dataDir, authStatePath);
if (!authRelativePath || authRelativePath.startsWith("..") || isAbsolute(authRelativePath)) {
  throw new Error("Production smoke safety check failed: auth state must live inside DATA_DIR");
}

export default defineConfig({
  testDir: "./e2e",
  outputDir: "test-results-production",
  timeout: 30_000,
  expect: { timeout: 8_000 },
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI
    ? [["line"], ["html", { open: "never", outputFolder: "playwright-report-production" }]]
    : [["list"], ["html", { open: "never", outputFolder: "playwright-report-production" }]],
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
  webServer: {
    command: `${process.execPath} dist-server/index.js`,
    url: `${apiURL}/api/ready`,
    env: { ...process.env, NODE_ENV: "production", COOKIE_SECURE: "false" },
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: "pipe",
    stderr: "pipe",
  },
  projects: [
    {
      name: "setup",
      testMatch: /auth\.setup\.ts/,
      use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 720 } },
    },
    {
      name: "desktop-production-smoke",
      testMatch: /production-smoke\.spec\.ts/,
      dependencies: ["setup"],
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1280, height: 720 },
        storageState: authStatePath,
      },
    },
  ],
});
