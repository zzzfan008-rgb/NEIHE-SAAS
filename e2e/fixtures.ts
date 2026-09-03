import { expect, test as base } from "@playwright/test";

export const test = base.extend<{ aiRequestGuard: void }>({
  aiRequestGuard: [async ({ page }, use) => {
    await page.route(/\/api\/(?:generate|run-plan)(?:\/|\?|$)/, async (route) => {
      if (route.request().method() === "POST") {
        throw new Error(`E2E attempted a blocked AI request: ${route.request().url()}`);
      }
      await route.continue();
    });
    await use();
  }, { auto: true }],
});

export { expect };
