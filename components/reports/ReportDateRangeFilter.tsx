"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { DateFieldSelects } from "@/components/reports/DateFieldSelects";
import { useFinancialYear } from "@/hooks/useFinancialYear";
import { useReportRangeStore } from "@/stores/useReportRangeStore";
import {
  financialYearAsOfDate,
  isCurrentFinancialYear,
  isoMonthStart,
  reportRangeStillApplies,
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
 *
 * The one period that is not a choice is the one before the company has
 * answered. `useFinancialYear` hands back a placeholder until then — the
 * financial year the calendar is in — and a continuous book's period is a
 * different one, so a range typed in that window was tagged with a year that
 * was about to change and was discarded the instant the company loaded. It is
 * tagged `null` instead, meaning "typed before there was a real period", and
 * re-tagged below the moment there is one.
 *
 * `reportKey` distinguishes one report's memory from another's (Daybook and
 * the Ledger Statement are independent habits) and seeds `override` from
 * useReportRangeStore on mount, so following a voucher link off the page and
 * back — or just reopening the report tomorrow — restores the range last
 * chosen here instead of dropping back to the whole financial year. Only the
 * *initial* value is read from the store; every render after that still
 * follows the exact same in-memory, year-tagged `override` this hook always
 * has, and `setRange` is the one place that writes a fresh choice back out to
 * it. Reading the store during render (rather than in an effect) is safe
 * here specifically because it only ever happens once, inside useState's own
 * lazy initializer — not a write, and not a subscription that could fire a
 * second time mid-render.
 */
export function useReportDateRange(companyId: string, reportKey: string) {
  const { selected, financialYearStartMonth, isCurrent, companySettingsKnown } = useFinancialYear(companyId);
  const storeKey = `${reportKey}:${companyId}`;
  const setPersistedOverride = useReportRangeStore((s) => s.setOverride);

  const [override, setOverride] = useState<{ startYear: number | null; range: DateRange } | null>(
    () => useReportRangeStore.getState().overrideByKey[storeKey] ?? null
  );

  // Adjusting state during render, which is what React asks for when state
  // has to follow a value that changed underneath it. An effect would repaint
  // once with the range already thrown away, and this loop is finite: after
  // the write the tag is a number and the condition is false.
  if (override !== null && override.startYear === null && companySettingsKnown) {
    setOverride({ startYear: selected.startYear, range: override.range });
  }

  const range =
    override !== null && reportRangeStillApplies(override.startYear, selected.startYear)
      ? override.range
      : defaultDateRange(selected);

  function setRange(next: DateRange) {
    const tagged = { startYear: companySettingsKnown ? selected.startYear : null, range: next };
    setOverride(tagged);
    setPersistedOverride(storeKey, tagged);
  }

  return {
    range,
    setRange,
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
  const { selected, asOfDate, isCurrent, companySettingsKnown } = useFinancialYear(companyId);

  const [override, setOverride] = useState<{ startYear: number | null; date: string } | null>(null);

  if (override !== null && override.startYear === null && companySettingsKnown) {
    setOverride({ startYear: selected.startYear, date: override.date });
  }

  const value =
    override !== null && reportRangeStillApplies(override.startYear, selected.startYear)
      ? override.date
      : asOfDate;

  return {
    asOfDate: value,
    setAsOfDate: (next: string) =>
      setOverride({ startYear: companySettingsKnown ? selected.startYear : null, date: next }),
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
      <DateFieldSelects value={value.from} onChange={(from) => onChange({ ...value, from })} yearsAround={financialYear.startYear} />
      <span className="text-sm text-muted-foreground">to</span>
      <DateFieldSelects value={value.to} onChange={(to) => onChange({ ...value, to })} yearsAround={financialYear.startYear} />
      {datePresets(financialYear).map((preset) => (
        <Button key={preset.label} type="button" variant="ghost" size="sm" onClick={() => onChange(preset.range())}>
          {preset.label}
        </Button>
      ))}
    </div>
  );
}
