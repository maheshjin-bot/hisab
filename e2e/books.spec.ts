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

// A fresh identity per run: signing up twice with one address fails, and a
// shared account would let one run's data leak into another's assertions.
const stamp = Date.now();
const EMAIL = `e2e+${stamp}@hisab.test`;
const PASSWORD = `e2e-${stamp}-Aa1!`;
const COMPANY = `E2E Co ${stamp}`;

test("a new user can set up books and see them tally", async ({ page }) => {
  test.setTimeout(180_000);

  // ---- sign up -----------------------------------------------------------
  await page.goto("/login");
  await page.getByRole("tab", { name: "Create account" }).click();
  await page.getByLabel("Full name").fill("E2E User");
  await page.getByLabel("Email").fill(EMAIL);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Create account" }).click();

  // With email confirmation on, signup ends here and the rest cannot run.
  const confirmationWall = page.getByText("Check your inbox");
  if (await confirmationWall.isVisible({ timeout: 10_000 }).catch(() => false)) {
    test.skip(true, "This project requires email confirmation; the flow can't continue unattended.");
  }

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
