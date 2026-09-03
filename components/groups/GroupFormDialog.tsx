"use client";

import { useEffect, useMemo } from "react";
import { Controller, useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import {
  useCreateAccountGroupMutation,
  useUpdateAccountGroupMutation,
} from "@/hooks/useLedgersQuery";
import type { AccountGroup, LedgerRole } from "@/lib/supabase/queries/ledgers";
import { toUserMessage } from "@/lib/errors";
import { LEDGER_ROLE_LABEL, NATURE_LABEL, validParents, type GroupNode } from "./group-tree";
import { buildGroupFormSchema, LEDGER_ROLES, type GroupFormValues } from "./group-form-schema";



export function GroupFormDialog({
  open,
  onOpenChange,
  companyId,
  tree,
  allGroups,
  group,
  defaultParentId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  companyId: string;
  tree: GroupNode[];
  allGroups: AccountGroup[];
  /** Omitted when creating. */
  group?: AccountGroup;
  /** Pre-selected parent when creating from a row's "Add sub-group". */
  defaultParentId?: string;
}) {
  const createGroup = useCreateAccountGroupMutation(companyId);
  const updateGroup = useUpdateAccountGroupMutation(companyId);
  const isEdit = !!group;

  // protect_system_group() rejects a parent change on a system group, so the
  // eight roots can be renamed and re-roled here but never moved.
  const parentLocked = !!group?.isSystem;

  const parentOptions = useMemo(() => {
    if (group) return validParents(tree, allGroups, group);
    // Creating: any group can be a parent — the new child inherits its nature.
    return [...allGroups].sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
  }, [tree, allGroups, group]);

  const schema = useMemo(() => buildGroupFormSchema(parentLocked), [parentLocked]);

  const { control, handleSubmit, reset, formState: { errors } } = useForm<GroupFormValues>({
    resolver: zodResolver(schema),
    defaultValues: { name: "", parentGroupId: "", ledgerRole: "other" },
  });

  useEffect(() => {
    if (!open) return;
    reset({
      name: group?.name ?? "",
      parentGroupId: group?.parentGroupId ?? defaultParentId ?? "",
      ledgerRole: (group?.ledgerRole ?? "other") as LedgerRole,
    });
  }, [open, group, defaultParentId, reset]);

  const selectedParentId = useWatch({ control, name: "parentGroupId" });
  const inheritedNature = allGroups.find((g) => g.id === selectedParentId)?.nature;

  async function onSubmit(values: GroupFormValues) {
    try {
      if (isEdit) {
        await updateGroup.mutateAsync({
          groupId: group.id,
          input: {
            name: values.name,
            ledgerRole: values.ledgerRole,
            // Omitted for system groups so the update never carries a parent
            // change the trigger would reject.
            ...(parentLocked ? {} : { parentGroupId: values.parentGroupId }),
          },
        });
      } else {
        await createGroup.mutateAsync({
          name: values.name,
          parentGroupId: values.parentGroupId,
          ledgerRole: values.ledgerRole,
        });
      }
      onOpenChange(false);
    } catch (err) {
      toast.error(toUserMessage(err, isEdit ? "Could not save group" : "Could not create group"));
    }
  }

  const pending = createGroup.isPending || updateGroup.isPending;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit group" : "New sub-group"}</DialogTitle>
          <DialogDescription>
            {isEdit
              ? "A group's classification follows its parent and can't be set directly."
              : "New groups are always sub-groups — they take their classification from the parent you choose."}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit(onSubmit)}>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="group-name">Name</FieldLabel>
              <Controller
                name="name"
                control={control}
                render={({ field }) => <Input id="group-name" autoFocus {...field} />}
              />
              {errors.name && <FieldError>{errors.name.message}</FieldError>}
            </Field>

            <Field>
              <FieldLabel>Parent group</FieldLabel>
              <Controller
                name="parentGroupId"
                control={control}
                render={({ field }) => (
                  <Select value={field.value} onValueChange={field.onChange} disabled={parentLocked}>
                    <SelectTrigger className="w-full">
                      <SelectValue placeholder="Select a parent" />
                    </SelectTrigger>
                    <SelectContent>
                      {parentOptions.map((g) => (
                        <SelectItem key={g.id} value={g.id}>
                          {g.parentGroupId ? `— ${g.name}` : g.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
              {parentLocked ? (
                <FieldDescription>
                  {group?.name} is one of the eight primary groups — it can be renamed, but not moved.
                </FieldDescription>
              ) : (
                <FieldDescription>
                  {inheritedNature
                    ? `Classified as ${NATURE_LABEL[inheritedNature] ?? inheritedNature}, inherited from the parent.`
                    : "Only groups of the same classification are listed."}
                </FieldDescription>
              )}
              {errors.parentGroupId && <FieldError>{errors.parentGroupId.message}</FieldError>}
            </Field>

            <Field>
              <FieldLabel>Ledger role</FieldLabel>
              <Controller
                name="ledgerRole"
                control={control}
                render={({ field }) => (
                  <Select value={field.value} onValueChange={field.onChange}>
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {LEDGER_ROLES.map((role) => (
                        <SelectItem key={role} value={role}>
                          {LEDGER_ROLE_LABEL[role]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
              <FieldDescription>
                Decides which voucher fields offer this group&apos;s ledgers. A group left on
                &ldquo;Other&rdquo; won&apos;t be offered as the cash or bank account on a Money Out entry.
              </FieldDescription>
            </Field>
          </FieldGroup>

          <DialogFooter className="mt-4">
            <Button type="submit" disabled={pending}>
              {pending ? "Saving…" : isEdit ? "Save changes" : "Create group"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
