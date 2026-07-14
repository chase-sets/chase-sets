import { useEffect, useMemo, useRef, type HTMLAttributes, type ReactNode } from "react";
import { Icon, type IconName } from "../../icons";
import { useDensity } from "../../theme/provider";
import { cx } from "../../utils/cx";
import { controlHeightClasses, controlSquareSizeClasses } from "../control-sizing";
import { EmptyState } from "../feedback";
import { TableCell, TableHeadCell, TableRow, TableShell } from "./table-shell";

export type DataTableRowAttributes = Readonly<Record<`data-${string}`, string | number | undefined>>;

export interface DataColumn<T> {
  key: string;
  header: ReactNode;
  mobileLabel?: ReactNode;
  align?: "left" | "right";
  cell: (row: T) => ReactNode;
  sortable?: boolean;
}

export interface DataTableProps<T> extends Omit<HTMLAttributes<HTMLDivElement>, "className" | "style"> {
  rows: T[];
  columns: DataColumn<T>[];
  caption?: ReactNode;
  mobileMode?: "stack" | "scroll";
  getRowId?: (row: T, index: number) => string;
  getRowProps?: (row: T, index: number) => DataTableRowAttributes;
  emptyTitle?: ReactNode;
  emptyDescription?: ReactNode;
  sortKey?: string;
  sortDirection?: "asc" | "desc";
  onSortChange?: (key: string, direction: "asc" | "desc") => void;
  selectedKeys?: Set<string>;
  onSelectionChange?: (keys: Set<string>) => void;
  isRowSelectable?: (row: T, index: number) => boolean;
  loading?: boolean;
  loadingRows?: number;
  density?: "comfortable" | "compact";
}

const skeletonWidths = ["w-3/4", "w-1/2", "w-2/3", "w-5/6", "w-2/5"] as const;

export function DataTable<T>({
  rows,
  columns,
  caption,
  mobileMode = "stack",
  getRowId,
  getRowProps,
  emptyTitle = "Nothing to review",
  emptyDescription = "Adjust filters or add new records to populate this view.",
  sortKey,
  sortDirection,
  onSortChange,
  selectedKeys,
  onSelectionChange,
  isRowSelectable,
  loading = false,
  loadingRows = 5,
  density: densityProp,
  ...rest
}: DataTableProps<T>) {
  const themeDensity = useDensity();
  const density = densityProp ?? themeDensity;

  const selectable = selectedKeys !== undefined && onSelectionChange !== undefined;
  const allIds = useMemo(
    () =>
      selectable
        ? rows
            .map((row, index) => ({
              id: getRowId ? getRowId(row, index) : String(index),
              selectable: isRowSelectable ? isRowSelectable(row, index) : true,
            }))
            .filter((row) => row.selectable)
            .map((row) => row.id)
        : [],
    [rows, getRowId, isRowSelectable, selectable],
  );
  const { allSelected, someSelected } = useMemo(() => {
    if (!selectable || !selectedKeys) {
      return { allSelected: false, someSelected: false };
    }

    return {
      allSelected: allIds.length > 0 && allIds.every((id) => selectedKeys.has(id)),
      someSelected: allIds.some((id) => selectedKeys.has(id)),
    };
  }, [allIds, selectable, selectedKeys]);
  const loadingStatus = loading ? "Loading table data" : "Table data loaded";

  function handleSortClick(column: DataColumn<T>) {
    if (!column.sortable || !onSortChange) return;
    const nextDirection = sortKey === column.key && sortDirection === "asc" ? "desc" : "asc";
    onSortChange(column.key, nextDirection);
  }

  function handleSelectAll() {
    if (!onSelectionChange) return;
    if (allSelected) {
      onSelectionChange(new Set());
    } else {
      onSelectionChange(new Set(allIds));
    }
  }

  function handleSelectRow(id: string, canSelect = true) {
    if (!onSelectionChange || !selectedKeys) return;
    if (!canSelect) return;
    const next = new Set(selectedKeys);
    if (next.has(id)) {
      next.delete(id);
    } else {
      next.add(id);
    }
    onSelectionChange(next);
  }

  function resolveRowSelectLabel(row: T, index: number, rowId: string) {
    const label = getRowId ? rowId : findMeaningfulRowLabel(row);
    return label ? `Select row ${label}` : `Select row ${index + 1}`;
  }

  function renderSortIndicator(column: DataColumn<T>) {
    if (!column.sortable) return null;
    if (sortKey !== column.key) {
      return <Icon name="chevronDown" size="sm" tone="secondary" />;
    }
    return <Icon name={sortDirection === "asc" ? "chevronUp" : "chevronDown"} size="sm" tone="accent" />;
  }

  function resolveSortState(column: DataColumn<T>) {
    if (!column.sortable) return undefined;
    if (sortKey !== column.key) return "none";
    return sortDirection === "asc" ? "ascending" : "descending";
  }

  const status = (
    <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
      {loadingStatus}
    </span>
  );

  if (!loading && rows.length === 0) {
    return (
      <div {...rest} aria-busy={loading}>
        {status}
        <EmptyState title={emptyTitle} description={emptyDescription} />
      </div>
    );
  }

  const table = (
    <TableShell surface="inset" caption={caption}>
      <thead>
        <TableRow head surface="inset">
          {selectable ? (
            <TableHeadCell control density={density}>
              <SelectAllCheckbox
                checked={allSelected}
                indeterminate={!allSelected && someSelected}
                disabled={allIds.length === 0}
                onChange={handleSelectAll}
              />
            </TableHeadCell>
          ) : null}
          {columns.map((column) => (
            <TableHeadCell key={column.key} align={column.align} density={density} aria-sort={resolveSortState(column)}>
              {column.sortable ? (
                <button
                  type="button"
                  className={cx("inline-flex items-center gap-1 hover:text-accent", controlHeightClasses.md)}
                  onClick={() => handleSortClick(column)}
                >
                  {column.header}
                  {renderSortIndicator(column)}
                </button>
              ) : (
                column.header
              )}
            </TableHeadCell>
          ))}
        </TableRow>
      </thead>
      <tbody>
        {loading
          ? Array.from({ length: loadingRows }, (_, i) => (
              <TableRow key={`skeleton-${i}`} surface="inset" interactive={false}>
                {selectable ? <TableCell control density={density} /> : null}
                {columns.map((column, colIndex) => (
                  <TableCell key={column.key} density={density}>
                    <div
                      aria-hidden="true"
                      className={cx(
                        "h-4 animate-pulse rounded-tokenSm bg-muted",
                        skeletonWidths[(i + colIndex) % skeletonWidths.length],
                      )}
                    />
                  </TableCell>
                ))}
              </TableRow>
            ))
          : rows.map((row, index) => {
              const rowId = getRowId ? getRowId(row, index) : String(index);
              const isSelected = selectable && selectedKeys.has(rowId);
              const rowProps = getRowProps ? getRowProps(row, index) : undefined;
              const selectLabel = resolveRowSelectLabel(row, index, rowId);

              return (
                <TableRow key={rowId} surface="inset" selected={isSelected} {...rowProps}>
                  {selectable ? (
                    <TableCell control density={density}>
                      <input
                        type="checkbox"
                        checked={isSelected}
                        disabled={isRowSelectable ? !isRowSelectable(row, index) : false}
                        onChange={() => handleSelectRow(rowId, isRowSelectable ? isRowSelectable(row, index) : true)}
                        aria-label={selectLabel}
                        className={cx("rounded border-border accent-accent", controlSquareSizeClasses.md)}
                      />
                    </TableCell>
                  ) : null}
                  {columns.map((column) => (
                    <TableCell key={column.key} align={column.align} density={density}>
                      {column.cell(row)}
                    </TableCell>
                  ))}
                </TableRow>
              );
            })}
      </tbody>
    </TableShell>
  );

  const cards = (
    <div role="list" className="space-y-3 md:hidden">
      {loading
        ? Array.from({ length: loadingRows }, (_, i) => (
            <div key={`skeleton-card-${i}`} className="inset-surface rounded-tokenMd border p-4">
              <div className="space-y-3">
                {columns.map((column, colIndex) => (
                  <div key={column.key} className="flex items-start justify-between gap-4">
                    <div className="h-3 w-16 animate-pulse rounded-tokenSm bg-muted" aria-hidden="true" />
                    <div
                      aria-hidden="true"
                      className={cx(
                        "h-4 animate-pulse rounded-tokenSm bg-muted",
                        skeletonWidths[(i + colIndex) % skeletonWidths.length],
                      )}
                    />
                  </div>
                ))}
              </div>
            </div>
          ))
        : rows.map((row, rowIndex) => {
            const rowId = getRowId ? getRowId(row, rowIndex) : String(rowIndex);
            const canSelect = isRowSelectable ? isRowSelectable(row, rowIndex) : true;
            const isSelected = selectable && selectedKeys.has(rowId);
            const rowProps = getRowProps ? getRowProps(row, rowIndex) : undefined;
            const selectLabel = resolveRowSelectLabel(row, rowIndex, rowId);

            return (
              <div
                key={rowId}
                role="listitem"
                {...rowProps}
                className={cx(
                  "inset-surface rounded-tokenMd border p-4",
                  isSelected ? "border-accent bg-surface-2" : "border-muted",
                )}
              >
                <div className="space-y-3">
                  {selectable ? (
                    <label
                      className={cx(
                        "flex items-center gap-2 text-sm font-semibold text-foreground",
                        controlHeightClasses.md,
                      )}
                    >
                      <input
                        type="checkbox"
                        checked={isSelected}
                        disabled={!canSelect}
                        onChange={() => handleSelectRow(rowId, canSelect)}
                        aria-label={selectLabel}
                        className="h-4 w-4 rounded border-border accent-accent"
                      />
                      <span>Select</span>
                    </label>
                  ) : null}
                  <dl>
                    {columns.map((column) => (
                      <div
                        key={column.key}
                        className="flex items-start justify-between gap-4 py-1.5 first:pt-0 last:pb-0"
                      >
                        <dt className="text-xs font-semibold uppercase tracking-wide text-secondary">
                          {column.mobileLabel ?? column.header}
                        </dt>
                        <dd
                          className={cx(
                            "max-w-[60%] text-right text-sm text-foreground",
                            column.align === "left" && "text-left",
                          )}
                        >
                          {column.cell(row)}
                        </dd>
                      </div>
                    ))}
                  </dl>
                </div>
              </div>
            );
          })}
    </div>
  );

  return (
    <div {...rest} aria-busy={loading}>
      {status}
      {mobileMode === "stack" ? cards : null}
      <div className={mobileMode === "stack" ? "hidden md:block" : "block"}>{table}</div>
    </div>
  );
}

function findMeaningfulRowLabel(row: unknown) {
  if (!row || typeof row !== "object") {
    return undefined;
  }

  for (const key of ["name", "displayName", "title", "label", "id"]) {
    const value = (row as Record<string, unknown>)[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      return String(value);
    }
  }

  return undefined;
}

function SelectAllCheckbox({
  checked,
  indeterminate,
  disabled,
  onChange,
}: Readonly<{
  checked: boolean;
  indeterminate: boolean;
  disabled: boolean;
  onChange: () => void;
}>) {
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (ref.current) {
      ref.current.indeterminate = indeterminate;
    }
  }, [indeterminate]);

  return (
    <input
      ref={ref}
      type="checkbox"
      checked={checked}
      disabled={disabled}
      onChange={onChange}
      aria-label="Select all rows"
      aria-checked={indeterminate ? "mixed" : checked}
      className={cx("rounded border-border accent-accent", controlSquareSizeClasses.md)}
    />
  );
}
