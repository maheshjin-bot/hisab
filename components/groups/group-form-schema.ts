import { z } from "zod";
import type { LedgerRole } from "@/lib/supabase/queries/ledgers";
import { LEDGER_ROLE_LABEL } from "./group-tree";

export const LEDGER_ROLES = Object.keys(LEDGER_ROLE_LABEL) as LedgerRole[];

/**
 * `parentGroupId` is required for a sub-group and must not be for a system
 * group, which is a root and has none.
 *
 * A single always-required schema made the eight primary groups unrenameable:
 * the field resets to "" for them, fails min(1), and reports the error
 * against a field that is disabled — so the dialog refused to submit with
 * nothing the user could act on.
 */
export function buildGroupFormSchema(parentOptional: boolean) {
  return z.object({
    name: z.string().trim().min(1, { error: "Name is required" }),
    parentGroupId: parentOptional
      ? z.string()
      : z.string().min(1, { error: "Every sub-group needs a parent" }),
    ledgerRole: z.enum(LEDGER_ROLES as [LedgerRole, ...LedgerRole[]]),
  });
}

export type GroupFormValues = z.infer<ReturnType<typeof buildGroupFormSchema>>;
