import { useCallback, useEffect, useRef } from "react";

export interface GridColumn {
  key: string;
  focusable: boolean;
}

export interface UseKeyboardGridOptions {
  /** field.id[] from react-hook-form's useFieldArray, in display order — stable across row insert/remove, unlike array index. */
  rowIds: string[];
  columns: GridColumn[];
  minRows: number;
  /**
   * Appends a row. It doesn't return the new row's id because the caller
   * can't know it: `field.id` is assigned by react-hook-form's useFieldArray
   * during the append, and isn't visible until the next render. Focus lands
   * on the last row once `rowIds` reflects it.
   */
  onAppendRow: () => void;
  onRemoveRow: (rowId: string) => void;
  isRowFilled: (rowId: string) => boolean;
}

function cellKey(rowId: string, columnKey: string) {
  return `${rowId}::${columnKey}`;
}

/**
 * Drives Tab/Enter-to-advance across a dynamic grid of rows, auto-appending a
 * new row when the last cell of a filled last row is confirmed. Cell DOM
 * nodes are tracked in a plain ref map (not React state) since this fires on
 * every navigation keystroke — no need to re-render the grid to move focus.
 */
export function useKeyboardGrid({
  rowIds,
  columns,
  minRows,
  onAppendRow,
  onRemoveRow,
  isRowFilled,
}: UseKeyboardGridOptions) {
  const cellsRef = useRef(new Map<string, HTMLElement>());
  // Only ever "the row that's about to appear at the end", so it holds the
  // column and resolves the row from rowIds once it updates.
  const pendingFocusRef = useRef<{ columnKey: string } | null>(null);
  const focusableColumns = columns.filter((c) => c.focusable);

  const registerCell = useCallback(
    (rowId: string, columnKey: string) => (el: HTMLElement | null) => {
      const key = cellKey(rowId, columnKey);
      if (el) cellsRef.current.set(key, el);
      else cellsRef.current.delete(key);
    },
    []
  );

  const focusCell = useCallback((rowId: string, columnKey: string) => {
    cellsRef.current.get(cellKey(rowId, columnKey))?.focus();
  }, []);

  // Retries focusing a just-appended row once its DOM node exists.
  useEffect(() => {
    if (!pendingFocusRef.current) return;
    const { columnKey } = pendingFocusRef.current;
    const rowId = rowIds[rowIds.length - 1];
    if (rowId && cellsRef.current.has(cellKey(rowId, columnKey))) {
      focusCell(rowId, columnKey);
      pendingFocusRef.current = null;
    }
  }, [rowIds, focusCell]);

  const advance = useCallback(
    (rowId: string, columnKey: string, direction: 1 | -1) => {
      const rowIndex = rowIds.indexOf(rowId);
      const colIndex = focusableColumns.findIndex((c) => c.key === columnKey);
      if (rowIndex === -1 || colIndex === -1) return;

      const nextColIndex = colIndex + direction;

      if (nextColIndex >= 0 && nextColIndex < focusableColumns.length) {
        focusCell(rowId, focusableColumns[nextColIndex].key);
        return;
      }

      // Fell off the end of the row — move to the adjacent row's opposite edge.
      const nextRowIndex = rowIndex + direction;
      if (nextRowIndex >= 0 && nextRowIndex < rowIds.length) {
        const edgeCol = direction === 1 ? focusableColumns[0] : focusableColumns[focusableColumns.length - 1];
        focusCell(rowIds[nextRowIndex], edgeCol.key);
        return;
      }

      // Off the last cell of the last row: auto-append if this row looks filled.
      if (direction === 1 && nextRowIndex >= rowIds.length && isRowFilled(rowId)) {
        onAppendRow();
        pendingFocusRef.current = { columnKey: focusableColumns[0].key };
      }
    },
    [rowIds, focusableColumns, focusCell, isRowFilled, onAppendRow]
  );

  const handleCellKeyDown = useCallback(
    (e: React.KeyboardEvent, rowId: string, columnKey: string) => {
      if (e.key === "Tab") {
        e.preventDefault();
        advance(rowId, columnKey, e.shiftKey ? -1 : 1);
        return;
      }
      if (e.key === "Enter" && !e.shiftKey) {
        // A combobox with an open, highlighted option should confirm the
        // selection first — see LedgerCombobox, which stops this handler via
        // stopPropagation() when it owns the Enter itself.
        e.preventDefault();
        advance(rowId, columnKey, 1);
        return;
      }
      if (e.key === "Backspace" && e.altKey) {
        e.preventDefault();
        if (rowIds.length > minRows) onRemoveRow(rowId);
        return;
      }
    },
    [advance, rowIds.length, minRows, onRemoveRow]
  );

  return { registerCell, focusCell, handleCellKeyDown };
}
