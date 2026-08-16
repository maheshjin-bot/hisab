import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end coverage of the one flow that has to work: sign up, create a
 * company, add ledgers, post a voucher of each type, and see the Trial
 * Balance tally.
 *
 * It needs a real Supabase project — the accounting rules live in the
 * database, so stubbing it would test nothing worth testing. The spec skips
 * itself rather than failing when the environment isn't configured, so a
 * checkout without credentials still gets a green run from the unit suite.
 */
const PORT = Number(process.env.E2E_PORT ?? 3100);

export default defineConfig({
  testDir: "./e2e",
  // Each spec signs up its own user and builds its own company, so they must
  // not interleave against one shared database.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : [["list"]],

  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },

  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],

  webServer: {
    // Production build, not `next dev`: the dev overlay intercepts clicks and
    // React runs effects twice, neither of which is what users get.
    command: `npm run build && npm run start -- --port ${PORT}`,
    url: `http://127.0.0.1:${PORT}/login`,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
});
