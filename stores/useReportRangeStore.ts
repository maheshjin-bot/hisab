import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { DateRange } from "@/components/reports/ReportDateRangeFilter";

interface TaggedRange {
  /**
   * The financial year the range was chosen under, or null while the
   * company's own settings haven't loaded yet — see reportRangeStillApplies
   * in lib/utils/financial-year.ts, the same rule useReportDateRange already
   * applies to its in-memory copy of this value. Without the tag, a range
   * picked while looking at FY 2025-26 would silently keep applying after
   * switching to FY 2026-27, making the year selector appear to do nothing.
   */
  startYear: number | null;
  range: DateRange;
}

interface ReportRangeState {
  /** `${reportKey}:${companyId}` -> the last range explicitly chosen there. */
  overrideByKey: Record<string, TaggedRange>;
  setOverride: (key: string, override: TaggedRange) => void;
}

/**
 * Remembers the date range a person last chose on a report, across
 * navigating away and back — reopening a bill from the Ledger Statement to
 * fix a typo and returning used to drop a wide custom range back to the
 * default financial year every time. Persisted the same way the financial
 * year selector itself is (see useFinancialYearStore): this is how someone
 * is *looking* at the books, not a fact about them.
 *
 * Keyed by report and company together, not by report alone — Daybook and
 * the Ledger Statement are independent habits, and one company's preferred
 * window has no bearing on another's.
 */
export const useReportRangeStore = create<ReportRangeState>()(
  persist(
    (set) => ({
      overrideByKey: {},
      setOverride: (key, override) => set((s) => ({ overrideByKey: { ...s.overrideByKey, [key]: override } })),
    }),
    { name: "hisab:report-range" }
  )
);
