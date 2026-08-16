"use client";

import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useCompanyQuery } from "@/hooks/useCompaniesQuery";
import {
  DEFAULT_FINANCIAL_YEAR_START_MONTH,
  isoFinancialYearStart,
  isoLocalDate,
} from "@/lib/utils/financial-year";

export interface DateRange {
  from: string;
  to: string;
}

function isoToday() {
  return isoLocalDate(new Date());
}

function isoMonthStart() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
}

export function datePresets(financialYearStartMonth: number): { label: string; range: () => DateRange }[] {
  return [
    { label: "This month", range: () => ({ from: isoMonthStart(), to: isoToday() }) },
    {
      label: "This year",
      range: () => ({ from: isoFinancialYearStart(new Date(), financialYearStartMonth), to: isoToday() }),
    },
  ];
}

/**
 * Takes the company's financial-year start month rather than assuming April.
 * It's a required argument on purpose: the previous default was baked into
 * this module, so a report page could keep the wrong one without saying so.
 */
export function defaultDateRange(financialYearStartMonth: number): DateRange {
  return { from: isoFinancialYearStart(new Date(), financialYearStartMonth), to: isoToday() };
}

/**
 * The date range for a report page.
 *
 * The company's FY start month isn't known on first render, so the range is
 * derived rather than seeded into state: `override` holds the user's explicit
 * choice and wins once made, and until then the range follows the company as
 * soon as it loads. Seeding state instead would freeze whatever default
 * happened to be current before the query resolved.
 */
export function useReportDateRange(companyId: string) {
  const { data: company } = useCompanyQuery(companyId);
  const financialYearStartMonth =
    company?.financialYearStartMonth ?? DEFAULT_FINANCIAL_YEAR_START_MONTH;

  const [override, setOverride] = useState<DateRange | null>(null);
  const range = override ?? defaultDateRange(financialYearStartMonth);

  return { range, setRange: setOverride, financialYearStartMonth };
}

export function ReportDateRangeFilter({
  value,
  onChange,
  financialYearStartMonth = DEFAULT_FINANCIAL_YEAR_START_MONTH,
}: {
  value: DateRange;
  onChange: (range: DateRange) => void;
  financialYearStartMonth?: number;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Input type="date" value={value.from} onChange={(e) => onChange({ ...value, from: e.target.value })} className="w-40" />
      <span className="text-sm text-muted-foreground">to</span>
      <Input type="date" value={value.to} onChange={(e) => onChange({ ...value, to: e.target.value })} className="w-40" />
      {datePresets(financialYearStartMonth).map((preset) => (
        <Button key={preset.label} type="button" variant="ghost" size="sm" onClick={() => onChange(preset.range())}>
          {preset.label}
        </Button>
      ))}
    </div>
  );
}
