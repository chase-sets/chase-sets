import type { HTMLAttributes } from "react";
import { Icon } from "../../icons";
import { useLinkComponent } from "../../theme/link-adapter";

export interface BreadcrumbItem {
  label: string;
  href?: string;
}

export interface BreadcrumbsProps extends Omit<HTMLAttributes<HTMLElement>, "className" | "style"> {
  items: BreadcrumbItem[];
  ariaLabel?: string;
}

export function Breadcrumbs({ items, ariaLabel = "Breadcrumb", ...rest }: BreadcrumbsProps) {
  const Link = useLinkComponent();

  return (
    <nav {...rest} aria-label={ariaLabel}>
      <ol className="flex flex-wrap items-center gap-2 text-sm text-secondary">
        {items.map((item, index) => {
          const isCurrent = index === items.length - 1;

          return (
            <li key={`${item.label}-${index}`} className="inline-flex items-center gap-2">
              {item.href && !isCurrent ? (
                <Link href={item.href} className="focus-ring rounded-tokenSm hover:text-foreground">
                  {item.label}
                </Link>
              ) : (
                <span
                  aria-current={isCurrent ? "page" : undefined}
                  className={isCurrent ? "font-semibold text-foreground" : undefined}
                >
                  {item.label}
                </span>
              )}
              {!isCurrent ? <Icon name="chevronRight" size="sm" tone="secondary" /> : null}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
