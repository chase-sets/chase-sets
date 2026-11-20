import type { HTMLAttributes, ReactNode } from "react";
import type { ResponsiveValue } from "../theme/tokens";
import { cx } from "../utils/cx";
import { resolveColumnsClass, type ColumnCount } from "../utils/system";

export interface StatListProps extends Omit<HTMLAttributes<HTMLDListElement>, "className" | "style"> {
  children?: ReactNode;
  columns?: ResponsiveValue<ColumnCount>;
}

/**
 * Figures a page reports, such as a market's last sale and medians, as a list of
 * terms and values. Unlike a heading per value, a screen reader reads each value
 * with its label and the page's outline keeps only its sections.
 */
export function StatList({ columns = { base: 1, sm: 2 }, children, ...rest }: StatListProps) {
  return (
    <dl {...rest} className={cx("m-0 grid gap-4", resolveColumnsClass(columns))}>
      {children}
    </dl>
  );
}

export interface StatListItemProps extends Omit<HTMLAttributes<HTMLDivElement>, "className" | "style"> {
  label: ReactNode;
  value: ReactNode;
  /** Lines under the value, such as the date of a sale or a count of trades. */
  detail?: ReactNode;
}

/** One stat in a `StatList`: its label as the term, then its value and any detail lines. */
export function StatListItem({ label, value, detail, ...rest }: StatListItemProps) {
  return (
    <div {...rest} className="flex flex-col gap-1">
      <dt className="text-sm leading-relaxed text-secondary">{label}</dt>
      <dd className="m-0 font-heading text-xl font-semibold leading-snug md:text-2xl md:leading-snug">{value}</dd>
      {detail ? <dd className="m-0 flex flex-col gap-1">{detail}</dd> : null}
    </div>
  );
}
