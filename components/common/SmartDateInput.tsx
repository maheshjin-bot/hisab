"use client";

import { useState } from "react";
import { Input } from "@/components/ui/input";
import { parseSmartDate } from "@/lib/utils/date-shortcuts";

function toIsoDate(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function fromIsoDate(iso: string) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
}

/**
 * Accepts Tally-style shortcuts (today, +3d, a bare day-of-month, dd/mm) as
 * well as a plain date picker. Shortcuts resolve on blur/Enter, never per
 * keystroke, so a full dd/mm/yyyy typed in normally is never fought.
 */
export function SmartDateInput({
  value,
  onChange,
  id,
  autoFocus,
  onKeyDownCapture,
}: {
  value: string;
  onChange: (isoDate: string) => void;
  id?: string;
  autoFocus?: boolean;
  onKeyDownCapture?: (e: React.KeyboardEvent) => void;
}) {
  const [text, setText] = useState(value);
  // "Adjusting state when a prop changes", per React's own recommended
  // pattern — setState during render (not in an effect) when a tracked prev
  // value differs, which React handles as a same-pass re-render rather than
  // an extra effect-cascade.
  const [prevValue, setPrevValue] = useState(value);
  if (value !== prevValue) {
    setPrevValue(value);
    setText(value);
  }

  function commit() {
    const parsed = parseSmartDate(text, value ? fromIsoDate(value) : new Date());
    if (parsed) {
      const iso = toIsoDate(parsed);
      setText(iso);
      onChange(iso);
    } else {
      setText(value);
    }
  }

  return (
    <Input
      id={id}
      autoFocus={autoFocus}
      value={text}
      placeholder="today, +3d, 15…"
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDownCapture={onKeyDownCapture}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === "Tab") commit();
      }}
    />
  );
}
