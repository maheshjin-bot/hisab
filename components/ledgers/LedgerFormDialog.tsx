"use client";

import { useState } from "react";
import { useForm, Controller, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { toast } from "sonner";
import { ChevronDown, ChevronRight } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldError,
  FieldSet,
  FieldLegend,
} from "@/components/ui/field";
import { useLedgerGroupsQuery, useCreateLedgerMutation, useUpdateLedgerMutation } from "@/hooks/useLedgersQuery";
import type { Ledger, LedgerSearchResult } from "@/lib/supabase/queries/ledgers";
import {
  PARTY_TYPES,
  defaultGroupForPartyType,
  groupsForPartyType,
  partyTypeConfig,
  partyTypeForGroup,
  type PartyType,
} from "@/lib/ledgers/party-type";
import { toUserMessage } from "@/lib/errors";
import { itemsWithPending, selectItems } from "@/lib/utils/select-items";

const schema = z.object({
  name: z.string().trim().min(1, { error: "Name is required" }),
  groupId: z.string().min(1, { error: "Choose what this is — or pick a group yourself under Advanced" }),
  openingBalanceAmount: z.number().min(0),
  openingBalanceType: z.enum(["debit", "credit"]),
  contactPerson: z.string().optional(),
  phone: z.string().optional(),
  email: z.string().optional(),
  address: z.string().optional(),
  notes: z.string().optional(),
});

type FormValues = z.infer<typeof schema>;

/** The picker's entry for a ledger whose group is none of the six plain kinds. */
const SOMETHING_ELSE = "other";

// What each Select's trigger shows. Base UI resolves the label from a map on
// the root rather than from the option that was clicked, so a Select over ids
// shows an id and a Select over `debit`/`credit` shows the lowercase word.
const PARTY_TYPE_ITEMS = selectItems(PARTY_TYPES, (t) => [t.value, t.label], {
  [SOMETHING_ELSE]: "Something else",
});
const DR_CR_ITEMS = { debit: "Debit", credit: "Credit" };

const EMPTY_VALUES: FormValues = {
  name: "",
  groupId: "",
  openingBalanceAmount: 0,
  openingBalanceType: "debit",
  contactPerson: "",
  phone: "",
  email: "",
  address: "",
  notes: "",
};

/**
 * ASKING WHAT SOMETHING IS, NOT WHERE IT IS FILED.
 *
 * This form used to open with a Group picker — eighteen account groups, in
 * accounting words — and a Debit/Credit radio. The person entering "Ramesh
 * owes me ₹5,000" knows Ramesh is a customer and knows he owes; neither of
 * those two controls asked him anything he knew, and getting the group wrong
 * was silent and permanent-feeling: a group left on ledger_role 'other' drops
 * the party out of every voucher combobox with no error anywhere.
 *
 * So the visible question is "What is this?" and the visible direction is a
 * sentence. Underneath, the form still writes exactly the same two columns it
 * always did — group_id and opening_balance_type — and the database is
 * untouched.
 *
 * THE FORM STATE IS STILL THE REAL COLUMNS. groupId and openingBalanceType are
 * the source of truth; the plain controls are a projection of them, and the
 * Advanced disclosure is the same two values shown in the accountant's words.
 * Nothing is stored twice, so the two views cannot drift.
 *
 * WHICH MATTERS MOST WHEN EDITING. An existing ledger opens on the group it is
 * already in, and the plain type is *derived* from that group's role rather
 * than re-chosen. Saving an untouched form therefore writes back the same
 * group_id it read, which is what stops an edit from silently re-homing a
 * party — and what keeps app_private.protect_ledger_financial_fields() quiet,
 * since an unchanged group_id is not a group change at all.
 */
export function LedgerFormDialog({
  open,
  onOpenChange,
  companyId,
  ledger,
  canEditFinancials = false,
  initialName,
  initialPartyType,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  companyId: string;
  ledger?: Ledger;
  /** True for admins. app_private.protect_ledger_financial_fields() rejects a
   *  group or opening-balance change from anyone else, so those fields are
   *  locked here rather than letting the save fail after the fact. */
  canEditFinancials?: boolean;
  /**
   * For creating a ledger from inside a voucher picker: the name the user
   * had typed into the search, and the kind of ledger that field expects —
   * so "Received Into (Cash / Bank)" opens already on "Bank account". Both
   * are starting values only.
   */
  initialName?: string;
  initialPartyType?: PartyType;
  /** The new ledger, shaped as a picker result so the caller can select it. */
  onCreated?: (ledger: LedgerSearchResult) => void;
}) {
  // A suggested kind has to be filed in a real group, and the group list is
  // not there yet when this opens from a voucher picker (voucher forms never
  // load it). So the form waits for the list and mounts with the group as a
  // default value — rather than mounting empty and reaching back in with an
  // effect. Only fetched while open; the dialog sits mounted, closed, inside
  // every picker on a voucher form.
  const wantsSuggestion = !!initialPartyType && !ledger;
  const { data: groups } = useLedgerGroupsQuery(open && wantsSuggestion ? companyId : undefined);
  const suggestedGroup = wantsSuggestion && groups ? defaultGroupForPartyType(groups, initialPartyType) : null;
  const suggestedDirection = wantsSuggestion
    ? (partyTypeConfig(initialPartyType).directions[0]?.value ?? partyTypeConfig(initialPartyType).defaultDirection)
    : undefined;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{ledger ? "Edit ledger" : "Add a party or account"}</DialogTitle>
        </DialogHeader>
        {/* Mounted only while the dialog is open, so every opening starts on
            the values of the ledger being edited — or on nothing at all — with
            no effect reaching back to reset what the last opening left behind.
            The parent also keys this component per ledger, so switching
            straight from one Edit to another remounts it too. */}
        {open &&
          (wantsSuggestion && !groups ? (
            <Skeleton className="h-72 w-full" />
          ) : (
            <LedgerForm
              companyId={companyId}
              ledger={ledger}
              canEditFinancials={canEditFinancials}
              initialName={initialName}
              initialPartyType={wantsSuggestion ? initialPartyType : undefined}
              initialGroupId={suggestedGroup?.id}
              initialDirection={suggestedDirection}
              onCreated={onCreated}
              onDone={() => onOpenChange(false)}
            />
          ))}
      </DialogContent>
    </Dialog>
  );
}

function LedgerForm({
  companyId,
  ledger,
  canEditFinancials,
  initialName,
  initialPartyType,
  initialGroupId,
  initialDirection,
  onCreated,
  onDone,
}: {
  companyId: string;
  ledger?: Ledger;
  canEditFinancials: boolean;
  initialName?: string;
  initialPartyType?: PartyType;
  initialGroupId?: string;
  initialDirection?: "debit" | "credit";
  onCreated?: (ledger: LedgerSearchResult) => void;
  onDone: () => void;
}) {
  const { data: groups } = useLedgerGroupsQuery(companyId);
  const createLedger = useCreateLedgerMutation(companyId);
  const updateLedger = useUpdateLedgerMutation(companyId);
  const isEdit = !!ledger;
  // Only locked when editing: the trigger compares against the previous row,
  // so it has nothing to say about the values on a brand-new ledger.
  const financialsLocked = isEdit && !canEditFinancials;

  // null until the user opens or closes it themselves; until then it follows
  // the ledger being edited. Derived rather than seeded into state, because the
  // group list arrives from its own query and would not be there to consult on
  // the first render.
  const [advancedOverride, setAdvancedOverride] = useState<boolean | null>(null);
  // What the user last asked for, which outranks the group's own role while
  // the two are compatible. It exists for one case: Bank account and Cash both
  // map to ledger_role 'cash_bank', so a company with only a "Bank Accounts"
  // group files a Cash ledger there, and without this the picker would snap
  // back to "Bank account" the instant they chose "Cash".
  const [chosenType, setChosenType] = useState<PartyType | null>(initialPartyType ?? null);

  const { control, handleSubmit, setValue, formState: { errors } } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: ledger
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
      : {
          ...EMPTY_VALUES,
          name: initialName ?? "",
          groupId: initialGroupId ?? "",
          openingBalanceType: initialDirection ?? EMPTY_VALUES.openingBalanceType,
        },
  });

  const groupId = useWatch({ control, name: "groupId" });
  const selectedGroup = groups?.find((g) => g.id === groupId) ?? null;
  const derivedType = selectedGroup ? partyTypeForGroup(selectedGroup) : null;

  // The chosen word wins only while it still describes the group the form is
  // actually pointing at. Change the group under Advanced to a debtor group
  // and the picker says "Customer", whatever was clicked before.
  const partyType =
    chosenType && selectedGroup && partyTypeConfig(chosenType).role === selectedGroup.ledgerRole
      ? chosenType
      : derivedType;

  // An edit opens on the group it is editing before the groups query answers,
  // so the id is covered by the placeholder until its name arrives — a form
  // that has not loaded should read as empty, not as a UUID.
  const groupItems = itemsWithPending(
    selectItems(groups, (g) => [g.id, g.name]),
    groupId,
    "Select a group"
  );

  const config = partyType ? partyTypeConfig(partyType) : null;
  const candidateGroups = partyType ? groupsForPartyType(groups ?? [], partyType) : [];

  // A ledger sitting in Loans & Advances, Provisions or Capital has no plain
  // word to show, so the accountant's controls are the only ones that can
  // describe it — open them rather than hiding the ledger's own group behind a
  // disclosure the user has no reason to click.
  const advancedOpen = advancedOverride ?? (!!selectedGroup && derivedType === null);

  function handleTypeChange(next: string) {
    if (next === SOMETHING_ELSE) {
      // Not a kind of ledger — a way of saying "none of these", which can only
      // be answered with the real group picker.
      setChosenType(null);
      setAdvancedOverride(true);
      return;
    }
    const type = next as PartyType;
    const typeConfig = partyTypeConfig(type);
    setChosenType(type);
    setValue("groupId", defaultGroupForPartyType(groups ?? [], type)?.id ?? "");
    // The ordinary direction for this kind of party, so the everyday ledger is
    // one field rather than a decision.
    setValue("openingBalanceType", typeConfig.directions[0]?.value ?? typeConfig.defaultDirection);
  }

  async function onSubmit(values: FormValues) {
    try {
      if (isEdit) {
        await updateLedger.mutateAsync({ ledgerId: ledger.id, input: values });
      } else {
        const id = await createLedger.mutateAsync(values);
        const group = groups?.find((g) => g.id === values.groupId);
        onCreated?.({
          id,
          name: values.name,
          groupId: values.groupId,
          groupName: group?.name ?? "",
          ledgerRole: group?.ledgerRole ?? "other",
        });
      }
      onDone();
    } catch (err) {
      toast.error(toUserMessage(err, "Could not save ledger"));
    }
  }

  const pending = createLedger.isPending || updateLedger.isPending;
  const filedIn = candidateGroups.find((g) => g.id === groupId) ?? null;

  return (
    <form
      onSubmit={(e) => {
        // This dialog is portalled, but React still bubbles the submit up the
        // component tree — and when it's opened from a picker inside a
        // voucher form, that form's own onSubmit is the next stop. Saving a
        // ledger must not also try to save the voucher.
        e.stopPropagation();
        void handleSubmit(onSubmit)(e);
      }}
      className="max-h-[70vh] overflow-y-auto pr-1"
    >
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="ledger-name">Name</FieldLabel>
          <Controller name="name" control={control} render={({ field }) => <Input id="ledger-name" autoFocus {...field} />} />
          {errors.name && <FieldError>{errors.name.message}</FieldError>}
        </Field>

        <Field>
          <FieldLabel>What is this?</FieldLabel>
          <Select
            // Null, not "Something else", while nothing is chosen: a new
            // form must read as an unanswered question rather than as one
            // already answered oddly.
            value={partyType ?? (selectedGroup ? SOMETHING_ELSE : null)}
            items={PARTY_TYPE_ITEMS}
            onValueChange={(v) => handleTypeChange(String(v))}
            disabled={financialsLocked}
          >
            <SelectTrigger className="w-full">
              <SelectValue placeholder="Choose one" />
            </SelectTrigger>
            <SelectContent>
              {PARTY_TYPES.map((t) => (
                <SelectItem key={t.value} value={t.value}>
                  {t.label}
                </SelectItem>
              ))}
              <SelectItem value={SOMETHING_ELSE}>Something else</SelectItem>
            </SelectContent>
          </Select>
          {config && <FieldDescription>{config.hint}</FieldDescription>}

          {config && filedIn && (
            <FieldDescription>
              Filed under <span className="font-medium text-foreground">{filedIn.name}</span>
              {candidateGroups.length > 1 && " — change it under Advanced if you keep more than one."}
            </FieldDescription>
          )}
          {config && !filedIn && (
            <FieldDescription className="text-destructive">
              This company has no group set up for {config.plural}, so there is nowhere to file
              this yet. Pick a group under Advanced, or set a group&apos;s role on the Account Groups screen.
            </FieldDescription>
          )}
          {!config && !financialsLocked && (
            <FieldDescription>Pick the group yourself under Advanced.</FieldDescription>
          )}
          {financialsLocked && (
            <FieldDescription>Only an admin can change what an existing ledger is.</FieldDescription>
          )}
          {errors.groupId && <FieldError>{errors.groupId.message}</FieldError>}
        </Field>

        <FieldSet>
          <FieldLegend variant="label">{config?.amountLabel ?? "Opening amount"}</FieldLegend>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field>
              <Controller
                name="openingBalanceAmount"
                control={control}
                render={({ field }) => (
                  <Input
                    type="number"
                    step="0.01"
                    min="0"
                    aria-label={config?.amountLabel ?? "Opening amount"}
                    disabled={financialsLocked}
                    value={field.value}
                    onChange={(e) => field.onChange(Number(e.target.value))}
                  />
                )}
              />
            </Field>
            {/* Expense and income have no sensible second answer — an
                expense is spent and an income is earned — so nothing is
                asked, and the accountant's own control is in Advanced for
                the rare book that needs the other side. */}
            {config && config.directions.length > 0 && (
              <Field>
                <Controller
                  name="openingBalanceType"
                  control={control}
                  render={({ field }) => (
                    // `directions` is already a list of { value, label }, which
                    // is one of the shapes `items` takes.
                    <Select value={field.value} items={config.directions} onValueChange={field.onChange} disabled={financialsLocked}>
                      <SelectTrigger className="w-full" aria-label="Which way does this amount go?">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {config.directions.map((d) => (
                          <SelectItem key={d.value} value={d.value}>
                            {d.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                />
              </Field>
            )}
          </div>
          {config && <FieldDescription>{config.amountHint}</FieldDescription>}
          {financialsLocked && (
            <FieldDescription>Only an admin can change the opening amount once set.</FieldDescription>
          )}
        </FieldSet>

        {/* The accountant's own controls. Moved out of the way, never
            removed: a group has to stay reachable for the ledgers none of
            the six words describe, and for the book that files its
            customers somewhere of its own. */}
        <div className="rounded-lg border">
          <button
            type="button"
            onClick={() => setAdvancedOverride(!advancedOpen)}
            aria-expanded={advancedOpen}
            className="flex w-full items-center gap-1.5 px-3 py-2 text-sm text-muted-foreground hover:text-foreground"
          >
            {advancedOpen ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
            Advanced
          </button>
          {advancedOpen && (
            <div className="space-y-3 border-t p-3">
              <Field>
                <FieldLabel>Account group</FieldLabel>
                <Controller
                  name="groupId"
                  control={control}
                  render={({ field }) => (
                    <Select
                      value={field.value}
                      items={groupItems}
                      onValueChange={(v) => {
                        field.onChange(v);
                        // The word above now follows the group, not the
                        // other way round.
                        setChosenType(null);
                      }}
                      disabled={financialsLocked}
                    >
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
                {financialsLocked && (
                  <FieldDescription>Only an admin can reclassify a ledger&apos;s group.</FieldDescription>
                )}
              </Field>

              {/* Shown only where the plain form asks nothing about
                  direction, so the same value never has two live controls
                  on screen at once. */}
              {(!config || config.directions.length === 0) && (
                <Field>
                  <FieldLabel>Opening balance is</FieldLabel>
                  <Controller
                    name="openingBalanceType"
                    control={control}
                    render={({ field }) => (
                      <Select value={field.value} items={DR_CR_ITEMS} onValueChange={field.onChange} disabled={financialsLocked}>
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
              )}
            </div>
          )}
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
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
  );
}
