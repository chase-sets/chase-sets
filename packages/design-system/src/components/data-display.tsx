import type { HTMLAttributes, ReactNode } from "react";
import type { ResponsiveValue } from "../theme/tokens";
import { cx } from "../utils/cx";
import { resolveColumnsClass } from "../utils/system";
import { Button } from "./actions";
import { Drawer, EmptyState, type DrawerProps } from "./feedback";

export interface TableProps
  extends Omit<HTMLAttributes<HTMLDivElement>, "className" | "style"> {
  columns: ReactNode[];
  rows: ReactNode[][];
  caption?: ReactNode;
}

export function Table({
  columns,
  rows,
  caption,
  ...rest
}: TableProps) {
  return (
    <div
      {...rest}
      className="modern-surface overflow-x-auto rounded-tokenLg border border-muted shadow-tokenSm"
    >
      <table className="min-w-full border-collapse text-left text-sm">
        {caption ? <caption className="sr-only">{caption}</caption> : null}
        <thead>
          <tr className="border-b border-muted bg-background">
            {columns.map((column, index) => (
              <th key={index} className="px-4 py-3 font-semibold text-foreground">
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr key={rowIndex} className="border-b border-muted last:border-b-0">
              {row.map((cell, cellIndex) => (
                <td key={cellIndex} className="px-4 py-3 text-secondary">
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export interface DataColumn<T> {
  key: string;
  header: ReactNode;
  mobileLabel?: ReactNode;
  align?: "left" | "right";
  cell: (row: T) => ReactNode;
}

export interface DataTableProps<T>
  extends Omit<HTMLAttributes<HTMLDivElement>, "className" | "style"> {
  rows: T[];
  columns: DataColumn<T>[];
  mobileMode?: "stack" | "scroll";
  getRowId?: (row: T, index: number) => string;
  emptyTitle?: ReactNode;
  emptyDescription?: ReactNode;
}

export function DataTable<T>({
  rows,
  columns,
  mobileMode = "stack",
  getRowId,
  emptyTitle = "Nothing to review",
  emptyDescription = "Adjust filters or add new records to populate this view.",
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

  const table = (
    <div className="modern-surface overflow-x-auto rounded-tokenLg border border-muted shadow-tokenSm">
      <table className="min-w-full border-collapse text-left text-sm">
        <thead>
          <tr className="border-b border-muted bg-background">
            {columns.map((column) => (
              <th
                key={column.key}
                className={cx(
                  "px-4 py-3 font-semibold text-foreground",
                  column.align === "right" && "text-right"
                )}
              >
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr
              key={getRowId ? getRowId(row, index) : String(index)}
              className="border-b border-muted last:border-b-0"
            >
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
          ))}
        </tbody>
      </table>
    </div>
  );

  const cards = (
    <div className="space-y-3 md:hidden">
      {rows.map((row, rowIndex) => (
        <div
          key={getRowId ? getRowId(row, rowIndex) : String(rowIndex)}
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

export interface KeyValueItem {
  key: ReactNode;
  value: ReactNode;
}

export interface KeyValueListProps
  extends Omit<HTMLAttributes<HTMLDListElement>, "className" | "style"> {
  items: KeyValueItem[];
}

export function KeyValueList({
  items,
  ...rest
}: KeyValueListProps) {
  return (
    <dl
      {...rest}
      className="modern-surface grid gap-3 rounded-tokenLg border border-muted p-4 shadow-tokenSm"
    >
      {items.map((item, index) => (
        <div
          key={index}
          className="flex items-start justify-between gap-4 border-b border-muted pb-3 last:border-b-0 last:pb-0"
        >
          <dt className="text-xs font-semibold uppercase tracking-wide text-secondary">
            {item.key}
          </dt>
          <dd className="text-sm text-foreground">{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export interface StatProps
  extends Omit<HTMLAttributes<HTMLDivElement>, "className" | "style"> {
  label: ReactNode;
  value: ReactNode;
  trend?: ReactNode;
}

export function Stat({
  label,
  value,
  trend,
  ...rest
}: StatProps) {
  return (
    <div
      {...rest}
      className="modern-surface rounded-tokenLg border border-muted p-4 shadow-tokenSm"
    >
      <div className="text-xs font-semibold uppercase tracking-wide text-secondary">
        {label}
      </div>
      <div className="mt-2 font-heading text-3xl font-semibold text-foreground">
        {value}
      </div>
      {trend ? <div className="mt-2 text-sm text-secondary">{trend}</div> : null}
    </div>
  );
}

export interface StatGridProps
  extends Omit<HTMLAttributes<HTMLDivElement>, "className" | "style"> {
  children?: ReactNode;
  columns?: ResponsiveValue<1 | 2 | 3 | 4>;
}

export function StatGrid({
  columns = { base: 1, sm: 2 },
  children,
  ...rest
}: StatGridProps) {
  return (
    <div
      {...rest}
      className={cx("grid gap-4", resolveColumnsClass(columns))}
    >
      {children}
    </div>
  );
}

export interface TimelineItem {
  title: ReactNode;
  description?: ReactNode;
  timestamp?: ReactNode;
}

export interface TimelineProps
  extends Omit<HTMLAttributes<HTMLOListElement>, "className" | "style"> {
  items: TimelineItem[];
}

export function Timeline({
  items,
  ...rest
}: TimelineProps) {
  return (
    <ol
      {...rest}
      className="modern-surface space-y-4 rounded-tokenLg border border-muted p-4 shadow-tokenSm"
    >
      {items.map((item, index) => (
        <li key={index} className="flex gap-3">
          <span className="mt-1 inline-flex h-3 w-3 shrink-0 rounded-full bg-accent" />
          <div className="space-y-1">
            <div className="text-sm font-semibold text-foreground">{item.title}</div>
            {item.description ? (
              <div className="text-sm text-secondary">{item.description}</div>
            ) : null}
            {item.timestamp ? (
              <div className="text-xs text-secondary">{item.timestamp}</div>
            ) : null}
          </div>
        </li>
      ))}
    </ol>
  );
}

export interface ActivityItem extends TimelineItem {
  actor?: ReactNode;
}

export interface ActivityListProps
  extends Omit<HTMLAttributes<HTMLUListElement>, "className" | "style"> {
  items: ActivityItem[];
}

export function ActivityList({
  items,
  ...rest
}: ActivityListProps) {
  return (
    <ul
      {...rest}
      className="modern-surface space-y-3 rounded-tokenLg border border-muted p-4 shadow-tokenSm"
    >
      {items.map((item, index) => (
        <li
          key={index}
          className="rounded-tokenMd bg-background px-4 py-3"
        >
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="space-y-1">
              <div className="text-sm font-semibold text-foreground">{item.title}</div>
              {item.description ? (
                <div className="text-sm text-secondary">{item.description}</div>
              ) : null}
            </div>
            <div className="text-xs text-secondary">
              {item.actor}
              {item.actor && item.timestamp ? " • " : null}
              {item.timestamp}
            </div>
          </div>
        </li>
      ))}
    </ul>
  );
}

export interface CardProps
  extends Omit<HTMLAttributes<HTMLDivElement>, "className" | "style"> {
  children?: ReactNode;
}

export function Card({
  children,
  ...rest
}: CardProps) {
  return (
    <div
      {...rest}
      className="modern-surface rounded-tokenLg border border-muted p-4 shadow-tokenSm"
    >
      {children}
    </div>
  );
}

export interface DetailPanelProps extends Omit<CardProps, "title"> {
  title: ReactNode;
  actions?: ReactNode;
}

export function DetailPanel({
  title,
  actions,
  children,
  ...rest
}: DetailPanelProps) {
  return (
    <Card {...rest}>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="font-heading text-lg font-semibold text-foreground">{title}</div>
        {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
      </div>
      {children != null ? <div className="space-y-4">{children}</div> : null}
    </Card>
  );
}

export interface FilterBarProps
  extends Omit<HTMLAttributes<HTMLDivElement>, "className" | "style"> {
  children?: ReactNode;
  actions?: ReactNode;
  stickyOffset?: string;
}

export function FilterBar({
  children,
  actions,
  stickyOffset,
  ...rest
}: FilterBarProps) {
  return (
    <div
      {...rest}
      style={stickyOffset ? { top: stickyOffset } : undefined}
      className={cx(
        "modern-surface sticky z-sticky flex flex-col gap-3 rounded-tokenLg border border-muted p-4 shadow-tokenSm md:flex-row md:items-center md:justify-between",
        !stickyOffset && "top-16"
      )}
    >
      <div className="flex flex-1 flex-wrap gap-3">{children}</div>
      {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
    </div>
  );
}

export interface FilterDrawerProps
  extends Omit<DrawerProps, "title" | "trigger" | "children"> {
  trigger: ReactNode;
  children?: ReactNode;
}

export function FilterDrawer({
  trigger,
  children,
  ...rest
}: FilterDrawerProps) {
  return (
    <Drawer
      {...rest}
      trigger={trigger}
      title="Filters"
      footer={<Button tone="primary" block>Apply filters</Button>}
    >
      <div className="space-y-4">{children}</div>
    </Drawer>
  );
}

export interface BulkActionBarProps
  extends Omit<HTMLAttributes<HTMLDivElement>, "className" | "style"> {
  count: number;
  actions?: ReactNode;
}

export function BulkActionBar({
  count,
  actions,
  ...rest
}: BulkActionBarProps) {
  return (
    <div
      {...rest}
      className="modern-surface sticky bottom-20 z-sticky flex flex-col gap-3 rounded-tokenLg border border-accent p-4 shadow-overlay md:bottom-4 md:flex-row md:items-center md:justify-between"
    >
      <div className="text-sm font-semibold text-foreground">
        {count} item{count === 1 ? "" : "s"} selected
      </div>
      {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
    </div>
  );
}
