import {
  forwardRef,
  type HTMLAttributes,
  type ReactNode,
  type Ref,
  type TdHTMLAttributes,
  type ThHTMLAttributes,
} from "react";
import { useDensity } from "../../theme/provider";
import { cx } from "../../utils/cx";

type FrameProps = Omit<HTMLAttributes<HTMLElement>, "className" | "style">;

export type TableDensity = "comfortable" | "compact";
export type TableMobileMode = "stack" | "scroll";

/**
 * Named wrapper surfaces for the table shell. Both flavors share the structural
 * chrome (`overflow-x-auto`, the `<table>` element, cell padding) and differ only
 * in the surrounding surface treatment so existing renders stay byte-identical.
 * - `modern`: elevated standalone table (the simple `Table`).
 * - `inset`: recessed table embedded in a workbench (the `DataTable`).
 */
export type TableSurface = "modern" | "inset";

const tableSurfaceClasses: Record<TableSurface, string> = {
  modern: "modern-surface overflow-x-auto rounded-tokenLg border border-muted shadow-tokenSm",
  inset: "inset-surface overflow-x-auto rounded-tokenMd border",
};

function resolveCellPad(density: TableDensity): string {
  return density === "compact" ? "px-3 py-2" : "px-4 py-3";
}

export interface TableShellProps extends FrameProps {
  /** Wrapper surface treatment. Defaults to `inset`. */
  surface?: TableSurface;
  /** Accessible table caption, rendered visually hidden. */
  caption?: ReactNode;
  children: ReactNode;
}

/**
 * Single source of table chrome: the scroll wrapper plus the `<table>` element
 * with its shared typography, border-collapse, and visually-hidden `<caption>`.
 * Compose `TableHead`, `TableRow`, and `TableCell` inside it instead of
 * hand-rolling raw `<table>`/`<tr>`/`<td>` markup.
 */
export const TableShell = forwardRef(function TableShell(
  { surface = "inset", caption, children, ...rest }: TableShellProps,
  ref: Ref<HTMLDivElement>,
) {
  return (
    <div {...rest} ref={ref} className={tableSurfaceClasses[surface]}>
      <table className="min-w-full border-collapse text-left text-sm">
        {caption ? <caption className="sr-only">{caption}</caption> : null}
        {children}
      </table>
    </div>
  );
}) as (props: TableShellProps & { ref?: Ref<HTMLDivElement> }) => ReactNode;

export interface TableRowProps extends Omit<HTMLAttributes<HTMLTableRowElement>, "className" | "style"> {
  /** Render the row as the header row (head background, no bottom-border reset). */
  head?: boolean;
  /** Selected styling for body rows. */
  selected?: boolean;
  /** Surface used to resolve head/hover/selected tones. Defaults to `inset`. */
  surface?: TableSurface;
  /** Body rows get hover/transition affordance. Set `false` for static skeleton rows. Defaults to `true`. */
  interactive?: boolean;
  children: ReactNode;
}

const headRowClasses: Record<TableSurface, string> = {
  modern: "border-b border-muted bg-background",
  inset: "border-b border-muted bg-surface-2",
};

const bodyHoverClasses: Record<TableSurface, string> = {
  modern: "hover:bg-background/60",
  inset: "hover:bg-surface-2/70",
};

const selectedRowClass = "bg-surface-2";

export function TableRow({
  head = false,
  selected = false,
  surface = "inset",
  interactive = true,
  children,
  ...rest
}: TableRowProps) {
  if (head) {
    return (
      <tr {...rest} className={headRowClasses[surface]}>
        {children}
      </tr>
    );
  }

  if (!interactive) {
    return (
      <tr {...rest} className="border-b border-muted last:border-b-0">
        {children}
      </tr>
    );
  }

  return (
    <tr
      {...rest}
      className={cx(
        "border-b border-muted transition-colors last:border-b-0",
        selected ? selectedRowClass : bodyHoverClasses[surface],
      )}
    >
      {children}
    </tr>
  );
}

export interface TableHeadCellProps extends Omit<ThHTMLAttributes<HTMLTableCellElement>, "className" | "style"> {
  align?: "left" | "right";
  /** Apply the fixed narrow width used by selection/control columns. */
  control?: boolean;
  /** Override the density-derived padding. */
  density?: TableDensity;
  children?: ReactNode;
}

export function TableHeadCell({
  align = "left",
  control = false,
  density,
  scope = "col",
  children,
  ...rest
}: TableHeadCellProps) {
  const themeDensity = useDensity();
  const resolvedDensity = density ?? themeDensity;
  return (
    <th
      {...rest}
      scope={scope}
      className={
        control
          ? cx("w-12", resolveCellPad(resolvedDensity))
          : cx(resolveCellPad(resolvedDensity), "font-semibold text-foreground", align === "right" && "text-right")
      }
    >
      {children}
    </th>
  );
}

export interface TableCellProps extends Omit<TdHTMLAttributes<HTMLTableCellElement>, "className" | "style"> {
  align?: "left" | "right";
  /** Apply the fixed narrow width used by selection/control columns. */
  control?: boolean;
  /** Override the density-derived padding. */
  density?: TableDensity;
  children?: ReactNode;
}

export function TableCell({ align = "left", control = false, density, children, ...rest }: TableCellProps) {
  const themeDensity = useDensity();
  const resolvedDensity = density ?? themeDensity;
  return (
    <td
      {...rest}
      className={
        control
          ? cx("w-12", resolveCellPad(resolvedDensity))
          : cx(resolveCellPad(resolvedDensity), "text-foreground", align === "right" && "text-right")
      }
    >
      {children}
    </td>
  );
}
