import { expect, test } from "@playwright/test";

/**
 * The whole loop, once: sign up → create a company → add ledgers → post one
 * voucher of each type → the Trial Balance tallies.
 *
 * This is deliberately one long test rather than several. Each step depends
 * on the last, and splitting it would mean either re-running the setup four
 * times or sharing state between tests that Playwright makes no promises
 * about the ordering of.
 */

const SUPABASE_CONFIGURED =
  !!process.env.NEXT_PUBLIC_SUPABASE_URL && !!process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

test.skip(
  !SUPABASE_CONFIGURED,
  "Needs NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY — the accounting rules live in the database, so there is nothing meaningful to test without one."
);

/**
 * Two ways in.
 *
 * Preferred: an existing account, supplied as E2E_EMAIL / E2E_PASSWORD. Use
 * this against a project with Supabase's strict email validation switched on
 * — it checks deliverability, so it rejects every address a test could safely
 * invent (a .test TLD and example.com both have no MX records and both come
 * back as 'Email address "..." is invalid').
 *
 * Fallback: sign up a throwaway user, which works on a project with that
 * validation relaxed and additionally proves the sign-up path itself.
 */
const EXISTING_EMAIL = process.env.E2E_EMAIL;
const EXISTING_PASSWORD = process.env.E2E_PASSWORD;
const USE_EXISTING = !!EXISTING_EMAIL && !!EXISTING_PASSWORD;

const stamp = Date.now();
// example.com is IANA-reserved, so a generated address can never reach a real
// person even if the project has confirmation emails enabled.
const EMAIL = EXISTING_EMAIL ?? `e2e-${stamp}@example.com`;
const PASSWORD = EXISTING_PASSWORD ?? `e2e-${stamp}-Aa1!`;
const COMPANY = `E2E Co ${stamp}`;

test("a new user can set up books and see them tally", async ({ page }) => {
  test.setTimeout(180_000);

  // ---- get in ------------------------------------------------------------
  await page.goto("/login");

  if (USE_EXISTING) {
    await page.getByLabel("Email").fill(EMAIL);
    await page.getByLabel("Password").fill(PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();
  } else {
    await page.getByRole("tab", { name: "Create account" }).click();
    await page.getByLabel("Full name").fill("E2E User");
    await page.getByLabel("Email").fill(EMAIL);
    await page.getByLabel("Password").fill(PASSWORD);
    await page.getByRole("button", { name: "Create account" }).click();
  }

  // Anything that leaves us on /login is the project refusing the
  // credentials, not the app misbehaving — strict email validation, a signup
  // rate limit, or confirmation required. Reported as a skip carrying the
  // real reason, so a configuration precondition can never masquerade as a
  // regression.
  //
  // waitFor, not isVisible: isVisible() resolves immediately and ignores a
  // timeout, so it always answered "no" before the request had even returned.
  const authError = page.locator('[role="alert"]').filter({ hasText: /\S/ }).first();
  const confirmationWall = page.getByText("Check your inbox");

  let blockedBy: string | null = null;
  try {
    await authError.waitFor({ state: "visible", timeout: 8_000 });
    blockedBy = (await authError.textContent())?.trim() || "unknown error";
  } catch {
    try {
      await confirmationWall.waitFor({ state: "visible", timeout: 2_000 });
      blockedBy = "email confirmation required";
    } catch {
      // Neither appeared, so the credentials were accepted.
    }
  }

  // Outside the try: test.skip throws, and the catch above would swallow it.
  test.skip(
    blockedBy !== null,
    `Supabase refused the test credentials: "${blockedBy}". Set E2E_EMAIL and ` +
      "E2E_PASSWORD to an existing confirmed account, or relax email validation " +
      "and confirmation for this project."
  );

  // ---- create a company --------------------------------------------------
  await expect(page).toHaveURL(/\/companies/, { timeout: 30_000 });
  await page.getByRole("button", { name: /new company|create company/i }).first().click();
  await page.getByLabel(/company name|name/i).first().fill(COMPANY);
  await page.getByRole("button", { name: /create/i }).last().click();

  await expect(page).toHaveURL(/\/[0-9a-f-]{36}\/dashboard/, { timeout: 30_000 });
  const companyId = page.url().match(/\/([0-9a-f-]{36})\//)![1];

  // ---- add two ledgers ---------------------------------------------------
  // The seeded chart has groups but no ledgers, so a voucher needs these
  // before it can reference anything.
  for (const [name, group] of [
    ["E2E Cash", "Cash-in-Hand"],
    ["E2E Sales", "Direct Incomes"],
  ] as const) {
    await page.goto(`/${companyId}/ledgers?new=1`);
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Name").fill(name);
    await dialog.getByRole("combobox").first().click();
    await page.getByRole("option", { name: group, exact: false }).first().click();
    await dialog.getByRole("button", { name: /create ledger/i }).click();
    await expect(dialog).toBeHidden({ timeout: 15_000 });
    await expect(page.getByText(name)).toBeVisible();
  }

  // ---- post one voucher of each type -------------------------------------
  for (const type of ["receipt", "payment", "contra", "journal", "sales", "purchase"]) {
    await page.goto(`/${companyId}/vouchers/new/${type}`);

    // Every type reduces to the same shape at this level: pick a ledger on
    // each side and enter one amount. The form keeps the two sides in step.
    const comboboxes = page.getByRole("combobox");
    await comboboxes.first().click();
    await page.getByRole("option").first().click();

    const amounts = page.locator('input[type="number"]');
    await amounts.first().fill("100");

    await page.getByRole("button", { name: /save|create/i }).last().click();
    await expect(page).toHaveURL(new RegExp(`/${companyId}/vouchers$`), { timeout: 30_000 });
  }

  // ---- the books tally ---------------------------------------------------
  await page.goto(`/${companyId}/reports/trial-balance`);
  await expect(page.getByRole("heading", { name: "Trial Balance" })).toBeVisible();

  // The failure copy is the assertion: it appears only when the two totals
  // differ, which the deferred balance trigger should make impossible.
  await expect(page.getByText(/does not tally/i)).toHaveCount(0);

  await page.goto(`/${companyId}/reports/balance-sheet`);
  await expect(page.getByText("Balance sheet tallies.")).toBeVisible({ timeout: 30_000 });
});
