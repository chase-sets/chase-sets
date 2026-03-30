import type { HTMLAttributes, ReactNode } from "react";
import { Icon, type IconName } from "../../icons";
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
}

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
  ...rest
}: DataTableProps<T>) {
  if (rows.length === 0) {
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
    <div className="modern-surface overflow-x-auto rounded-tokenLg border border-muted shadow-tokenSm">
      <table className="min-w-full border-collapse text-left text-sm">
        <thead>
          <tr className="border-b border-muted bg-background">
            {selectable ? (
              <th className="w-12 px-4 py-3">
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
                  "px-4 py-3 font-semibold text-foreground",
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
          {rows.map((row, index) => {
            const rowId = getRowId ? getRowId(row, index) : String(index);
            const isSelected = selectable && selectedKeys.has(rowId);

            return (
              <tr
                key={rowId}
                className={cx(
                  "border-b border-muted last:border-b-0",
                  isSelected && "bg-background"
                )}
              >
                {selectable ? (
                  <td className="w-12 px-4 py-3">
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
                      "px-4 py-3 text-secondary",
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
      {rows.map((row, rowIndex) => (
        <div
          key={getRowId ? getRowId(row, rowIndex) : String(rowIndex)}
          role="listitem"
          className="modern-surface rounded-tokenLg border border-muted p-4 shadow-tokenSm"
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
