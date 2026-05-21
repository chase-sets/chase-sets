import type { TableHTMLAttributes, TdHTMLAttributes, ThHTMLAttributes } from "react";
import { cn } from "../../lib/utils";

export function Table({ className, ...props }: TableHTMLAttributes<HTMLTableElement>) {
  return (
    <div className="w-full">
      <table
        {...props}
        className={cn(
          "w-full caption-bottom border-separate border-spacing-0 text-sm md:overflow-hidden md:rounded-[var(--radius-lg)] md:border md:border-[var(--muted)] md:bg-[var(--card)] md:shadow-[var(--shadow-sm)]",
          className,
        )}
      />
    </div>
  );
}

export function TableHeader({ className, ...props }: TableHTMLAttributes<HTMLTableSectionElement>) {
  return (
    <thead
      {...props}
      className={cn("hidden bg-[var(--secondary)] text-[var(--secondary-foreground)] md:table-header-group", className)}
    />
  );
}

export function TableBody({ className, ...props }: TableHTMLAttributes<HTMLTableSectionElement>) {
  return <tbody {...props} className={cn("grid gap-3 md:table-row-group md:[&_tr:last-child]:border-0", className)} />;
}

export function TableRow({ className, ...props }: TableHTMLAttributes<HTMLTableRowElement>) {
  return (
    <tr
      {...props}
      className={cn(
        "ds-panel grid gap-3 rounded-[var(--radius-lg)] border border-[var(--muted)] p-4 shadow-[var(--shadow-sm)] transition-colors md:table-row md:rounded-none md:border-0 md:border-b md:p-0 md:shadow-none md:hover:bg-[var(--muted)]/60",
        className,
      )}
    />
  );
}

export function TableHead({ className, ...props }: ThHTMLAttributes<HTMLTableCellElement>) {
  return (
    <th
      {...props}
      className={cn(
        "h-11 px-4 text-left align-middle text-xs font-semibold uppercase text-[var(--muted-foreground)]",
        className,
      )}
    />
  );
}

export function TableCell({ className, ...props }: TdHTMLAttributes<HTMLTableCellElement>) {
  return (
    <td
      {...props}
      className={cn(
        "grid gap-1 align-middle before:text-xs before:font-semibold before:uppercase before:text-[var(--muted-foreground)] before:content-[attr(data-label)] md:table-cell md:px-4 md:py-3 md:before:hidden",
        className,
      )}
    />
  );
}
