import type { ReactNode } from "react";
import { cn } from "../../lib/utils";
import { Badge } from "./badge";

export interface NavigationHeaderItem {
  label: ReactNode;
  href: string;
  active?: boolean;
}

export interface NavigationHeaderProps {
  brand: ReactNode;
  badge?: ReactNode;
  description?: ReactNode;
  logo?: ReactNode;
  items: NavigationHeaderItem[];
  actions?: ReactNode;
  ariaLabel?: string;
  sticky?: boolean;
  className?: string;
}

export function NavigationHeader({
  brand,
  badge,
  description,
  logo,
  items,
  actions,
  ariaLabel = "Primary navigation",
  sticky = true,
  className
}: NavigationHeaderProps) {
  return (
    <header
      className={cn(
        "z-40 border-b border-[var(--muted)] bg-[color-mix(in_srgb,var(--background)_88%,transparent)] backdrop-blur",
        sticky && "sticky top-0",
        className
      )}
    >
      <div className="mx-auto flex max-w-7xl flex-col gap-4 px-4 py-4 md:flex-row md:items-center md:justify-between">
        <div className="flex min-w-0 items-center gap-3">
          {logo ? (
            <div className="grid h-12 w-12 shrink-0 place-items-center rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--card)] shadow-[var(--shadow-sm)]">
              {logo}
            </div>
          ) : null}
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <strong className="ds-display truncate text-2xl">{brand}</strong>
              {badge ? <Badge variant="secondary">{badge}</Badge> : null}
            </div>
            {description ? (
              <p className="m-0 text-sm text-[var(--muted-foreground)]">{description}</p>
            ) : null}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <nav className="flex flex-wrap items-center gap-2" aria-label={ariaLabel}>
            {items.map((item) => (
              <a
                key={item.href}
                href={item.href}
                aria-current={item.active ? "page" : undefined}
                className={cn(
                  "rounded-[var(--radius)] px-3 py-2 text-sm font-semibold transition-colors",
                  item.active
                    ? "bg-[var(--primary)] text-[var(--primary-foreground)] shadow-[var(--shadow-sm)]"
                    : "text-[var(--muted-foreground)] hover:bg-[var(--secondary)] hover:text-[var(--foreground)]"
                )}
              >
                {item.label}
              </a>
            ))}
          </nav>
          {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
        </div>
      </div>
    </header>
  );
}
