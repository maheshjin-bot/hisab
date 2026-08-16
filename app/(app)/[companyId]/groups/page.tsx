"use client";

import { use, useMemo, useState } from "react";
import { Plus } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { GroupFormDialog } from "@/components/groups/GroupFormDialog";
import { GroupTree } from "@/components/groups/GroupTree";
import { buildGroupTree } from "@/components/groups/group-tree";
import {
  useDeleteAccountGroupMutation,
  useLedgerCountsByGroupQuery,
  useLedgerGroupsQuery,
} from "@/hooks/useLedgersQuery";
import { useCompanyRole } from "@/hooks/useCompaniesQuery";
import type { AccountGroup } from "@/lib/supabase/queries/ledgers";
import { toUserMessage } from "@/lib/errors";

export default function GroupsPage({ params }: PageProps<"/[companyId]/groups"> ) {
  const { companyId } = use(params);

  const { data: groups, isLoading } = useLedgerGroupsQuery(companyId);
  const { data: ledgerCounts } = useLedgerCountsByGroupQuery(companyId);
  const deleteGroup = useDeleteAccountGroupMutation(companyId);

  const role = useCompanyRole(companyId);
  const canWrite = role === "admin" || role === "accountant";

  const [creating, setCreating] = useState(false);
  const [defaultParentId, setDefaultParentId] = useState<string | undefined>();
  const [editing, setEditing] = useState<AccountGroup | null>(null);
  const [deleting, setDeleting] = useState<AccountGroup | null>(null);

  const tree = useMemo(() => buildGroupTree(groups ?? []), [groups]);

  function handleAddChild(parent: AccountGroup) {
    setDefaultParentId(parent.id);
    setCreating(true);
  }

  return (
    <div className="mx-auto max-w-4xl space-y-4 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Account Groups</h1>
          <p className="text-sm text-muted-foreground">
            The shape of your chart of accounts. Every ledger belongs to one of these.
          </p>
        </div>
        {canWrite && (
          <Button
            size="sm"
            onClick={() => {
              setDefaultParentId(undefined);
              setCreating(true);
            }}
          >
            <Plus data-icon="inline-start" />
            New sub-group
          </Button>
        )}
      </div>

      {isLoading ? (
        <Skeleton className="h-96 w-full" />
      ) : (
        <GroupTree
          tree={tree}
          ledgerCounts={ledgerCounts}
          canWrite={canWrite}
          onEdit={setEditing}
          onAddChild={handleAddChild}
          onDelete={setDeleting}
        />
      )}

      <p className="text-xs text-muted-foreground">
        The eight primary groups are marked with a lock: they can be renamed, but not moved or
        deleted. A group&apos;s classification always follows its parent.
      </p>

      <GroupFormDialog
        // Remounts the form when the pre-selected parent changes, so opening
        // "Add sub-group" from a different row doesn't reuse the last parent.
        key={`create-${defaultParentId ?? "root"}`}
        open={creating}
        onOpenChange={setCreating}
        companyId={companyId}
        tree={tree}
        allGroups={groups ?? []}
        defaultParentId={defaultParentId}
      />

      <GroupFormDialog
        key={`edit-${editing?.id ?? "none"}`}
        open={!!editing}
        onOpenChange={(open) => !open && setEditing(null)}
        companyId={companyId}
        tree={tree}
        allGroups={groups ?? []}
        group={editing ?? undefined}
      />

      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(open) => !open && setDeleting(null)}
        title="Delete this group?"
        description={
          <>
            <b>{deleting?.name}</b> will be removed from the chart of accounts. Only groups with
            no ledgers and no sub-groups can be deleted, so nothing else is affected.
          </>
        }
        confirmLabel="Delete"
        destructive
        onConfirm={async () => {
          if (!deleting) return;
          try {
            await deleteGroup.mutateAsync(deleting.id);
            toast.success(`${deleting.name} deleted`);
          } catch (err) {
            toast.error(toUserMessage(err, "Could not delete this group"));
            throw err;
          }
        }}
      />
    </div>
  );
}
