"use client";

import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

export interface DateRange {
  from: string;
  to: string;
}

function isoToday() {
  return new Date().toISOString().slice(0, 10);
}

function isoMonthStart() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
}

function isoFinancialYearStart() {
  const d = new Date();
  const year = d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1; // FY starts April (month index 3)
  return `${year}-04-01`;
}

export const DATE_RANGE_PRESETS: { label: string; range: () => DateRange }[] = [
  { label: "This month", range: () => ({ from: isoMonthStart(), to: isoToday() }) },
  { label: "This year", range: () => ({ from: isoFinancialYearStart(), to: isoToday() }) },
];

export function ReportDateRangeFilter({ value, onChange }: { value: DateRange; onChange: (range: DateRange) => void }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Input type="date" value={value.from} onChange={(e) => onChange({ ...value, from: e.target.value })} className="w-40" />
      <span className="text-sm text-muted-foreground">to</span>
      <Input type="date" value={value.to} onChange={(e) => onChange({ ...value, to: e.target.value })} className="w-40" />
      {DATE_RANGE_PRESETS.map((preset) => (
        <Button key={preset.label} type="button" variant="ghost" size="sm" onClick={() => onChange(preset.range())}>
          {preset.label}
        </Button>
      ))}
    </div>
  );
}

export function defaultDateRange(): DateRange {
  return { from: isoFinancialYearStart(), to: isoToday() };
}
