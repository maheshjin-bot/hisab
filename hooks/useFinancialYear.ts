"use client";

import { useMemo } from "react";
import { useCompaniesQuery } from "./useCompaniesQuery";
import { useHydrated } from "./useHydrated";
import { useFinancialYearStore } from "@/stores/useFinancialYearStore";
import {
  DEFAULT_FINANCIAL_YEAR_START_MONTH,
  financialYearAsOfDate,
  financialYearContaining,
  isCurrentFinancialYear,
  isoLocalDate,
  listBooksPeriods,
  parseIsoLocalDate,
  resolveFinancialYear,
  type FinancialYear,
} from "@/lib/utils/financial-year";

export interface UseFinancialYear {
  /**
   * True once the company's own row is in hand, so the two values below are
   * its answers rather than this hook's defaults.
   *
   * Anything that would put the word "year" — or a year — on the screen has
   * to gate on this and not on `usesFinancialYears` alone, because that
   * defaults to true while the companies query is in flight and would show
   * "FY 2026-27" for one paint over a book that keeps no years. See
   * showsFinancialYear() in lib/utils/financial-year.ts, which is that gate.
   */
  companySettingsKnown: boolean;
  /**
   * False when the company keeps one continuous set of books. Everything
   * below still works — there is simply one period rather than a list of
   * years, and it is the period the books are in rather than a year — but a
   * caller that puts the word "year" on the screen has to ask this first.
   */
  usesFinancialYears: boolean;
  /** 1-12; the company's, not April by assumption. Meaningless, and unread, when `usesFinancialYears` is false. */
  financialYearStartMonth: number;
  /** Every year that can be selected, newest first — or the one continuous period, when there are no years. */
  years: FinancialYear[];
  /** The period the screens are drawn for. */
  selected: FinancialYear;
  /** True when the selected period is the one the business is trading in today — always true of a continuous book, which never closes. */
  isCurrent: boolean;
  /** The date reports should be drawn up to: today in the current year, the closing date in a finished one. */
  asOfDate: string;
  select: (startYear: number) => void;
}

/**
 * The financial year the app is currently showing, for one company.
 *
 * Reads the company out of the switcher's own companies list rather than
 * issuing a query of its own — the shell has already fetched it on every
 * screen inside `/[companyId]`, so this costs nothing.
 *
 * Before hydration the stored choice is deliberately ignored and the current
 * year is used. The server cannot know what is in localStorage, and rendering
 * the remembered year on the first client pass would be a hydration mismatch;
 * the same reason DensityMenuItems waits for `useHydrated`.
 */
export function useFinancialYear(companyId: string | undefined): UseFinancialYear {
  const { data: companies } = useCompaniesQuery();
  const company = companies?.find((c) => c.id === companyId);
  const hydrated = useHydrated();

  const storedStartYear = useFinancialYearStore((s) =>
    companyId ? s.selectedStartYearByCompany[companyId] : undefined
  );
  const setSelectedStartYear = useFinancialYearStore((s) => s.setSelectedStartYear);

  // Whether the two values below are the company's answers or this hook's
  // defaults. Undefined while the query is in flight, and also when the list
  // has arrived without this company in it — a member who has just lost
  // access — which is equally "not known" and must be gated the same way.
  const companySettingsKnown = company !== undefined;

  const financialYearStartMonth = company?.financialYearStartMonth ?? DEFAULT_FINANCIAL_YEAR_START_MONTH;
  // True until the company loads, which is what every company created before
  // this setting existed is — so the shell opens on the behaviour it has
  // always had and settles, rather than opening on the rarer one. It is a
  // default and not an answer, which is what `companySettingsKnown` above is
  // for: reading it as an answer is how "FY 2026-27" came to flash over a
  // book with no years.
  const usesFinancialYears = company?.usesFinancialYears ?? true;
  const bookBeginningDate = company?.bookBeginningDate;

  // A date, not a Date: `new Date()` is a fresh object every render and would
  // defeat the memo, while the calendar day it stands for changes at most once
  // a day.
  const todayIso = isoLocalDate(new Date());

  return useMemo(() => {
    const today = parseIsoLocalDate(todayIso);
    const currentYear = financialYearContaining(today, financialYearStartMonth);

    // Until the company loads there is nothing to enumerate from, so the list
    // is just the year we are in — which is also what the old hardcoded label
    // showed, so nothing flickers backwards on the way in.
    const years = bookBeginningDate
      ? listBooksPeriods(usesFinancialYears, bookBeginningDate, financialYearStartMonth, today)
      : [currentYear];

    const selected = resolveFinancialYear(years, hydrated ? storedStartYear : undefined, today);

    return {
      companySettingsKnown,
      usesFinancialYears,
      financialYearStartMonth,
      years,
      selected,
      isCurrent: isCurrentFinancialYear(selected, today),
      asOfDate: financialYearAsOfDate(selected, today),
      select: (startYear: number) => {
        if (companyId) setSelectedStartYear(companyId, startYear);
      },
    };
  }, [
    companyId,
    bookBeginningDate,
    companySettingsKnown,
    financialYearStartMonth,
    usesFinancialYears,
    todayIso,
    hydrated,
    storedStartYear,
    setSelectedStartYear,
  ]);
}
