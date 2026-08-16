"use client";

import { Printer } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * Sits beside Export CSV on every report. window.print() rather than a
 * generated PDF: the print dialog already offers "Save as PDF" everywhere,
 * and the statement is styled in print.css, so both routes produce the same
 * document.
 */
export function PrintButton() {
  return (
    <Button variant="outline" size="sm" data-print-hide onClick={() => window.print()}>
      <Printer data-icon="inline-start" />
      Print
    </Button>
  );
}
