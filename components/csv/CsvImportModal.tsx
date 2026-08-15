"use client";

import { useReducer, useRef } from "react";
import { AlertCircle, CheckCircle2, Download, Loader2, Upload } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { parseCsvFile } from "@/lib/csv/parse";
import { buildImportPreview } from "@/lib/csv/validate";
import { downloadSampleCsv } from "@/lib/csv/template";
import type { CommitResult, CsvImportConfig, CsvImportPreview } from "@/lib/csv/types";

type State =
  | { step: "select" }
  | { step: "parsing" }
  | { step: "preview"; preview: CsvImportPreview<unknown> }
  | { step: "committing"; total: number; done: number }
  | { step: "done"; result: CommitResult }
  | { step: "failed"; message: string };

type Action =
  | { type: "PARSING" }
  | { type: "PREVIEW_READY"; preview: CsvImportPreview<unknown> }
  | { type: "COMMIT_START"; total: number }
  | { type: "COMMIT_PROGRESS"; done: number }
  | { type: "COMMIT_DONE"; result: CommitResult }
  | { type: "FAILED"; message: string }
  | { type: "RESET" };

function reducer(_state: State, action: Action): State {
  switch (action.type) {
    case "PARSING":
      return { step: "parsing" };
    case "PREVIEW_READY":
      return { step: "preview", preview: action.preview };
    case "COMMIT_START":
      return { step: "committing", total: action.total, done: 0 };
    case "COMMIT_PROGRESS":
      return { step: "committing", total: (_state as { total: number }).total, done: action.done };
    case "COMMIT_DONE":
      return { step: "done", result: action.result };
    case "FAILED":
      return { step: "failed", message: action.message };
    case "RESET":
      return { step: "select" };
  }
}

export interface CsvImportModalProps<TRow, TParsed, TContext = void> {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  config: CsvImportConfig<TRow, TParsed, TContext>;
  onImportComplete?: (result: CommitResult) => void;
}

const PREVIEW_ROW_LIMIT = 500;

export function CsvImportModal<TRow, TParsed, TContext = void>({
  open,
  onOpenChange,
  config,
  onImportComplete,
}: CsvImportModalProps<TRow, TParsed, TContext>) {
  const [state, dispatch] = useReducer(reducer, { step: "select" });
  const contextRef = useRef<TContext | undefined>(undefined);

  async function handleFileSelected(file: File) {
    dispatch({ type: "PARSING" });
    try {
      const { rows } = await parseCsvFile(file);
      const ctx = config.prepareContext ? await config.prepareContext() : (undefined as TContext);
      contextRef.current = ctx;
      const preview = buildImportPreview(rows, config, ctx);
      dispatch({ type: "PREVIEW_READY", preview: preview as CsvImportPreview<unknown> });
    } catch (err) {
      dispatch({ type: "FAILED", message: err instanceof Error ? err.message : "Could not read that file" });
    }
  }

  async function handleCommit(preview: CsvImportPreview<unknown>) {
    const validRows = preview.results.filter((r) => r.errors.length === 0 && r.data !== null).map((r) => r.data as TParsed);
    dispatch({ type: "COMMIT_START", total: validRows.length });
    try {
      const ctx = contextRef.current ?? (config.prepareContext ? await config.prepareContext() : (undefined as TContext));
      const result = await config.onCommit(validRows, ctx, (done) => dispatch({ type: "COMMIT_PROGRESS", done }));
      dispatch({ type: "COMMIT_DONE", result });
      onImportComplete?.(result);
    } catch (err) {
      dispatch({ type: "FAILED", message: err instanceof Error ? err.message : "Import failed" });
    }
  }

  function handleClose(next: boolean) {
    if (!next) dispatch({ type: "RESET" });
    onOpenChange(next);
  }

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Import {config.entityName}s from CSV</DialogTitle>
          <DialogDescription>Every row is validated before anything is saved.</DialogDescription>
        </DialogHeader>

        {state.step === "select" && (
          <div className="space-y-4">
            <button
              type="button"
              onClick={() => downloadSampleCsv(config)}
              className="flex w-full items-center justify-center gap-2 rounded-lg border border-dashed p-4 text-sm text-muted-foreground hover:border-primary hover:text-primary"
            >
              <Download className="size-4" />
              Download sample CSV template
            </button>
            <label className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed p-10 text-sm text-muted-foreground hover:border-primary hover:text-primary">
              <Upload className="size-6" />
              <span>Click to choose a CSV file</span>
              <input
                type="file"
                accept=".csv,text/csv"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) handleFileSelected(file);
                }}
              />
            </label>
          </div>
        )}

        {state.step === "parsing" && (
          <div className="flex flex-col items-center gap-2 py-10 text-sm text-muted-foreground">
            <Loader2 className="size-6 animate-spin" />
            Validating…
          </div>
        )}

        {state.step === "preview" && (
          <PreviewPanel
            preview={state.preview}
            onCancel={() => dispatch({ type: "RESET" })}
            onConfirm={() => handleCommit(state.preview)}
          />
        )}

        {state.step === "committing" && (
          <div className="space-y-3 py-6">
            <p className="text-sm text-muted-foreground">
              Importing {state.done} / {state.total}…
            </p>
            <Progress value={state.total ? (state.done / state.total) * 100 : 0} />
          </div>
        )}

        {state.step === "done" && (
          <div className="space-y-4 py-4">
            <Alert>
              <CheckCircle2 className="size-4" />
              <AlertTitle>Import complete</AlertTitle>
              <AlertDescription>
                {state.result.insertedCount} imported
                {state.result.failedCount > 0 && `, ${state.result.failedCount} failed`}.
              </AlertDescription>
            </Alert>
            {state.result.errors && state.result.errors.length > 0 && (
              <ul className="max-h-40 space-y-1 overflow-y-auto rounded-lg border p-2 text-xs text-destructive">
                {state.result.errors.map((e, i) => (
                  <li key={i}>{e.rowNumber ? `Row ${e.rowNumber}: ` : ""}{e.message}</li>
                ))}
              </ul>
            )}
            <DialogFooter>
              <Button onClick={() => handleClose(false)}>Done</Button>
            </DialogFooter>
          </div>
        )}

        {state.step === "failed" && (
          <div className="space-y-4 py-4">
            <Alert variant="destructive">
              <AlertCircle className="size-4" />
              <AlertTitle>Something went wrong</AlertTitle>
              <AlertDescription>{state.message}</AlertDescription>
            </Alert>
            <DialogFooter>
              <Button variant="outline" onClick={() => dispatch({ type: "RESET" })}>
                Try again
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function PreviewPanel({
  preview,
  onCancel,
  onConfirm,
}: {
  preview: CsvImportPreview<unknown>;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const shown = preview.results.slice(0, PREVIEW_ROW_LIMIT);
  const hiddenCount = preview.results.length - shown.length;

  return (
    <div className="space-y-3">
      <div className="flex gap-3 text-sm">
        <span>{preview.totalRows} rows</span>
        <Badge variant="secondary" className="bg-success/10 text-success">
          {preview.validRowCount} valid
        </Badge>
        {preview.invalidRowCount > 0 && (
          <Badge variant="secondary" className="bg-destructive/10 text-destructive">
            {preview.invalidRowCount} errors
          </Badge>
        )}
      </div>

      {preview.fileIssues.length > 0 && (
        <div className="space-y-1">
          {preview.fileIssues.map((issue, i) => (
            <Alert key={i} variant={issue.severity === "error" ? "destructive" : "default"}>
              <AlertCircle className="size-4" />
              <AlertDescription>{issue.message}</AlertDescription>
            </Alert>
          ))}
        </div>
      )}

      <div className="max-h-72 overflow-y-auto rounded-lg border">
        <table className="w-full text-xs">
          <thead className="sticky top-0 bg-muted/50">
            <tr>
              <th className="p-2 text-left font-medium">Row</th>
              <th className="p-2 text-left font-medium">Status</th>
              <th className="p-2 text-left font-medium">Details</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((row) => (
              <tr key={row.rowNumber} className="border-t">
                <td className="p-2 text-muted-foreground">{row.rowNumber}</td>
                <td className="p-2">
                  {row.errors.length === 0 ? (
                    <span className="text-success">Valid</span>
                  ) : (
                    <span className="text-destructive">Error</span>
                  )}
                </td>
                <td className="p-2 text-muted-foreground">
                  {row.errors.length === 0
                    ? Object.values(row.raw).slice(0, 3).join(" · ")
                    : row.errors.map((e) => e.message).join("; ")}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {hiddenCount > 0 && (
          <p className="border-t p-2 text-center text-xs text-muted-foreground">+{hiddenCount} more rows</p>
        )}
      </div>

      <DialogFooter>
        <Button variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button onClick={onConfirm} disabled={preview.validRowCount === 0}>
          Import {preview.validRowCount} row{preview.validRowCount === 1 ? "" : "s"}
        </Button>
      </DialogFooter>
    </div>
  );
}
