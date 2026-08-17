"use client";

import { formatCurrency, sumPaise, toPaise } from "@/lib/utils/currency";
import { formatIsoDate } from "@/lib/utils/statement-period";
import { rupeesInWords } from "@/lib/utils/number-to-words";
import type { InvoiceDocument as InvoiceDocumentData } from "@/lib/supabase/queries/vouchers";

/**
 * The document a customer or supplier actually receives.
 *
 * What it deliberately does not carry: tax, GST, HSN codes, GSTIN, a place of
 * supply, or a Rule 46 declaration. Migration 0021 is explicit that those
 * belong to a different product and that leaving hooks for them here is how
 * the two get entangled — so this prints what the books hold and nothing that
 * pretends to be a tax invoice.
 *
 * Every figure comes from `invoice_lines.line_amount`, the generated column,
 * read back after saving. Nothing on this page is recomputed from quantity and
 * rate: the printed total and the posted voucher are the same number by
 * construction.
 */
export function InvoiceDocument({ data }: { data: InvoiceDocumentData }) {
  const { voucher, company, party } = data;
  const isSales = voucher.voucherType === "sales";
  const lines = voucher.invoiceLines;

  const linePaise = lines.map((l) => toPaise(l.lineAmount));
  const discountPaise = sumPaise(lines.map((l) => toPaise(l.discountAmount)));
  const totalPaise = sumPaise(linePaise);
  // gross = what the lines came to before their discounts, reached from the
  // settled amounts rather than from quantity x rate a second time.
  const grossPaise = totalPaise + discountPaise;

  // The Discount column only appears when something was actually discounted,
  // so the totals rows have to span whatever is left of the header.
  const labelSpan = discountPaise !== 0 ? 5 : 4;

  const companyContact = [company.phone && `Phone ${company.phone}`, company.email].filter(Boolean).join(" · ");
  const partyContact = [party?.phone && `Phone ${party.phone}`, party?.email].filter(Boolean).join(" · ");

  return (
    <article className="invoice-sheet space-y-6 rounded-xl bg-card p-8 shadow-sm ring-1 ring-foreground/10">
      <header className="invoice-masthead flex flex-wrap items-start justify-between gap-6 border-b pb-4">
        <div className="min-w-0">
          <h2 className="invoice-company-name text-xl font-semibold tracking-tight">{company.name}</h2>
          {company.address && (
            <p className="invoice-company-contact mt-1 text-sm whitespace-pre-line text-muted-foreground">{company.address}</p>
          )}
          {companyContact && <p className="invoice-company-contact text-sm text-muted-foreground">{companyContact}</p>}
        </div>
        <div className="text-right">
          <p className="invoice-title text-xs font-medium tracking-widest text-muted-foreground uppercase">
            {isSales ? "Invoice" : "Purchase Bill"}
          </p>
          <p className="invoice-number font-mono text-lg font-semibold">{voucher.voucherNumber}</p>
          <p className="invoice-date text-sm text-muted-foreground">{formatIsoDate(voucher.voucherDate)}</p>
        </div>
      </header>

      <section className="invoice-parties grid gap-6 text-sm sm:grid-cols-2">
        <div>
          <p className="invoice-party-label text-xs font-medium tracking-wide text-muted-foreground uppercase">
            {isSales ? "Billed to" : "Received from"}
          </p>
          <p className="mt-1 font-medium">{party?.name ?? "—"}</p>
          {party?.contactPerson && <p className="text-muted-foreground">{party.contactPerson}</p>}
          {party?.address && <p className="whitespace-pre-line text-muted-foreground">{party.address}</p>}
          {partyContact && <p className="text-muted-foreground">{partyContact}</p>}
        </div>

        {(voucher.referenceNumber || voucher.referenceDate) && (
          <div className="sm:text-right">
            <p className="invoice-party-label text-xs font-medium tracking-wide text-muted-foreground uppercase">Reference</p>
            {voucher.referenceNumber && <p className="mt-1">{voucher.referenceNumber}</p>}
            {voucher.referenceDate && <p className="text-muted-foreground">{formatIsoDate(voucher.referenceDate)}</p>}
          </div>
        )}
      </section>

      {/* A long description list must scroll inside the document rather than
          push the page sideways; print.css turns this back to `visible` so a
          scroller can't clip the table on paper. */}
      <div className="invoice-lines-scroll overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-muted/40 text-xs font-medium tracking-wide text-muted-foreground uppercase">
            <tr>
              <th className="p-2.5 text-left font-medium">#</th>
              <th className="p-2.5 text-left font-medium">Description</th>
              <th className="p-2.5 text-right font-medium">Qty</th>
              <th className="p-2.5 text-right font-medium">Rate</th>
              {discountPaise !== 0 && <th className="p-2.5 text-right font-medium">Discount</th>}
              <th className="p-2.5 text-right font-medium">Amount</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((line, i) => (
              <tr key={line.id} className="border-t">
                <td className="p-2.5 text-muted-foreground tabular-nums">{i + 1}</td>
                <td className="p-2.5">{line.description}</td>
                <td className="p-2.5 text-right tabular-nums">
                  {formatQuantity(line.quantity)}
                  {line.unit ? ` ${line.unit}` : ""}
                </td>
                <td className="p-2.5 text-right tabular-nums">{formatRate(line.rate)}</td>
                {discountPaise !== 0 && (
                  <td className="p-2.5 text-right tabular-nums">
                    {line.discountAmount ? formatCurrency(line.discountAmount) : ""}
                  </td>
                )}
                <td className="p-2.5 text-right tabular-nums">{formatCurrency(line.lineAmount)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            {discountPaise !== 0 && (
              <>
                <tr>
                  <td className="p-2.5" colSpan={labelSpan}>
                    Subtotal
                  </td>
                  <td className="p-2.5 text-right tabular-nums">{formatCurrency(grossPaise / 100)}</td>
                </tr>
                <tr>
                  <td className="p-2.5" colSpan={labelSpan}>
                    Discount
                  </td>
                  <td className="p-2.5 text-right tabular-nums">− {formatCurrency(discountPaise / 100)}</td>
                </tr>
              </>
            )}
            <tr className="border-t-2 font-semibold">
              <td className="p-2.5" colSpan={labelSpan}>
                Total
              </td>
              <td className="p-2.5 text-right tabular-nums">{formatCurrency(totalPaise / 100)}</td>
            </tr>
          </tfoot>
        </table>
      </div>

      <p className="invoice-words text-sm">
        <span className="text-muted-foreground">Amount in words: </span>
        <span className="font-medium">{rupeesInWords(totalPaise)}</span>
      </p>

      {voucher.narration && (
        <p className="invoice-narration text-sm whitespace-pre-line text-muted-foreground">{voucher.narration}</p>
      )}

      <footer className="invoice-signature pt-8 text-right text-sm">
        <p>For {company.name}</p>
        <p className="mt-10 text-muted-foreground">Authorised Signatory</p>
      </footer>
    </article>
  );
}

/** numeric(18,3), but "10" reads better than "10.000" on a document. */
function formatQuantity(quantity: number): string {
  return new Intl.NumberFormat("en-IN", { minimumFractionDigits: 0, maximumFractionDigits: 3 }).format(quantity);
}

/** numeric(18,4), shown to at least two places so it reads as money. */
function formatRate(rate: number): string {
  return new Intl.NumberFormat("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 4 }).format(rate);
}
