"use client";

import { useForm, Controller, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Field, FieldGroup, FieldLabel, FieldError, FieldDescription } from "@/components/ui/field";
import { useCreateCompanyMutation } from "@/hooks/useCompaniesQuery";
import { useCompanyStore } from "@/stores/useCompanyStore";
import { DEFAULT_FINANCIAL_YEAR_START_MONTH } from "@/lib/utils/financial-year";
import { toUserMessage } from "@/lib/errors";

/**
 * The question is the business one, not the setting.
 *
 * "Do you use financial years?" is unanswerable by the person this exists for
 * — a trader who has never been asked to think about it, because nobody files
 * anything for him. "Do you close your books every year?" is a fact about how
 * he works that he already knows, and the accountant hint tells the other half
 * of the market which answer is theirs without making it the loud one.
 *
 * The values are the strings the radio inputs carry; the boolean the RPC wants
 * is derived once, at submit.
 */
const CLOSES_BOOKS = {
  yes: {
    title: "Yes — start fresh numbering each financial year",
    detail: "Bills read SAL/2025-26/00001 and restart every year. Needed if an accountant files returns for you.",
  },
  no: {
    title: "No — one continuous set of books",
    detail: "Bills read SAL/00001, SAL/00002 … one running series that never restarts.",
  },
} as const;

/** 1-12 in the order a Select should list them, labelled the way a person names a month. */
const MONTHS = Array.from({ length: 12 }, (_, i) => ({
  value: String(i + 1),
  label: new Date(2000, i).toLocaleString("en-IN", { month: "long" }),
}));
const MONTH_LABELS = Object.fromEntries(MONTHS.map((m) => [m.value, m.label]));

const schema = z.object({
  name: z.string().trim().min(1, { error: "Company name is required" }),
  bookBeginningDate: z.string().min(1, { error: "Book beginning date is required" }),
  closesBooks: z.enum(["yes", "no"]),
  financialYearStartMonth: z.string(),
});

type FormValues = z.infer<typeof schema>;

export function CreateCompanyDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const router = useRouter();
  const createCompany = useCreateCompanyMutation();
  const setRecentCompanyId = useCompanyStore((s) => s.setRecentCompanyId);

  const {
    control,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      name: "",
      bookBeginningDate: `${new Date().getFullYear()}-04-01`,
      closesBooks: "yes",
      financialYearStartMonth: String(DEFAULT_FINANCIAL_YEAR_START_MONTH),
    },
  });

  const closesBooks = useWatch({ control, name: "closesBooks" });

  async function onSubmit(values: FormValues) {
    try {
      const usesFinancialYears = values.closesBooks === "yes";
      const companyId = await createCompany.mutateAsync({
        name: values.name,
        bookBeginningDate: values.bookBeginningDate,
        // Left at the default for a company that keeps no years. The column is
        // NOT NULL and nothing reads it in that case, so sending a month the
        // user was never shown would only put a number in the books that
        // means nothing.
        financialYearStartMonth: usesFinancialYears
          ? Number(values.financialYearStartMonth)
          : DEFAULT_FINANCIAL_YEAR_START_MONTH,
        baseCurrency: "INR",
        usesFinancialYears,
      });
      setRecentCompanyId(companyId);
      reset();
      onOpenChange(false);
      router.push(`/${companyId}/dashboard`);
    } catch (err) {
      toast.error(toUserMessage(err, "Could not create company"));
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New company</DialogTitle>
          <DialogDescription>
            The Indian chart of accounts is pre-loaded automatically. Base currency is ₹.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit(onSubmit)}>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="company-name">Company name</FieldLabel>
              <Controller
                name="name"
                control={control}
                render={({ field }) => <Input id="company-name" autoFocus {...field} />}
              />
              {errors.name && <FieldError>{errors.name.message}</FieldError>}
            </Field>
            <Field>
              <FieldLabel htmlFor="book-beginning-date">Book beginning date</FieldLabel>
              <Controller
                name="bookBeginningDate"
                control={control}
                render={({ field }) => <Input id="book-beginning-date" type="date" {...field} />}
              />
              <FieldDescription>Opening balances are calculated as of this date.</FieldDescription>
              {errors.bookBeginningDate && <FieldError>{errors.bookBeginningDate.message}</FieldError>}
            </Field>

            <Field>
              {/* A fieldset rather than a Select: this is the one decision on
                  the form that cannot be revisited once the books have started,
                  so both answers and what each one means are on the screen at
                  once rather than one behind a click. */}
              <fieldset>
                <legend className="text-sm font-medium">Do you close your books every year?</legend>
                <Controller
                  name="closesBooks"
                  control={control}
                  render={({ field }) => (
                    <div className="mt-2 space-y-2">
                      {(["yes", "no"] as const).map((answer) => (
                        <label
                          key={answer}
                          htmlFor={`closes-books-${answer}`}
                          className="flex cursor-pointer gap-2.5 rounded-lg p-2.5 ring-1 ring-foreground/10 has-checked:bg-accent has-checked:ring-foreground/25"
                        >
                          <input
                            id={`closes-books-${answer}`}
                            type="radio"
                            className="mt-1 size-3.5 shrink-0 accent-primary"
                            name={field.name}
                            value={answer}
                            checked={field.value === answer}
                            onChange={() => field.onChange(answer)}
                            onBlur={field.onBlur}
                          />
                          <span className="flex min-w-0 flex-col gap-0.5">
                            <span className="text-sm">{CLOSES_BOOKS[answer].title}</span>
                            <span className="text-xs text-muted-foreground">{CLOSES_BOOKS[answer].detail}</span>
                          </span>
                        </label>
                      ))}
                    </div>
                  )}
                />
              </fieldset>
              <FieldDescription>
                This is fixed once the first voucher is entered, because the numbering already issued cannot be
                rewritten.
              </FieldDescription>
            </Field>

            {/* Only under "Yes". A start month is a property of a financial
                year, and a company that keeps none has no use for one. */}
            {closesBooks === "yes" && (
              <Field>
                <FieldLabel htmlFor="fy-start-month">Financial year starts in</FieldLabel>
                <Controller
                  name="financialYearStartMonth"
                  control={control}
                  render={({ field }) => (
                    <Select
                      value={field.value}
                      items={MONTH_LABELS}
                      onValueChange={(v) => v && field.onChange(v)}
                    >
                      <SelectTrigger id="fy-start-month" className="w-48">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {MONTHS.map((m) => (
                          <SelectItem key={m.value} value={m.value}>
                            {m.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                />
                <FieldDescription>April, unless your books run to some other year end.</FieldDescription>
              </Field>
            )}
          </FieldGroup>
          <DialogFooter className="mt-4">
            <Button type="submit" disabled={createCompany.isPending}>
              {createCompany.isPending ? "Creating…" : "Create company"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
