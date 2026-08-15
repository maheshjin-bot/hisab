import { createColumnHelper, stockFeatures, type RowData } from "@tanstack/react-table";

/**
 * TanStack Table v9 requires explicit feature registration; stockFeatures is
 * the documented "quick path" (all v8-equivalent features, less tree-shaking
 * but far lower risk than hand-picking individual feature slots) and is used
 * uniformly by every table in the app so every column-def file shares one
 * feature type.
 */
export type AppTableFeatures = typeof stockFeatures;

export function createAppColumnHelper<TData extends RowData>() {
  return createColumnHelper<AppTableFeatures, TData>();
}
