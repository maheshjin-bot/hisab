import { defineConfig } from "vitest/config";

/**
 * Unit tests only — the arithmetic and the parsing, not the UI.
 *
 * There's no jsdom environment and no React plugin here on purpose: the
 * things that must never be wrong in an accounting app are pure functions,
 * and keeping the suite free of a DOM keeps it fast enough to run on every
 * push. Database guarantees are covered by supabase/tests/, and the
 * end-to-end flow by Playwright.
 */
export default defineConfig({
  resolve: {
    // Resolves the "@/*" paths from tsconfig.json natively — Vite supports
    // this directly, so no vite-tsconfig-paths plugin is needed.
    tsconfigPaths: true,
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    globals: false,
  },
});
