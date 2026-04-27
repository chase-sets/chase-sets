import type { HTMLAttributes, ReactNode } from "react";
import { Icon, type IconName } from "../../icons";
import { useDensity } from "../../theme/provider";
import { cx } from "../../utils/cx";
import { EmptyState } from "../feedback";

export interface DataColumn<T> {
  key: string;
  header: ReactNode;
  mobileLabel?: ReactNode;
  align?: "left" | "right";
  cell: (row: T) => ReactNode;
  sortable?: boolean;
}

export interface DataTableProps<T>
  extends Omit<HTMLAttributes<HTMLDivElement>, "className" | "style"> {
  rows: T[];
  columns: DataColumn<T>[];
  mobileMode?: "stack" | "scroll";
  getRowId?: (row: T, index: number) => string;
  emptyTitle?: ReactNode;
  emptyDescription?: ReactNode;
  sortKey?: string;
  sortDirection?: "asc" | "desc";
  onSortChange?: (key: string, direction: "asc" | "desc") => void;
  selectedKeys?: Set<string>;
  onSelectionChange?: (keys: Set<string>) => void;
  loading?: boolean;
  loadingRows?: number;
  density?: "comfortable" | "compact";
}

const skeletonWidths = ["w-3/4", "w-1/2", "w-2/3", "w-5/6", "w-2/5"] as const;

export function DataTable<T>({
  rows,
  columns,
  mobileMode = "stack",
  getRowId,
  emptyTitle = "Nothing to review",
  emptyDescription = "Adjust filters or add new records to populate this view.",
  sortKey,
  sortDirection,
  onSortChange,
  selectedKeys,
  onSelectionChange,
  loading = false,
  loadingRows = 5,
  density: densityProp,
  ...rest
}: DataTableProps<T>) {
  const density = densityProp ?? useDensity();
  const cellPad = density === "compact" ? "px-3 py-2" : "px-4 py-3";
  const headPad = density === "compact" ? "px-3 py-2" : "px-4 py-3";
  if (!loading && rows.length === 0) {
    return (
      <EmptyState
        title={emptyTitle}
        description={emptyDescription}
      />
    );
  }

  const selectable = selectedKeys !== undefined && onSelectionChange !== undefined;
  const allIds = selectable
    ? rows.map((row, index) => getRowId ? getRowId(row, index) : String(index))
    : [];
  const allSelected = selectable && allIds.length > 0 && allIds.every((id) => selectedKeys.has(id));

  function handleSortClick(column: DataColumn<T>) {
    if (!column.sortable || !onSortChange) return;
    const nextDirection =
      sortKey === column.key && sortDirection === "asc" ? "desc" : "asc";
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

  function handleSelectRow(id: string) {
    if (!onSelectionChange || !selectedKeys) return;
    const next = new Set(selectedKeys);
    if (next.has(id)) {
      next.delete(id);
    } else {
      next.add(id);
    }
    onSelectionChange(next);
  }

  function renderSortIndicator(column: DataColumn<T>) {
    if (!column.sortable) return null;
    if (sortKey !== column.key) {
      return <Icon name="chevronDown" size="sm" tone="secondary" />;
    }
    return (
      <Icon
        name={sortDirection === "asc" ? "chevronUp" : "chevronDown"}
        size="sm"
        tone="accent"
      />
    );
  }

  const table = (
    <div className="glass-surface overflow-x-auto rounded-tokenLg border border-muted shadow-tokenSm">
      <table className="min-w-full border-collapse text-left text-sm">
        <thead>
          <tr className="border-b border-muted bg-surface-2">
            {selectable ? (
              <th className={cx("w-12", headPad)}>
                <input
                  type="checkbox"
                  checked={allSelected}
                  onChange={handleSelectAll}
                  aria-label="Select all rows"
                  className="h-4 w-4 rounded border-border accent-accent"
                />
              </th>
            ) : null}
            {columns.map((column) => (
              <th
                key={column.key}
                className={cx(
                  headPad, "font-semibold text-foreground",
                  column.align === "right" && "text-right"
                )}
              >
                {column.sortable ? (
                  <button
                    type="button"
                    className="inline-flex items-center gap-1 hover:text-accent"
                    onClick={() => handleSortClick(column)}
                  >
                    {column.header}
                    {renderSortIndicator(column)}
                  </button>
                ) : (
                  column.header
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {loading
            ? Array.from({ length: loadingRows }, (_, i) => (
                <tr key={`skeleton-${i}`} className="border-b border-muted last:border-b-0">
                  {selectable ? <td className={cx("w-12", cellPad)} /> : null}
                  {columns.map((column, colIndex) => (
                    <td key={column.key} className={cellPad}>
                      <div
                        aria-hidden="true"
                        className={cx(
                          "h-4 animate-pulse rounded-tokenSm bg-muted",
                          skeletonWidths[(i + colIndex) % skeletonWidths.length]
                        )}
                      />
                    </td>
                  ))}
                </tr>
              ))
            : rows.map((row, index) => {
                const rowId = getRowId ? getRowId(row, index) : String(index);
                const isSelected = selectable && selectedKeys.has(rowId);

                return (
                  <tr
                    key={rowId}
                    className={cx(
                      "border-b border-muted transition-colors last:border-b-0",
                      isSelected ? "bg-surface-2" : "hover:bg-surface-2/70"
                    )}
                  >
                    {selectable ? (
                      <td className={cx("w-12", cellPad)}>
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={() => handleSelectRow(rowId)}
                          aria-label={`Select row ${rowId}`}
                          className="h-4 w-4 rounded border-border accent-accent"
                        />
                      </td>
                    ) : null}
                    {columns.map((column) => (
                      <td
                        key={column.key}
                        className={cx(
                          cellPad, "text-foreground",
                          column.align === "right" && "text-right"
                        )}
                      >
                        {column.cell(row)}
                      </td>
                    ))}
                  </tr>
                );
              })}
        </tbody>
      </table>
    </div>
  );

  const cards = (
    <div role="list" className="space-y-3 md:hidden">
      {loading
        ? Array.from({ length: loadingRows }, (_, i) => (
            <div key={`skeleton-card-${i}`} className="glass-surface rounded-tokenLg border border-muted p-4 shadow-tokenSm">
              <div className="space-y-3">
                {columns.map((column, colIndex) => (
                  <div key={column.key} className="flex items-start justify-between gap-4">
                    <div className="h-3 w-16 animate-pulse rounded-tokenSm bg-muted" aria-hidden="true" />
                    <div
                      aria-hidden="true"
                      className={cx(
                        "h-4 animate-pulse rounded-tokenSm bg-muted",
                        skeletonWidths[(i + colIndex) % skeletonWidths.length]
                      )}
                    />
                  </div>
                ))}
              </div>
            </div>
          ))
        : rows.map((row, rowIndex) => (
            <div
              key={getRowId ? getRowId(row, rowIndex) : String(rowIndex)}
              role="listitem"
              className="glass-surface rounded-tokenLg border border-muted p-4 shadow-tokenSm"
            >
              <div className="space-y-3">
                {columns.map((column) => (
                  <div key={column.key} className="flex items-start justify-between gap-4">
                    <div className="text-xs font-semibold uppercase tracking-wide text-secondary">
                      {column.mobileLabel ?? column.header}
                    </div>
                    <div
                      className={cx(
                        "max-w-[60%] text-right text-sm text-foreground",
                        column.align === "left" && "text-left"
                      )}
                    >
                      {column.cell(row)}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
    </div>
  );

  return (
    <div {...rest}>
      {mobileMode === "stack" ? cards : null}
      <div className={mobileMode === "stack" ? "hidden md:block" : "block"}>{table}</div>
    </div>
  );
}
