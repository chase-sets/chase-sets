import type { HTMLAttributes, ReactNode } from "react";
import { resolveDensityMode, type DensityInput, type DensityMode } from "../../theme/tokens";

export interface KeyValueItem {
  key: ReactNode;
  value: ReactNode;
}

export type KeyValueListLayout = "paired" | "split" | "grid";
export type KeyValueListValueAlign = "start" | "end";

export interface KeyValueListProps extends Omit<HTMLAttributes<HTMLDListElement>, "className" | "style"> {
  items: KeyValueItem[];
  density?: DensityInput;
  variant?: "surface" | "plain";
  layout?: KeyValueListLayout;
  valueAlign?: KeyValueListValueAlign;
}

export function KeyValueList({
  items,
  density = "comfortable",
  variant = "plain",
  layout = "paired",
  valueAlign,
  ...rest
}: KeyValueListProps) {
  const resolvedValueAlign = valueAlign ?? (layout === "split" ? "end" : "start");
  const resolvedDensity = resolveDensityMode(density);

  return (
    <dl {...rest} className={listClassName(variant, layout)}>
      {items.map((item, index) => (
        <div key={index} className={rowClassName(resolvedDensity, layout)}>
          <dt className={labelClassName(layout)}>{item.key}</dt>
          <dd className={valueClassName(resolvedValueAlign, layout)}>{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function listClassName(variant: NonNullable<KeyValueListProps["variant"]>, layout: KeyValueListLayout) {
  const gridLayoutClass = "grid gap-x-8 gap-y-0 sm:grid-cols-2";
  const rowLayoutClass = "grid gap-0";

  if (variant === "surface") {
    return [
      "inset-surface rounded-tokenMd border border-muted p-4",
      layout === "grid" ? gridLayoutClass : rowLayoutClass,
    ].join(" ");
  }

  return layout === "grid" ? gridLayoutClass : rowLayoutClass;
}

function rowClassName(density: DensityMode, layout: KeyValueListLayout) {
  const spacingClass =
    density === "compact"
      ? "border-b border-muted py-2 first:pt-0 last:border-b-0 last:pb-0"
      : "border-b border-muted pb-3 last:border-b-0 last:pb-0";

  if (layout === "split") {
    return ["flex items-start justify-between gap-4", spacingClass].join(" ");
  }

  if (layout === "grid") {
    return ["grid gap-1", spacingClass].join(" ");
  }

  return ["grid grid-cols-1 gap-1 sm:grid-cols-[minmax(8rem,12rem)_minmax(0,1fr)] sm:gap-3", spacingClass].join(" ");
}

function labelClassName(layout: KeyValueListLayout) {
  return ["text-xs font-semibold uppercase text-secondary", layout === "split" ? "shrink-0" : ""]
    .filter(Boolean)
    .join(" ");
}

function valueClassName(valueAlign: KeyValueListValueAlign, layout: KeyValueListLayout) {
  return [
    "min-w-0 text-sm text-foreground",
    valueAlign === "end" ? "text-right" : "text-left",
    layout === "split" ? "" : "break-words",
  ]
    .filter(Boolean)
    .join(" ");
}
