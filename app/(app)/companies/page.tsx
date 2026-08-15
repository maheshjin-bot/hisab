"use client";

import { useState } from "react";
import Link from "next/link";
import { Building2, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useCompaniesQuery } from "@/hooks/useCompaniesQuery";
import { CreateCompanyDialog } from "@/components/companies/CreateCompanyDialog";
import { useCompanyStore } from "@/stores/useCompanyStore";

export default function CompaniesPage() {
  const { data: companies, isLoading } = useCompaniesQuery();
  const [createOpen, setCreateOpen] = useState(false);
  const setRecentCompanyId = useCompanyStore((s) => s.setRecentCompanyId);

  return (
    <div className="mx-auto max-w-2xl px-4 py-16">
      <div className="mb-8 flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Your companies</h1>
          <p className="text-sm text-muted-foreground">Pick one to continue, or set up a new one.</p>
        </div>
        <Button onClick={() => setCreateOpen(true)}>
          <Plus data-icon="inline-start" />
          New company
        </Button>
      </div>

      {isLoading && (
        <div className="space-y-2">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
      )}

      {!isLoading && companies?.length === 0 && (
        <Card className="flex flex-col items-center gap-3 p-10 text-center">
          <Building2 className="size-8 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">No companies yet — create your first one to get started.</p>
          <Button onClick={() => setCreateOpen(true)}>
            <Plus data-icon="inline-start" />
            New company
          </Button>
        </Card>
      )}

      <div className="space-y-2">
        {companies?.map((company) => (
          <Link
            key={company.id}
            href={`/${company.id}/dashboard`}
            onClick={() => setRecentCompanyId(company.id)}
            className="flex items-center justify-between rounded-xl border bg-card p-4 transition-colors hover:bg-muted/50"
          >
            <div className="flex items-center gap-3">
              <div className="flex size-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <Building2 className="size-4" />
              </div>
              <div>
                <p className="text-sm font-medium">{company.name}</p>
                <p className="text-xs text-muted-foreground">
                  FY starts {new Date(2000, company.financialYearStartMonth - 1).toLocaleString("en-IN", { month: "long" })} · {company.role}
                </p>
              </div>
            </div>
          </Link>
        ))}
      </div>

      <CreateCompanyDialog open={createOpen} onOpenChange={setCreateOpen} />
    </div>
  );
}
