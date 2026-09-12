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

  // The cap is spent on both ends of the narration, not just the start, and
  // this is why. A NEFT/RTGS narration carries the counterparty's registered
  // name, branch and IFSC before it reaches the UTR, and routinely runs past
  // the cap — so the only part that tells two transfers to the same payee
  // apart sits beyond a plain head-truncation.
  //
  // What that cost: the two transfers below share a date, an amount and a
  // direction. Arriving in one file, assignOccurrenceIndexes numbered them 0
  // and 1 and both survived. Arriving in two uploads — a later "last 90 days"
  // pull, or the first posted a week earlier — both took occurrenceIndex 0,
  // the fingerprints matched, and bank_statement_lines_fingerprint_idx
  // rejected the second as already imported. A real ₹2,50,000 payment went
  // missing from the books with nothing in the app saying so.
  it("distinguishes two long narrations that differ only near the end", () => {
    const prefix =
      "NEFT CR-HDFC0000456-RAJESH KUMAR TRADERS PRIVATE LIMITED-MUMBAI FORT BRANCH-SETTLEMENT FOR INVOICE BATCH APRIL-2026-REF";
    expect(prefix.length).toBe(119);
    expect(fingerprintNarration(`${prefix}00991`)).not.toBe(fingerprintNarration(`${prefix}00992`));
  });

  // The normalizer matches letters by Unicode property rather than A-Z, and
  // this is why. An earlier .replace(/[^A-Z0-9]+/g, " ") discarded every
  // non-ASCII character, so a narration written wholly in Devanagari (or
  // Tamil, or Gujarati) reduced to the empty string.
  //
  // What that cost: for regional-language statements the narration contributed
  // nothing, and the fingerprint collapsed to date + direction + amount +
  // occurrence index. Two unrelated ₹5,000 payments on the same day, in two
  // different uploads, became indistinguishable and the second was dropped as
  // a duplicate — the same silent loss as the truncation case above, but
  // needing no unusual length, only a bank that narrates in the local script.
  it("keeps a non-Latin narration distinguishable", () => {
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
