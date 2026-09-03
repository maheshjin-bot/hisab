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
  listFinancialYears,
  parseIsoLocalDate,
  resolveFinancialYear,
  type FinancialYear,
} from "@/lib/utils/financial-year";

export interface UseFinancialYear {
  /** 1-12; the company's, not April by assumption. */
  financialYearStartMonth: number;
  /** Every year that can be selected, newest first. */
  years: FinancialYear[];
  /** The year the screens are drawn for. */
  selected: FinancialYear;
  /** True when the selected year is the one the business is trading in today. */
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

  const financialYearStartMonth = company?.financialYearStartMonth ?? DEFAULT_FINANCIAL_YEAR_START_MONTH;
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
      ? listFinancialYears(bookBeginningDate, financialYearStartMonth, today)
      : [currentYear];

    const selected = resolveFinancialYear(years, hydrated ? storedStartYear : undefined, today);

    return {
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
    financialYearStartMonth,
    todayIso,
    hydrated,
    storedStartYear,
    setSelectedStartYear,
  ]);
}
