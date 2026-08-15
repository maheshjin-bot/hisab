"use client";

import { useEffect } from "react";
import { useForm, Controller } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Field, FieldGroup, FieldLabel, FieldError, FieldSet, FieldLegend } from "@/components/ui/field";
import { useLedgerGroupsQuery, useCreateLedgerMutation, useUpdateLedgerMutation } from "@/hooks/useLedgersQuery";
import type { Ledger } from "@/lib/supabase/queries/ledgers";

const schema = z.object({
  name: z.string().trim().min(1, { error: "Name is required" }),
  groupId: z.string().min(1, { error: "Select a group" }),
  openingBalanceAmount: z.number().min(0),
  openingBalanceType: z.enum(["debit", "credit"]),
  contactPerson: z.string().optional(),
  phone: z.string().optional(),
  email: z.string().optional(),
  address: z.string().optional(),
  notes: z.string().optional(),
});

type FormValues = z.infer<typeof schema>;

export function LedgerFormDialog({
  open,
  onOpenChange,
  companyId,
  ledger,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  companyId: string;
  ledger?: Ledger;
}) {
  const { data: groups } = useLedgerGroupsQuery(companyId);
  const createLedger = useCreateLedgerMutation(companyId);
  const updateLedger = useUpdateLedgerMutation(companyId);
  const isEdit = !!ledger;

  const { control, handleSubmit, reset, formState: { errors } } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      name: "", groupId: "", openingBalanceAmount: 0, openingBalanceType: "debit",
      contactPerson: "", phone: "", email: "", address: "", notes: "",
    },
  });

  useEffect(() => {
    if (open) {
      reset(
        ledger
          ? {
              name: ledger.name,
              groupId: ledger.groupId,
              openingBalanceAmount: ledger.openingBalanceAmount,
              openingBalanceType: ledger.openingBalanceType,
              contactPerson: ledger.contactPerson ?? "",
              phone: ledger.phone ?? "",
              email: ledger.email ?? "",
              address: ledger.address ?? "",
              notes: ledger.notes ?? "",
            }
          : { name: "", groupId: "", openingBalanceAmount: 0, openingBalanceType: "debit", contactPerson: "", phone: "", email: "", address: "", notes: "" }
      );
    }
  }, [open, ledger, reset]);

  async function onSubmit(values: FormValues) {
    try {
      if (isEdit) {
        await updateLedger.mutateAsync({ ledgerId: ledger.id, input: values });
      } else {
        await createLedger.mutateAsync(values);
      }
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save ledger");
    }
  }

  const pending = createLedger.isPending || updateLedger.isPending;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit ledger" : "New ledger"}</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit(onSubmit)} className="max-h-[70vh] overflow-y-auto pr-1">
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="ledger-name">Name</FieldLabel>
              <Controller name="name" control={control} render={({ field }) => <Input id="ledger-name" autoFocus {...field} />} />
              {errors.name && <FieldError>{errors.name.message}</FieldError>}
            </Field>

            <Field>
              <FieldLabel>Group</FieldLabel>
              <Controller
                name="groupId"
                control={control}
                render={({ field }) => (
                  <Select value={field.value} onValueChange={field.onChange} disabled={isEdit}>
                    <SelectTrigger className="w-full">
                      <SelectValue placeholder="Select a group" />
                    </SelectTrigger>
                    <SelectContent>
                      {groups?.map((g) => (
                        <SelectItem key={g.id} value={g.id}>
                          {g.parentGroupId ? `— ${g.name}` : g.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
              {isEdit && <p className="text-xs text-muted-foreground">Only an admin can reclassify a ledger&apos;s group.</p>}
              {errors.groupId && <FieldError>{errors.groupId.message}</FieldError>}
            </Field>

            <FieldSet>
              <FieldLegend variant="label">Opening balance</FieldLegend>
              <div className="grid grid-cols-2 gap-3">
                <Field>
                  <Controller
                    name="openingBalanceAmount"
                    control={control}
                    render={({ field }) => (
                      <Input
                        type="number"
                        step="0.01"
                        min="0"
                        disabled={isEdit}
                        value={field.value}
                        onChange={(e) => field.onChange(Number(e.target.value))}
                      />
                    )}
                  />
                </Field>
                <Field>
                  <Controller
                    name="openingBalanceType"
                    control={control}
                    render={({ field }) => (
                      <Select value={field.value} onValueChange={field.onChange} disabled={isEdit}>
                        <SelectTrigger className="w-full">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="debit">Debit</SelectItem>
                          <SelectItem value="credit">Credit</SelectItem>
                        </SelectContent>
                      </Select>
                    )}
                  />
                </Field>
              </div>
              {isEdit && <p className="text-xs text-muted-foreground">Only an admin can change the opening balance once set.</p>}
            </FieldSet>

            <div className="grid grid-cols-2 gap-3">
              <Field>
                <FieldLabel htmlFor="ledger-contact">Contact person</FieldLabel>
                <Controller name="contactPerson" control={control} render={({ field }) => <Input id="ledger-contact" {...field} />} />
              </Field>
              <Field>
                <FieldLabel htmlFor="ledger-phone">Phone</FieldLabel>
                <Controller name="phone" control={control} render={({ field }) => <Input id="ledger-phone" {...field} />} />
              </Field>
            </div>
            <Field>
              <FieldLabel htmlFor="ledger-email">Email</FieldLabel>
              <Controller name="email" control={control} render={({ field }) => <Input id="ledger-email" type="email" {...field} />} />
            </Field>
            <Field>
              <FieldLabel htmlFor="ledger-address">Address</FieldLabel>
              <Controller name="address" control={control} render={({ field }) => <Textarea id="ledger-address" rows={2} {...field} />} />
            </Field>
            <Field>
              <FieldLabel htmlFor="ledger-notes">Notes</FieldLabel>
              <Controller name="notes" control={control} render={({ field }) => <Textarea id="ledger-notes" rows={2} {...field} />} />
            </Field>
          </FieldGroup>

          <DialogFooter className="mt-4">
            <Button type="submit" disabled={pending}>
              {pending ? "Saving…" : isEdit ? "Save changes" : "Create ledger"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
