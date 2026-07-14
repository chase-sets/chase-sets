import type { HTMLAttributes } from "react";
import { cx } from "../../utils/cx";
import { IconButton } from "./button";

export interface PaginationProps extends Omit<HTMLAttributes<HTMLElement>, "className" | "style"> {
  page: number;
  totalPages: number;
  onPageChange?: (page: number) => void;
  previousLabel?: string;
  nextLabel?: string;
}

function buildPageRange(page: number, totalPages: number): (number | "ellipsis-start" | "ellipsis-end")[] {
  if (totalPages <= 7) {
    return Array.from({ length: totalPages }, (_, i) => i + 1);
  }
  const pages: (number | "ellipsis-start" | "ellipsis-end")[] = [1];
  if (page > 3) {
    pages.push("ellipsis-start");
  }
  const start = Math.max(2, page - 1);
  const end = Math.min(totalPages - 1, page + 1);
  for (let i = start; i <= end; i++) {
    pages.push(i);
  }
  if (page < totalPages - 2) {
    pages.push("ellipsis-end");
  }
  pages.push(totalPages);
  return pages;
}

export function Pagination({
  page,
  totalPages,
  onPageChange,
  previousLabel = "Previous page",
  nextLabel = "Next page",
  ...rest
}: PaginationProps) {
  const pages = buildPageRange(page, totalPages);
  const previousDisabled = page <= 1;
  const nextDisabled = page >= totalPages;

  return (
    <nav {...rest} aria-label="Pagination" className="flex items-center gap-2">
      <IconButton
        label={previousLabel}
        icon="chevronLeft"
        tone="secondary"
        aria-disabled={previousDisabled || undefined}
        onClick={(event) => {
          if (previousDisabled) {
            event.preventDefault();
            return;
          }

          onPageChange?.(Math.max(1, page - 1));
        }}
      />
      <div className="flex flex-wrap gap-2">
        {pages.map((value) => {
          if (typeof value === "string") {
            return (
              <span
                key={value}
                className="inline-flex min-h-11 min-w-11 items-center justify-center text-sm text-secondary"
                aria-hidden="true"
              >
                &hellip;
              </span>
            );
          }
          return (
            <button
              key={value}
              type="button"
              aria-current={value === page ? "page" : undefined}
              className={cx(
                "focus-ring inline-flex min-h-11 min-w-11 items-center justify-center rounded-tokenMd border px-3 text-sm font-semibold transition",
                value === page
                  ? "border-accent bg-accent text-accent-contrast"
                  : "border-muted bg-elevated text-secondary hover:text-foreground",
              )}
              onClick={() => onPageChange?.(value)}
            >
              {value}
            </button>
          );
        })}
      </div>
      <IconButton
        label={nextLabel}
        icon="chevronRight"
        tone="secondary"
        aria-disabled={nextDisabled || undefined}
        onClick={(event) => {
          if (nextDisabled) {
            event.preventDefault();
            return;
          }

          onPageChange?.(Math.min(totalPages, page + 1));
        }}
      />
    </nav>
  );
}
