"use client";

import { CornerDownRight, Lock, MoreHorizontal, Pencil, Plus, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { AccountGroup } from "@/lib/supabase/queries/ledgers";
import { flattenTree, LEDGER_ROLE_LABEL, NATURE_LABEL, type GroupNode } from "./group-tree";

export function GroupTree({
  tree,
  ledgerCounts,
  canWrite,
  onEdit,
  onAddChild,
  onDelete,
}: {
  tree: GroupNode[];
  ledgerCounts: Map<string, number> | undefined;
  canWrite: boolean;
  onEdit: (group: AccountGroup) => void;
  onAddChild: (parent: AccountGroup) => void;
  onDelete: (group: AccountGroup) => void;
}) {
  const rows = flattenTree(tree);

  return (
    <div className="overflow-hidden rounded-xl bg-card shadow-sm ring-1 ring-foreground/10">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Group</TableHead>
            <TableHead>Classification</TableHead>
            <TableHead>Ledger role</TableHead>
            <TableHead className="text-right">Ledgers</TableHead>
            <TableHead className="w-10" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map(({ group, depth, children }) => {
            const count = ledgerCounts?.get(group.id) ?? 0;
            // The parent FK is NO ACTION, not CASCADE, so a group with
            // sub-groups can't be deleted until they are dealt with first.
            const hasChildren = children.length > 0;
            return (
              <TableRow key={group.id}>
                <TableCell>
                  <span
                    className="flex items-center gap-1.5"
                    // Indent by depth rather than nesting tables — the tree is
                    // shallow and a flat table keeps the columns aligned.
                    style={{ paddingLeft: `${depth * 1.25}rem` }}
                  >
                    {depth > 0 && <CornerDownRight className="size-3 shrink-0 text-muted-foreground/60" />}
                    <span className={depth === 0 ? "font-medium" : ""}>{group.name}</span>
                    {group.isSystem && (
                      <Lock
                        className="size-3 shrink-0 text-muted-foreground"
                        aria-label="Primary group — cannot be moved or deleted"
                      />
                    )}
                  </span>
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {NATURE_LABEL[group.nature] ?? group.nature}
                </TableCell>
                <TableCell>
                  <Badge variant="secondary" className={group.ledgerRole === "other" ? "text-muted-foreground" : ""}>
                    {LEDGER_ROLE_LABEL[group.ledgerRole] ?? group.ledgerRole}
                  </Badge>
                </TableCell>
                <TableCell className="text-right tabular-nums text-muted-foreground">
                  {count || "—"}
                </TableCell>
                <TableCell>
                  {canWrite && (
                    <div className="flex justify-end">
                      <DropdownMenu>
                        <DropdownMenuTrigger
                          render={
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              className="text-muted-foreground"
                              aria-label={`Actions for ${group.name}`}
                            />
                          }
                        >
                          <MoreHorizontal className="size-4" />
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onClick={() => onAddChild(group)}>
                            <Plus className="size-3.5" />
                            Add sub-group
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => onEdit(group)}>
                            <Pencil className="size-3.5" />
                            Edit
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            variant="destructive"
                            // Mirrors what the database refuses anyway:
                            // protect_system_group() blocks deleting a primary
                            // group, and the two foreign keys block deleting
                            // one that still holds ledgers or sub-groups.
                            disabled={group.isSystem || count > 0 || hasChildren}
                            onClick={() => onDelete(group)}
                          >
                            <Trash2 className="size-3.5" />
                            Delete
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  )}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
