import { describe, expect, it } from "vitest";
import { ledgerStatementCounterpartyLinkId } from "@/lib/reports/ledger-statement-links";

describe("ledgerStatementCounterpartyLinkId", () => {
  it("links the single counterparty ledger of an ordinary two-line voucher", () => {
    expect(
      ledgerStatementCounterpartyLinkId({ counterparty: "Cash", counterpartyLedgerId: "ledger-1" })
    ).toBe("ledger-1");
  });

  it("leaves a multi-party journal row unlinked, even though it names real ledgers", () => {
    // Several ledgers in one cell — there is no single ledger a click here
    // could mean, so the row shows plain text and counterparty_ledger_id
    // comes back null from the database.
    expect(
      ledgerStatementCounterpartyLinkId({ counterparty: "Cash, Sales", counterpartyLedgerId: null })
    ).toBeNull();
  });

  it("leaves the synthetic Opening Balance row unlinked", () => {
    expect(
      ledgerStatementCounterpartyLinkId({ counterparty: null, counterpartyLedgerId: null })
    ).toBeNull();
  });
});
