"use client";

import { useState } from "react";
import { Download, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { exportToCsv, type ExportColumnDef } from "@/lib/csv/export";

const DEFAULT_MAX_ROWS = 20000;

export interface CsvExportButtonProps<TRow> {
  label?: string;
  filename: string;
  columns: ExportColumnDef<TRow>[];
  fetchRows: () => Promise<TRow[]>;
  maxRows?: number;
}

export function CsvExportButton<TRow>({ label = "Export CSV", filename, columns, fetchRows, maxRows = DEFAULT_MAX_ROWS }: CsvExportButtonProps<TRow>) {
  const [pending, setPending] = useState(false);

  async function handleClick() {
    setPending(true);
    try {
      const rows = await fetchRows();
      if (rows.length > maxRows) {
        toast.warning(`Exporting the first ${maxRows.toLocaleString()} of ${rows.length.toLocaleString()} rows.`);
      }
      exportToCsv(rows.slice(0, maxRows), columns, filename);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Export failed");
    } finally {
      setPending(false);
    }
  }

  return (
    <Button variant="outline" size="sm" onClick={handleClick} disabled={pending}>
      {pending ? <Loader2 data-icon="inline-start" className="animate-spin" /> : <Download data-icon="inline-start" />}
      {label}
    </Button>
  );
}
