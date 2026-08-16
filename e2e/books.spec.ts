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
  // Six voucher types, two ledger pickers each, every one a popover with a
  // debounced search behind it — the default two minutes is not enough.
  test.setTimeout(360_000);

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

  // Leaving /login is the success signal, and the only reliable one. Looking
  // for an error element instead is wrong in both directions: isVisible()
  // resolves immediately and ignores its timeout, so it answers "no" before
  // the request returns, and role="alert" also matches ordinary copy on the
  // page you land on afterwards — /companies has some, which made a
  // successful sign-in report itself as the refusal "Your companies".
  const navigated = await page
    .waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 20_000 })
    .then(() => true)
    .catch(() => false);

  let blockedBy: string | null = null;
  if (!navigated) {
    // Still on /login, so the project refused us — strict email validation, a
    // signup rate limit, or confirmation required. Report its own words, so a
    // configuration precondition can never masquerade as a regression.
    const alert = page.locator('[role="alert"]').filter({ hasText: /\S/ }).first();
    blockedBy = (await alert.textContent().catch(() => null))?.trim() || null;
    if (!blockedBy && (await page.getByText("Check your inbox").count())) {
      blockedBy = "email confirmation required";
    }
    blockedBy ??= "sign-in did not complete and no reason was shown";
  }

  // Outside any try: test.skip works by throwing, so a catch would swallow it.
  test.skip(
    blockedBy !== null,
    `Supabase refused the test credentials: "${blockedBy}". Set E2E_EMAIL and ` +
      "E2E_PASSWORD to an existing confirmed account, or relax email validation " +
      "and confirmation for this project."
  );

  // ---- create a company --------------------------------------------------
  // Navigated to rather than asserted: a brand-new user lands on /companies,
  // but an account that already has one goes straight to its dashboard, and
  // the suite has to work for both — including on its own second run.
  await page.goto("/companies");
  await page.getByRole("button", { name: /new company|create company/i }).first().click();
  await page.getByLabel(/company name|name/i).first().fill(COMPANY);
  await page.getByRole("button", { name: /create/i }).last().click();

  await expect(page).toHaveURL(/\/[0-9a-f-]{36}\/dashboard/, { timeout: 30_000 });
  const companyId = page.url().match(/\/([0-9a-f-]{36})\//)![1];

  // ---- add ledgers -------------------------------------------------------
  // The seeded chart has groups but no ledgers, so a voucher needs these
  // before it can reference anything. Six rather than two, because each
  // voucher type restricts its sides by the group's ledger_role: Contra needs
  // two different cash/bank accounts, Sales needs a debtor, Purchase a
  // creditor. Two ledgers can only ever post a Receipt.
  for (const [name, group] of [
    ["E2E Cash", "Cash-in-Hand"],
    ["E2E Bank", "Bank Accounts"],
    ["E2E Debtor", "Sundry Debtors"],
    ["E2E Creditor", "Sundry Creditors"],
    ["E2E Sales", "Direct Incomes"],
    ["E2E Expense", "Indirect Expenses"],
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
  //
  // Ledgers per type, in the order the form's pickers appear: the party leg
  // first (where the type has one), then the grid line. Journal has no party
  // and takes two grid rows, one debit and one credit.
  const LEDGERS_BY_TYPE: Record<string, string[]> = {
    receipt: ["E2E Cash", "E2E Sales"],
    payment: ["E2E Cash", "E2E Expense"],
    contra: ["E2E Cash", "E2E Bank"],
    sales: ["E2E Debtor", "E2E Sales"],
    purchase: ["E2E Creditor", "E2E Expense"],
    journal: ["E2E Expense", "E2E Creditor"],
  };

  for (const [type, ledgers] of Object.entries(LEDGERS_BY_TYPE)) {
    await page.goto(`/${companyId}/vouchers/new/${type}`);

    // The ledger picker is a button opening a Command popover with its own
    // search box — not a native combobox, so it can't be driven by role.
    // Once a ledger is chosen the trigger's label becomes that ledger's name,
    // so the set of unfilled pickers shrinks by one and .first() is always
    // the next one to fill.
    const unfilled = page.getByRole("button", { name: /^Select .*…$/ });
    await expect(unfilled.first()).toBeVisible({ timeout: 20_000 });

    // Contra and Journal are full-grid types: several rows, each with its own
    // Dr/Cr toggle and no derived party leg. Two things make them awkward to
    // drive. Their rows all read "Dr" until an amount lands, because the side
    // is derived from which amount field is filled rather than fixed per row.
    // And the grid appends a fresh row once the last one is complete, so the
    // row count changes underneath you mid-fill.
    //
    // So rather than assume a shape: fill whatever is unfilled, then normalise
    // every row — all but the last a debit of 100, the last a credit for their
    // sum — and repeat until it settles. That balances any row count.
    const sideToggles = page.getByRole("button", { name: /^(Dr|Cr)$/ });
    const amounts = page.locator('input[type="number"]:not([disabled])');
    const isFullGrid = (await sideToggles.count()) > 0;

    const fillPicker = async (ledgerName: string) => {
      await expect(async () => {
        const before = await unfilled.count();
        if (before === 0) return;
        await unfilled.first().click();

        // Each picker's popover stays mounted, so match the visible input
        // rather than a placeholder — those differ per side ("Search account
        // (cash/bank)…", "Search received from…").
        const search = page.locator('input[data-slot="command-input"]:visible').first();
        await search.waitFor({ state: "visible", timeout: 5_000 });
        await search.fill(ledgerName);

        // The option list is fed by a debounced async query and re-renders
        // underneath the pointer, so a node found by a wait is routinely gone
        // by the time a click lands. Retry the whole open-search-select.
        await page
          .getByRole("option", { name: ledgerName, exact: false })
          .first()
          .click({ force: true, timeout: 5_000 });

        await expect(unfilled).toHaveCount(before - 1, { timeout: 3_000 });
      }).toPass({ timeout: 40_000 });
    };

    // Exactly two rows are filled, never "however many are unfilled": choosing
    // a ledger in the last row makes the grid append a fresh one, so a loop
    // that chases unfilled rows never terminates — it fills, the grid grows,
    // it fills again.
    //
    // The first picker is the party leg where the type has one and the first
    // grid row otherwise, so it takes ledgers[0]; the second takes ledgers[1].
    await fillPicker(ledgers[0]);
    await fillPicker(ledgers[1]);

    // Single-party types derive the party amount and expose one editable
    // field; full-grid types need both sides set explicitly.
    await amounts.nth(0).fill("100");
    if (isFullGrid) {
      // Amount first, then toggle. The toggle swaps the debit and credit
      // values, and the side shown is derived from whichever is non-zero — so
      // toggling an empty row swaps 0 for 0 and nothing changes.
      await amounts.nth(1).fill("100");
      const secondSide = sideToggles.nth(1);
      if ((await secondSide.textContent())?.trim() === "Dr") await secondSide.click();
    }

    // Journal opens with four rows and only two are needed. Every line is
    // validated, so the empty ones block the save — drop them rather than
    // inventing entries to fill them.
    const removeButtons = page.getByRole("button", { name: /^Remove line / });
    for (let guard = 0; guard < 8 && (await unfilled.count()) > 0; guard++) {
      const count = await removeButtons.count();
      if (count === 0) break;
      await removeButtons.nth(count - 1).click();
      await page.waitForTimeout(200);
    }

    await expect(page.getByText(/Balanced/)).toBeVisible({ timeout: 15_000 });

    await page.getByRole("button", { name: /^Save / }).click();
    await expect(page).toHaveURL(new RegExp(`/${companyId}/vouchers$`), { timeout: 30_000 });
  }

  // ---- the books tally ---------------------------------------------------
  await page.goto(`/${companyId}/reports/trial-balance`);
  await expect(page.getByRole("heading", { name: "Trial Balance" })).toBeVisible();

  // The failure copy is the assertion: it appears only when the two totals
  // differ, which the deferred balance trigger should make impossible.
  await expect(page.getByText(/does not tally/i)).toHaveCount(0);

  await page.goto(`/${companyId}/reports/balance-sheet`);
  // .first() because the print-only statement footer carries the same words as
  // the on-screen line, so an unscoped match is ambiguous.
  await expect(page.getByText("Balance sheet tallies.").first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/Does not tally/)).toHaveCount(0);
});
