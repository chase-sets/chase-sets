import type { HTMLAttributes } from "react";
import { Icon } from "../../icons";

export interface BreadcrumbItem {
  label: string;
  href?: string;
}

export interface BreadcrumbsProps
  extends Omit<HTMLAttributes<HTMLElement>, "className" | "style"> {
  items: BreadcrumbItem[];
  ariaLabel?: string;
}

export function Breadcrumbs({
  items,
  ariaLabel = "Breadcrumb",
  ...rest
}: BreadcrumbsProps) {
  return (
    <nav {...rest} aria-label={ariaLabel}>
      <ol className="flex flex-wrap items-center gap-2 text-sm text-secondary">
        {items.map((item, index) => {
          const isCurrent = index === items.length - 1;

          return (
            <li key={`${item.label}-${index}`} className="inline-flex items-center gap-2">
              {item.href && !isCurrent ? (
                <a href={item.href} className="focus-ring rounded-tokenSm hover:text-foreground">
                  {item.label}
                </a>
              ) : (
                <span className={isCurrent ? "font-semibold text-foreground" : undefined}>
                  {item.label}
                </span>
              )}
              {!isCurrent ? (
                <Icon name="chevronRight" size="sm" tone="secondary" />
              ) : null}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
