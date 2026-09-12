"use client";

import { use, useMemo, useState } from "react";
import { DataTable } from "@/components/data-table/DataTable";
import { buildOutstandingColumns } from "@/components/outstanding/outstanding-columns";
import { PrintButton } from "@/components/reports/PrintButton";
import { StatementFooter, StatementHeader } from "@/components/reports/StatementHeader";
import { useOutstandingQuery } from "@/hooks/useReportsQueries";
import type { OutstandingRow } from "@/lib/supabase/queries/reports";
import { formatCurrency, fromPaise, sumPaise, toPaise } from "@/lib/utils/currency";
import { isoLocalDate } from "@/lib/utils/financial-year";
import { asOfPeriod } from "@/lib/utils/statement-period";

/** Rupee totals are added in integer paise — see lib/utils/currency.ts. */
function total(rows: OutstandingRow[]): number {
  return fromPaise(sumPaise(rows.map((r) => toPaise(r.amount))));
}

function Section({
  title,
  blurb,
  rows,
  columns,
  isLoading,
  emptyState,
}: {
  title: string;
  blurb: string;
  rows: OutstandingRow[];
  columns: ReturnType<typeof buildOutstandingColumns>;
  isLoading: boolean;
  emptyState: string;
}) {
  return (
    <section data-print-group className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h2 className="text-base font-semibold tracking-tight">{title}</h2>
          <p data-print-hide className="text-sm text-muted-foreground">
            {blurb}
          </p>
        </div>
        {/* The total is above the list, not below it: it is the number he came
            for, and a total under a long list is a number he has to scroll to
            find. */}
        <p className="text-xl font-semibold tabular-nums">{isLoading ? "—" : formatCurrency(total(rows))}</p>
      </div>
      <DataTable
        columns={columns}
        data={rows}
        rowCount={rows.length}
        // The list is a whole answer, not a page of one, and the server has
        // already put the biggest first. A page size nothing can reach keeps
        // the pager out of the way; the columns are unsortable for the same
        // reason.
        state={{ pagination: { pageIndex: 0, pageSize: 10_000 }, sorting: [] }}
        onPaginationChange={() => {}}
        onSortingChange={() => {}}
        isLoading={isLoading}
        emptyState={emptyState}
      />
    </section>
  );
}

/**
 * WHO OWES ME.
 *
 * The one number a shopkeeper checks every morning, and until now the only one
 * the app could not show him: the Balance Sheet reports "Sundry Debtors" as a
 * single total with no names in it, and nothing anywhere listed the parties.
 *
 * It sits in the main navigation rather than under Reports because it is not a
 * statement anyone prepares at year end — it is the first screen of the day,
 * next to the dashboard.
 *
 * There is no date filter, deliberately. The answer is life to date; see
 * migration 0025 for why an as-of date would be both a wrong answer and one
 * more control on the screen that is meant to have none.
 */
export default function OutstandingPage({ params }: PageProps<"/[companyId]/outstanding">) {
  const { companyId } = use(params);
  const { data, isLoading } = useOutstandingQuery(companyId);

  // Fixed for the life of the page so the "3 months ago" column cannot shift
  // under a re-render. Nothing renders from it until the query resolves, so it
  // is never part of the hydrated markup.
  const [today] = useState(() => new Date());
  const columns = useMemo(() => buildOutstandingColumns(companyId, today), [companyId, today]);

  const rows = data ?? [];
  const receivables = rows.filter((r) => r.direction === "receivable");
  const payables = rows.filter((r) => r.direction === "payable");

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-6">
      <StatementHeader companyId={companyId} title="Who Owes Me" period={asOfPeriod(isoLocalDate(today))} />

      <div data-print-hide className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Who owes me</h1>
          <p className="text-sm text-muted-foreground">
            Money still to come in, and money still to go out. Biggest first.
          </p>
        </div>
        <PrintButton />
      </div>

      <Section
        title="Money owed to you"
        blurb="Customers who have not paid you yet, and advances you have paid your suppliers."
        rows={receivables}
        columns={columns}
        isLoading={isLoading}
        emptyState="Nobody owes you anything right now."
      />

      <Section
        title="Money you owe"
        blurb="Suppliers you have not paid yet, and advances your customers have paid you."
        rows={payables}
        columns={columns}
        isLoading={isLoading}
        emptyState="You do not owe anybody right now."
      />

      <StatementFooter
        note={
          isLoading
            ? undefined
            : `Owed to you ${formatCurrency(total(receivables))} · Owed by you ${formatCurrency(total(payables))}`
        }
      />
    </div>
  );
}
