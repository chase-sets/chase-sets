import type { HTMLAttributes, ReactNode } from "react";

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
