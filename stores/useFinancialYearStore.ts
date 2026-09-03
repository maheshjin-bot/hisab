import { create } from "zustand";
import { persist } from "zustand/middleware";

interface FinancialYearState {
  /**
   * companyId -> the start year of the financial year being looked at.
   *
   * Keyed by company on purpose. One accountant keeps several sets of books
   * open at once and they are rarely in the same year: last year's, being
   * closed with a client, alongside this year's, still being written. A single
   * global value would silently drag one company's year onto another's books
   * on every switch.
   *
   * A company with no entry here is simply looking at the year it is trading
   * in — there is no "unset" state to render, and a company switched to for
   * the first time starts in the present, which is the right default.
   */
  selectedStartYearByCompany: Record<string, number>;
  setSelectedStartYear: (companyId: string, startYear: number) => void;
}

/**
 * Which financial year each company's screens are drawn for.
 *
 * Persisted like the density preference: this is a way of *looking* at the
 * books, not a fact about them. Nothing here filters or alters a voucher —
 * `financial_year_label` is stamped on a voucher when it is saved and is not
 * touched by this. All it changes is the period a report asks for.
 */
export const useFinancialYearStore = create<FinancialYearState>()(
  persist(
    (set) => ({
      selectedStartYearByCompany: {},
      setSelectedStartYear: (companyId, startYear) =>
        set((s) => ({
          selectedStartYearByCompany: { ...s.selectedStartYearByCompany, [companyId]: startYear },
        })),
    }),
    { name: "hisab:financial-year" }
  )
);
