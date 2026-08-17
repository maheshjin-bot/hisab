import { describe, expect, it } from "vitest";
import { assignOccurrenceIndexes, buildFingerprint, fingerprintNarration } from "@/lib/bank/fingerprint";
import type { StatementDirection } from "@/lib/bank/types";

/**
 * The fingerprint carries the whole duplicate guard, and it has to be wrong in
 * neither direction:
 *
 *   too loose — two different transactions share a fingerprint, and the unique
 *   index on bank_statement_lines silently DROPS the second one. A real
 *   transaction never reaches the books and nothing reports it.
 *
 *   too tight — the same transaction seen in two overlapping uploads produces
 *   two fingerprints, and the overlap is duplicated. Loud, at least: the
 *   reconciliation stops balancing.
 *
 * The migration comment states the contract these tests are written against.
 */

interface Txn {
  txnDate: string;
  direction: StatementDirection;
  amountPaise: number;
  narration: string;
}

const SPOTIFY: Txn = {
  txnDate: "2026-04-15",
  direction: "withdrawal",
  amountPaise: 11900,
  narration: "UPI-SPOTIFY INDIA-9871234@ybl-UTR609812345",
};

describe("fingerprintNarration", () => {
  it("throws away exactly the parts that differ between two exports", () => {
    // Case, whitespace and punctuation are re-rendered differently by the same
    // bank's CSV and XLS exports of the same transaction.
    const canonical = fingerprintNarration("UPI-SPOTIFY INDIA-9871234@ybl");
    expect(fingerprintNarration("  upi-spotify india-9871234@YBL  ")).toBe(canonical);
    expect(fingerprintNarration("UPI/SPOTIFY  INDIA/9871234@ybl")).toBe(canonical);
    expect(fingerprintNarration("UPI-SPOTIFY\tINDIA-9871234@ybl\n")).toBe(canonical);
  });

  it("keeps the reference number, which is the strongest identity a line has", () => {
    expect(fingerprintNarration("NEFT DR-ICIC0000123-RAJESH TRADERS-N023")).toContain("N023");
    expect(fingerprintNarration("NEFT DR-ICIC0000123-RAJESH TRADERS-N023")).toContain("ICIC0000123");
  });

  it("keeps two genuinely different narrations apart", () => {
    expect(fingerprintNarration("NEFT RAJESH TRADERS")).not.toBe(fingerprintNarration("NEFT ACME EXPORTS"));
  });

  it("never grows past its cap", () => {
    expect(fingerprintNarration("A".repeat(500))).toHaveLength(120);
  });

  // FAILS: two different transactions whose narrations share their first 120
  // characters produce the same fingerprintNarration, so they produce the same
  // fingerprint. It should distinguish them.
  //
  // fingerprintNarration() ends in .slice(0, 120). A NEFT/RTGS narration
  // carries the counterparty's full registered name, the branch and the IFSC
  // before it reaches the UTR, and routinely runs past 120 characters — which
  // puts the only part that differs between two transfers to the same
  // counterparty beyond the cut.
  //
  // Consequence: the two transfers below are the same date, the same amount and
  // the same direction, and they differ only in their reference. If they arrive
  // in the same file, assignOccurrenceIndexes gives them 0 and 1 and they
  // survive. If they arrive in two different uploads — the second is a later
  // "last 90 days" pull, or the first was posted last week — both get
  // occurrenceIndex 0, the fingerprints are identical, and
  // bank_statement_lines_fingerprint_idx rejects the second insert. The user
  // is told the line was already imported. A real ₹2,50,000 payment is missing
  // from the books and nothing in the app says so.
  it.skip("distinguishes two long narrations that differ only near the end", () => {
    const prefix =
      "NEFT CR-HDFC0000456-RAJESH KUMAR TRADERS PRIVATE LIMITED-MUMBAI FORT BRANCH-SETTLEMENT FOR INVOICE BATCH APRIL-2026-REF";
    expect(prefix.length).toBe(119);
    expect(fingerprintNarration(`${prefix}00991`)).not.toBe(fingerprintNarration(`${prefix}00992`));
  });

  // FAILS: fingerprintNarration("भुगतान राजेश ट्रेडर्स") returns "". It should
  // return something that distinguishes it from any other narration.
  //
  // The normalizer is .replace(/[^A-Z0-9]+/g, " ") after .toUpperCase(), so
  // every non-ASCII character is discarded. A narration written wholly in
  // Devanagari (or Tamil, or Gujarati) reduces to the empty string.
  //
  // Consequence: for regional-language statements the narration contributes
  // nothing to the fingerprint, which collapses to date + direction + amount +
  // occurrence index. Two unrelated ₹5,000 payments on the same day, in two
  // different uploads, are then indistinguishable and the second is dropped as
  // a duplicate. Same silent loss as the truncation case above, but it needs no
  // unusual length — only a bank that narrates in the local script.
  it.skip("keeps a non-Latin narration distinguishable", () => {
    const a = fingerprintNarration("भुगतान राजेश ट्रेडर्स");
    const b = fingerprintNarration("भुगतान अक्मे एक्सपोर्ट्स");
    expect(a).not.toBe("");
    expect(a).not.toBe(b);
  });
});

describe("buildFingerprint", () => {
  it("changes when any part of the transaction's identity changes", () => {
    const base = buildFingerprint({ ...SPOTIFY, occurrenceIndex: 0 });
    const variants = [
      { ...SPOTIFY, txnDate: "2026-04-16" },
      { ...SPOTIFY, direction: "deposit" as const },
      { ...SPOTIFY, amountPaise: 11901 },
      { ...SPOTIFY, narration: "UPI-NETFLIX-9871234@ybl" },
    ];
    for (const variant of variants) {
      expect(buildFingerprint({ ...variant, occurrenceIndex: 0 })).not.toBe(base);
    }
    expect(buildFingerprint({ ...SPOTIFY, occurrenceIndex: 1 })).not.toBe(base);
  });

  it("does not change when only the presentation of the narration changes", () => {
    expect(buildFingerprint({ ...SPOTIFY, narration: "  upi-spotify india-9871234@YBL-utr609812345  ", occurrenceIndex: 0 }))
      .toBe(buildFingerprint({ ...SPOTIFY, occurrenceIndex: 0 }));
  });

  it("stays readable, so a user can be shown why a line was called a duplicate", () => {
    // A hash would make the same collision an unexplainable one.
    expect(buildFingerprint({ ...SPOTIFY, occurrenceIndex: 0 }))
      .toBe("2026-04-15|W|11900|UPI SPOTIFY INDIA 9871234 YBL UTR609812345|0");
  });

  it("cannot be confused by a narration that contains the field separator", () => {
    // The separator is stripped by the normalizer, so a narration cannot forge
    // an extra field and collide with a different transaction.
    const forged = buildFingerprint({
      txnDate: "2026-04-15",
      direction: "withdrawal",
      amountPaise: 1,
      narration: "X|0|2026-04-15|W|11900|Y",
      occurrenceIndex: 0,
    });
    expect(forged).not.toBe(buildFingerprint({ ...SPOTIFY, occurrenceIndex: 0 }));
    expect(forged.split("|")).toHaveLength(5);
  });
});

describe("assignOccurrenceIndexes", () => {
  it("numbers genuinely repeated identical transactions within their group", () => {
    const lines = [
      { ...SPOTIFY },
      { ...SPOTIFY },
      { ...SPOTIFY, amountPaise: 49900 },
      { ...SPOTIFY, txnDate: "2026-04-16" },
    ];
    expect(assignOccurrenceIndexes(lines).map((l) => l.occurrenceIndex)).toEqual([0, 1, 0, 0]);
  });

  it("counts within the group, not the file, so two overlapping uploads agree", () => {
    // This is the property the whole duplicate guard rests on: the index of a
    // transaction must not depend on what else the file happened to contain.
    const march = [
      { ...SPOTIFY, txnDate: "2026-03-15" },
      { ...SPOTIFY, txnDate: "2026-03-20", amountPaise: 2500000 },
      { ...SPOTIFY },
      { ...SPOTIFY },
    ];
    const april = [
      { ...SPOTIFY },
      { ...SPOTIFY },
      { ...SPOTIFY, txnDate: "2026-04-28", amountPaise: 31000 },
    ];

    const inMarch = assignOccurrenceIndexes(march)
      .filter((l) => l.txnDate === SPOTIFY.txnDate)
      .map(buildFingerprint);
    const inApril = assignOccurrenceIndexes(april)
      .filter((l) => l.txnDate === SPOTIFY.txnDate)
      .map(buildFingerprint);

    expect(inMarch).toEqual(inApril);
    expect(new Set(inMarch).size).toBe(2);
  });

  it("is not disturbed by the narration re-wrapping between the two uploads", () => {
    const first = assignOccurrenceIndexes([{ ...SPOTIFY }, { ...SPOTIFY }]).map(buildFingerprint);
    const second = assignOccurrenceIndexes([
      { ...SPOTIFY, narration: "upi-spotify  india-9871234@YBL-utr609812345" },
      { ...SPOTIFY, narration: "  UPI/SPOTIFY/INDIA/9871234@ybl/UTR609812345" },
    ]).map(buildFingerprint);

    expect(second).toEqual(first);
  });

  it("leaves the input untouched", () => {
    const lines = [{ ...SPOTIFY }];
    assignOccurrenceIndexes(lines);
    expect(lines[0]).not.toHaveProperty("occurrenceIndex");
  });
});
