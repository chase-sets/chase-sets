import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from "react";
import { Icon } from "../../icons";
import type { IconName } from "../../icons";
import { cx } from "../../utils/cx";

// Action-hierarchy helpers. These make "one primary action per surface"
// enforceable rather than conventional: the single `primary` slot stamps
// `data-primary-action-count="1"` (the contract the marketplace tests assert),
// and arranges the primary, secondary, and low-emphasis controls in the correct
// reading order — primary leads on a row, leads at the bottom of a stack — with
// canonical spacing. A surface that needs two primaries cannot express it
// through these helpers; it must pass exactly one node to `primary`.

export interface ActionRowProps extends Omit<HTMLAttributes<HTMLDivElement>, "className" | "style"> {
  /** The single primary action for the surface. Renders last (right) so it reads as the commit. */
  primary?: ReactNode;
  /** Standard secondary actions (navigation, edit). */
  secondary?: ReactNode;
  /** Low-emphasis actions (ghost Remove, undo). Rendered first/quietest. */
  lowEmphasis?: ReactNode;
  /** Horizontal alignment of the cluster. Defaults to `end`. */
  align?: "start" | "end" | "between";
}

const actionAlignClasses: Record<NonNullable<ActionRowProps["align"]>, string> = {
  start: "justify-start",
  end: "justify-end",
  between: "justify-between",
};

export function ActionRow({ primary, secondary, lowEmphasis, align = "end", ...rest }: ActionRowProps) {
  return (
    <div
      {...rest}
      className={cx("flex flex-wrap items-center gap-2", actionAlignClasses[align])}
      data-primary-action-count={primary ? "1" : "0"}
    >
      {lowEmphasis}
      {secondary}
      {primary}
    </div>
  );
}

export interface ActionStackProps extends Omit<HTMLAttributes<HTMLDivElement>, "className" | "style"> {
  /** The single primary action for the surface. Renders first (top) so it leads the stack. */
  primary?: ReactNode;
  /** Standard secondary actions (navigation, edit). */
  secondary?: ReactNode;
  /** Low-emphasis actions (ghost Remove, undo). Rendered last/quietest. */
  lowEmphasis?: ReactNode;
}

export function ActionStack({ primary, secondary, lowEmphasis, ...rest }: ActionStackProps) {
  return (
    <div {...rest} className="grid gap-2" data-primary-action-count={primary ? "1" : "0"}>
      {primary}
      {secondary}
      {lowEmphasis}
    </div>
  );
}

// A documented low-emphasis, non-blocking destructive recipe. Routine edits such
// as Remove must NOT use `tone="danger"` — red is reserved for blocking
// confirmations. This forwards to the consumer-supplied control props but pins
// the canonical ghost recipe (quiet, compact, with a trailing trash icon) so
// consumers stop reaching for danger tone on every Remove.
export interface DestructiveActionProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className" | "style"> {
  children: ReactNode;
  /** Icon for the action. Defaults to `trash`. */
  icon?: IconName;
  /** Hide the icon entirely. */
  hideIcon?: boolean;
}

export function DestructiveAction({ children, icon = "trash", hideIcon = false, ...rest }: DestructiveActionProps) {
  return (
    <button
      {...rest}
      type={rest.type ?? "button"}
      className="focus-ring inline-flex min-w-0 max-w-full items-center justify-center gap-1.5 rounded-tokenMd border border-transparent bg-transparent px-3 py-1.5 text-sm font-semibold leading-snug text-secondary transition hover:border-border hover:bg-surface-2 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-disabled"
    >
      {hideIcon ? null : <Icon name={icon} size="sm" tone="secondary" />}
      <span className="min-w-0">{children}</span>
    </button>
  );
}
