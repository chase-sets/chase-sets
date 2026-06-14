import type { HTMLAttributes, ReactNode } from "react";
import { cx } from "../../utils/cx";
import { Stack } from "../../primitives/layout";

export interface ComparisonListProps extends Omit<HTMLAttributes<HTMLDivElement>, "className" | "style"> {
  children?: ReactNode;
}

export function ComparisonList({ children, ...rest }: ComparisonListProps) {
  return (
    <Stack {...rest} gap={3}>
      {children}
    </Stack>
  );
}

export interface ComparisonListHeaderProps extends Omit<HTMLAttributes<HTMLDivElement>, "className" | "style"> {
  labels: readonly [ReactNode, ReactNode, ReactNode, ReactNode];
}

export function ComparisonListHeader({ labels, ...rest }: ComparisonListHeaderProps) {
  return (
    <div
      {...rest}
      className="hidden min-w-0 grid-cols-[minmax(5.5rem,0.8fr)_minmax(8rem,1.15fr)_minmax(10rem,1.25fr)_minmax(6.5rem,auto)] items-center gap-3 px-3 text-xs font-semibold uppercase text-secondary lg:grid"
      aria-hidden="true"
    >
      <span>{labels[0]}</span>
      <span>{labels[1]}</span>
      <span>{labels[2]}</span>
      <span className="text-right">{labels[3]}</span>
    </div>
  );
}

export interface ComparisonListRowProps extends Omit<HTMLAttributes<HTMLElement>, "className" | "style"> {
  children?: ReactNode;
  selected?: boolean;
}

export function ComparisonListRow({ children, selected = false, ...rest }: ComparisonListRowProps) {
  return (
    <article
      {...rest}
      className={cx(
        "glass-surface relative min-w-0 overflow-hidden rounded-tokenLg border p-3 shadow-tokenSm transition",
        selected ? "border-accent bg-surface-2 shadow-tokenMd" : "border-muted",
      )}
    >
      {selected ? <span className="absolute inset-y-0 left-0 w-1 rounded-l-tokenLg bg-accent" /> : null}
      {children}
    </article>
  );
}

export interface ComparisonListRowGridProps extends Omit<HTMLAttributes<HTMLDivElement>, "className" | "style"> {
  children?: ReactNode;
}

export function ComparisonListRowGrid({ children, ...rest }: ComparisonListRowGridProps) {
  return (
    <div
      {...rest}
      className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-2 pl-2 lg:grid-cols-[minmax(5.5rem,0.8fr)_minmax(8rem,1.15fr)_minmax(10rem,1.25fr)_minmax(6.5rem,auto)] lg:items-center lg:gap-3 lg:pl-0"
    >
      {children}
    </div>
  );
}

export interface ComparisonListCellProps extends Omit<HTMLAttributes<HTMLDivElement>, "className" | "style"> {
  area?: "price" | "account" | "product" | "action";
  children?: ReactNode;
}

const comparisonCellClasses: Record<NonNullable<ComparisonListCellProps["area"]>, string> = {
  price: "min-w-0",
  account: "col-start-1 row-start-2 min-w-0 lg:col-start-auto lg:row-start-auto",
  product: "col-span-2 col-start-1 row-start-3 min-w-0 lg:col-span-1 lg:col-start-auto lg:row-start-auto",
  action:
    "col-start-2 row-start-1 flex min-w-0 justify-end self-start lg:col-start-auto lg:row-start-auto lg:self-center [&>button]:min-h-11 lg:[&>button]:min-h-8",
};

export function ComparisonListCell({ area = "price", children, ...rest }: ComparisonListCellProps) {
  return (
    <div {...rest} className={comparisonCellClasses[area]}>
      {children}
    </div>
  );
}

export interface ComparisonListPriceProps extends Omit<HTMLAttributes<HTMLSpanElement>, "className" | "style"> {
  children?: ReactNode;
}

export function ComparisonListPrice({ children, ...rest }: ComparisonListPriceProps) {
  return (
    <span {...rest} className="font-heading text-lg font-bold leading-tight text-foreground tabular-nums lg:text-base">
      {children}
    </span>
  );
}
