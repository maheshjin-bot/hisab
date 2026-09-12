"use client";

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { daysInMonth, formatDateParts, MONTH_NAMES, parseDateParts, yearOptions } from "@/lib/utils/date-parts";

const MONTH_ITEMS = Object.fromEntries(MONTH_NAMES.map((name, i) => [String(i + 1), name]));

/**
 * A `YYYY-MM-DD` value as three dropdowns instead of one native date input.
 *
 * The native input's own calendar popup makes sense for picking a date near
 * today, but is impractical for the kind of range this app actually asks
 * for — an opening balance from three years ago, or a report spanning a
 * whole multi-year audit — where it means clicking "previous month" dozens
 * of times. Jumping straight to a year and month is the whole point.
 *
 * `yearsAround` centers the year list on the report's own financial year
 * rather than today, so a report opened for FY 2019-20 offers 2019 without
 * scrolling, even if "today" is 2026.
 */
export function DateFieldSelects({
  value,
  onChange,
  yearsAround,
}: {
  value: string;
  onChange: (iso: string) => void;
  yearsAround: number;
}) {
  const { year, month, day } = parseDateParts(value);
  const days = Array.from({ length: daysInMonth(year, month) }, (_, i) => i + 1);
  const years = yearOptions(yearsAround);

  return (
    <div className="flex gap-1">
      <Select value={String(day)} onValueChange={(v) => onChange(formatDateParts(year, month, Number(v)))}>
        <SelectTrigger size="sm" className="w-15">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {days.map((d) => (
            <SelectItem key={d} value={String(d)}>
              {d}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select value={String(month)} items={MONTH_ITEMS} onValueChange={(v) => onChange(formatDateParts(year, Number(v), day))}>
        <SelectTrigger size="sm" className="w-18">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {MONTH_NAMES.map((name, i) => (
            <SelectItem key={name} value={String(i + 1)}>
              {name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select value={String(year)} onValueChange={(v) => onChange(formatDateParts(Number(v), month, day))}>
        <SelectTrigger size="sm" className="w-19">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {years.map((y) => (
            <SelectItem key={y} value={String(y)}>
              {y}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
