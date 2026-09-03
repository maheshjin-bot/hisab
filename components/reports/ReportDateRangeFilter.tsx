"use client";

import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useFinancialYear } from "@/hooks/useFinancialYear";
import {
  financialYearAsOfDate,
  isCurrentFinancialYear,
  isoMonthStart,
  type FinancialYear,
} from "@/lib/utils/financial-year";

export interface DateRange {
  from: string;
  to: string;
}

/**
 * Quick periods *within the selected financial year*.
 *
 * These used to be anchored to today, which made both of them wrong the
 * moment the year being looked at wasn't the current one: "This year" would
 * jump the report out of the year the shell said it was showing. Now the
 * whole-year preset names the year it will apply, and the month preset is
 * whichever month is the useful one — the month in progress while the year is
 * still running, and the closing month once it's finished, which is the one a
 * year-end review actually wants.
 */
export function datePresets(financialYear: FinancialYear, today: Date = new Date()): { label: string; range: () => DateRange }[] {
  const current = isCurrentFinancialYear(financialYear, today);
  const to = financialYearAsOfDate(financialYear, today);
  const monthLabel = current ? "This month" : `${monthName(to)} (closing month)`;

  return [
    { label: monthLabel, range: () => ({ from: isoMonthStart(to), to }) },
    { label: financialYear.label, range: () => ({ from: financialYear.start, to }) },
  ];
}

function monthName(iso: string): string {
  const [year, month] = iso.split("-").map(Number);
  return new Date(year, month - 1, 1).toLocaleDateString("en-IN", { month: "short", year: "numeric" });
}

/** The full span of the selected year, stopping at today while that year is still running. */
export function defaultDateRange(financialYear: FinancialYear, today: Date = new Date()): DateRange {
  return { from: financialYear.start, to: financialYearAsOfDate(financialYear, today) };
}

/**
 * The date range for a report page.
 *
 * The range is derived from the financial year chosen in the shell rather
 * than seeded into state, so it follows both the company (whose FY start
 * month isn't known on first render) and the selected year. `override` holds
 * the user's explicit narrowing and wins — but only for the year it was made
 * in: a range typed while looking at FY 2025-26 must not survive a switch to
 * FY 2026-27, or the selector would appear to do nothing. Tagging the
 * override with its year expresses that without an effect that resets state.
 */
export function useReportDateRange(companyId: string) {
  const { selected, financialYearStartMonth, isCurrent } = useFinancialYear(companyId);

  const [override, setOverride] = useState<{ startYear: number; range: DateRange } | null>(null);
  const range = override?.startYear === selected.startYear ? override.range : defaultDateRange(selected);

  return {
    range,
    setRange: (next: DateRange) => setOverride({ startYear: selected.startYear, range: next }),
    financialYearStartMonth,
    financialYear: selected,
    isCurrentFinancialYear: isCurrent,
  };
}

/**
 * The single as-of date for a position statement (Trial Balance, Balance
 * Sheet). Same rule as the range above: it opens on the selected year's
 * closing date — today while that year is still running — and a date typed by
 * hand holds only until a different year is chosen.
 */
export function useReportAsOfDate(companyId: string) {
  const { selected, asOfDate, isCurrent } = useFinancialYear(companyId);

  const [override, setOverride] = useState<{ startYear: number; date: string } | null>(null);
  const value = override?.startYear === selected.startYear ? override.date : asOfDate;

  return {
    asOfDate: value,
    setAsOfDate: (next: string) => setOverride({ startYear: selected.startYear, date: next }),
    financialYear: selected,
    isCurrentFinancialYear: isCurrent,
  };
}

export function ReportDateRangeFilter({
  value,
  onChange,
  financialYear,
}: {
  value: DateRange;
  onChange: (range: DateRange) => void;
  financialYear: FinancialYear;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Input type="date" value={value.from} onChange={(e) => onChange({ ...value, from: e.target.value })} className="w-40" />
      <span className="text-sm text-muted-foreground">to</span>
      <Input type="date" value={value.to} onChange={(e) => onChange({ ...value, to: e.target.value })} className="w-40" />
      {datePresets(financialYear).map((preset) => (
        <Button key={preset.label} type="button" variant="ghost" size="sm" onClick={() => onChange(preset.range())}>
          {preset.label}
        </Button>
      ))}
    </div>
  );
}
