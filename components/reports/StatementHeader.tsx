"use client";

import { useEffect, useRef } from "react";
import { useCompanyQuery } from "@/hooks/useCompaniesQuery";

/**
 * The masthead on a printed statement. Invisible on screen — the page already
 * has a title and a filter bar up there — and the only thing identifying the
 * document once it's on paper or in a PDF.
 *
 * `period` is the report's own wording: "As of 31 March 2026" for the
 * position statements, "1 April 2025 to 31 March 2026" for the flow ones.
 */
export function StatementHeader({
  companyId,
  title,
  period,
}: {
  companyId: string;
  title: string;
  period: string;
}) {
  const { data: company } = useCompanyQuery(companyId);

  return (
    <header data-print-only className="statement-header">
      <p className="statement-company">{company?.name ?? ""}</p>
      <h2 className="statement-title">{title}</h2>
      <p className="statement-period">{period}</p>
      {company?.baseCurrency && (
        <p className="statement-meta">All amounts in {company.baseCurrency}</p>
      )}
    </header>
  );
}

/**
 * The bottom of a printed statement. Page numbers deliberately aren't here:
 * Chrome and Edge don't implement the `@page` margin boxes that would be
 * needed to produce them, and the browser's own print footer already offers
 * them as a setting.
 */
export function StatementFooter({ note }: { note?: string }) {
  // Written straight to the DOM on beforeprint rather than held in state.
  // Rendering `new Date()` would mismatch on hydration — server clock versus
  // browser clock — and stamping it once at mount would date the statement to
  // whenever the tab was opened rather than to when it was actually printed.
  const stampRef = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    function stamp() {
      if (!stampRef.current) return;
      const now = new Date().toLocaleString("en-IN", { dateStyle: "long", timeStyle: "short" });
      stampRef.current.textContent = `Generated ${now}`;
    }
    window.addEventListener("beforeprint", stamp);
    return () => window.removeEventListener("beforeprint", stamp);
  }, []);

  return (
    <footer data-print-only className="statement-footer">
      {note && <p className="statement-footer-note">{note}</p>}
      <p ref={stampRef} className="statement-meta" />
    </footer>
  );
}
