import type { HTMLAttributes, ReactNode } from "react";

export interface KeyValueItem {
  key: ReactNode;
  value: ReactNode;
}

export interface KeyValueListProps extends Omit<HTMLAttributes<HTMLDListElement>, "className" | "style"> {
  items: KeyValueItem[];
  density?: "default" | "compact";
  variant?: "surface" | "plain";
}

export function KeyValueList({ items, density = "default", variant = "plain", ...rest }: KeyValueListProps) {
  return (
    <dl
      {...rest}
      className={
        variant === "surface" ? "inset-surface grid gap-3 rounded-tokenMd border border-muted p-4" : "grid gap-0"
      }
    >
      {items.map((item, index) => (
        <div
          key={index}
          className={
            density === "compact"
              ? "flex items-start justify-between gap-4 border-b border-muted py-2 first:pt-0 last:border-b-0 last:pb-0"
              : "flex items-start justify-between gap-4 border-b border-muted pb-3 last:border-b-0 last:pb-0"
          }
        >
          <dt className="text-xs font-semibold uppercase text-secondary">{item.key}</dt>
          <dd className="min-w-0 text-right text-sm text-foreground">{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}
