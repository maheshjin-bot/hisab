"use client";

import { useForm, Controller } from "react-hook-form";
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
import { Field, FieldGroup, FieldLabel, FieldError, FieldDescription } from "@/components/ui/field";
import { useCreateCompanyMutation } from "@/hooks/useCompaniesQuery";
import { useCompanyStore } from "@/stores/useCompanyStore";

const schema = z.object({
  name: z.string().trim().min(1, { error: "Company name is required" }),
  bookBeginningDate: z.string().min(1, { error: "Book beginning date is required" }),
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
    defaultValues: { name: "", bookBeginningDate: `${new Date().getFullYear()}-04-01` },
  });

  async function onSubmit(values: FormValues) {
    try {
      const companyId = await createCompany.mutateAsync({
        name: values.name,
        bookBeginningDate: values.bookBeginningDate,
        financialYearStartMonth: 4,
        baseCurrency: "INR",
      });
      setRecentCompanyId(companyId);
      reset();
      onOpenChange(false);
      router.push(`/${companyId}/dashboard`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not create company");
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New company</DialogTitle>
          <DialogDescription>
            The Indian chart of accounts is pre-loaded automatically. Financial year runs 1 Apr – 31 Mar, base currency is ₹.
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
