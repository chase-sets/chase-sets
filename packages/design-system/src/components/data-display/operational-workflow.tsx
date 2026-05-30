import type { HTMLAttributes, ReactNode } from "react";
import { Icon } from "../../icons";
import { cx } from "../../utils/cx";
import { CopyButton } from "../actions/copy-button";
import { Progress } from "../ui/progress";

export interface WorkstationLayoutProps extends Omit<HTMLAttributes<HTMLDivElement>, "className" | "style"> {
  primary: ReactNode;
  secondary: ReactNode;
  secondaryTitle: ReactNode;
  secondaryDescription?: ReactNode;
}

export function WorkstationLayout({
  primary,
  secondary,
  secondaryTitle,
  secondaryDescription,
  ...rest
}: WorkstationLayoutProps) {
  return (
    <div {...rest} className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(18rem,22rem)] lg:items-start">
      <div className="min-w-0">{primary}</div>
      <aside className="hidden lg:block">{secondary}</aside>
      <details className="group rounded-tokenMd border border-muted bg-background p-3 lg:hidden">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 text-sm font-semibold text-foreground">
          <span>{secondaryTitle}</span>
          <Icon name="chevronDown" size="sm" tone="secondary" />
        </summary>
        {secondaryDescription ? <div className="mt-1 text-xs text-secondary">{secondaryDescription}</div> : null}
        <div className="mt-3">{secondary}</div>
      </details>
    </div>
  );
}

export interface OperationalStatusBannerProps extends Omit<
  HTMLAttributes<HTMLDivElement>,
  "className" | "style" | "title"
> {
  title: ReactNode;
  description?: ReactNode;
  tone?: "info" | "success" | "warning" | "danger";
  action?: ReactNode;
}

export function OperationalStatusBanner({
  title,
  description,
  tone = "info",
  action,
  ...rest
}: OperationalStatusBannerProps) {
  return (
    <div
      {...rest}
      className={cx(
        "rounded-tokenMd border p-4 shadow-tokenSm",
        tone === "info" && "border-info bg-elevated",
        tone === "success" && "border-success bg-elevated",
        tone === "warning" && "border-warning bg-elevated",
        tone === "danger" && "border-danger bg-elevated",
      )}
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 gap-3">
          <span
            className={cx(
              "mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full",
              tone === "info" && "bg-info text-inverse",
              tone === "success" && "bg-success text-inverse",
              tone === "warning" && "bg-warning text-inverse",
              tone === "danger" && "bg-danger text-inverse",
            )}
          >
            <Icon
              name={tone === "danger" || tone === "warning" ? "warning" : tone === "success" ? "check" : "info"}
              size="sm"
              tone="inverse"
            />
          </span>
          <div className="grid gap-1">
            <div className="text-sm font-semibold text-foreground">{title}</div>
            {description ? <div className="text-sm leading-6 text-secondary">{description}</div> : null}
          </div>
        </div>
        {action ? <div className="shrink-0">{action}</div> : null}
      </div>
    </div>
  );
}

export interface TaskSummaryItem {
  label: ReactNode;
  value: ReactNode;
}

export interface TaskSummaryProps extends Omit<HTMLAttributes<HTMLDivElement>, "className" | "style" | "title"> {
  title: ReactNode;
  items: readonly TaskSummaryItem[];
}

export function TaskSummary({ title, items, ...rest }: TaskSummaryProps) {
  return (
    <section {...rest} className="rounded-tokenMd border border-muted bg-background p-4">
      <h2 className="m-0 text-sm font-semibold text-foreground">{title}</h2>
      <dl className="mt-3 grid gap-3">
        {items.map((item, index) => (
          <div key={index} className="grid gap-1 border-t border-muted pt-3 first:border-t-0 first:pt-0">
            <dt className="text-xs font-medium uppercase text-tertiary">{item.label}</dt>
            <dd className="m-0 min-w-0 text-sm text-foreground">{item.value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

export interface AddressBlockProps extends Omit<HTMLAttributes<HTMLElement>, "className" | "style" | "title"> {
  title: ReactNode;
  lines: readonly ReactNode[];
  copyValue?: string;
  copyLabel?: string;
}

export function AddressBlock({ title, lines, copyValue, copyLabel = "Copy", ...rest }: AddressBlockProps) {
  const visibleLines = lines.filter(Boolean);

  return (
    <section {...rest} className="rounded-tokenMd border border-muted bg-background p-4">
      <div className="flex items-start justify-between gap-3">
        <h2 className="m-0 text-sm font-semibold text-foreground">{title}</h2>
        {copyValue ? <CopyButton value={copyValue} label={copyLabel} size="sm" tone="secondary" /> : null}
      </div>
      <address className="mt-3 not-italic text-sm leading-6 text-foreground">
        {visibleLines.map((line, index) => (
          <div key={index}>{line}</div>
        ))}
      </address>
    </section>
  );
}

export interface ChecklistCardProps extends Omit<HTMLAttributes<HTMLElement>, "className" | "style" | "title"> {
  title: ReactNode;
  description?: ReactNode;
  progress?: ReactNode;
  children: ReactNode;
}

export function ChecklistCard({ title, description, progress, children, ...rest }: ChecklistCardProps) {
  return (
    <section {...rest} className="rounded-tokenMd border border-muted bg-background p-4">
      <div className="grid gap-3">
        <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
          <div className="grid gap-1">
            <h2 className="m-0 text-xl font-semibold text-foreground">{title}</h2>
            {description ? <p className="m-0 text-sm leading-6 text-secondary">{description}</p> : null}
          </div>
          {progress ? <div className="md:min-w-48">{progress}</div> : null}
        </div>
        <div className="grid gap-2">{children}</div>
      </div>
    </section>
  );
}

export interface TaskProgressProps extends Omit<HTMLAttributes<HTMLDivElement>, "className" | "style"> {
  label: ReactNode;
  value: number;
  tone?: "neutral" | "active" | "success" | "blocked";
}

export function TaskProgress({ label, value, tone = "active", ...rest }: TaskProgressProps) {
  return (
    <div {...rest} className="grid gap-2">
      <div className="text-xs font-medium text-secondary">{label}</div>
      <Progress value={value} tone={tone} />
    </div>
  );
}

export interface TaskLineItemProps extends Omit<HTMLAttributes<HTMLLabelElement>, "className" | "style" | "title"> {
  title: ReactNode;
  subtitle?: ReactNode;
  description?: ReactNode;
  quantity: ReactNode;
  quantityLabel?: ReactNode;
  checked: boolean;
  disabled?: boolean;
  meta?: ReactNode;
  reference?: ReactNode;
  media?: ReactNode;
  checkboxLabel: string;
  onCheckedChange?: (checked: boolean) => void;
}

export function TaskLineItem({
  title,
  subtitle,
  description,
  quantity,
  quantityLabel = "Qty",
  checked,
  disabled = false,
  meta,
  reference,
  media,
  checkboxLabel,
  onCheckedChange,
  ...rest
}: TaskLineItemProps) {
  return (
    <label
      {...rest}
      className={cx(
        "grid cursor-pointer gap-3 rounded-tokenMd border border-muted bg-elevated p-3 transition-colors md:grid-cols-[auto_minmax(0,1fr)_auto]",
        checked && "border-success",
        disabled && "cursor-not-allowed opacity-70",
      )}
    >
      <input
        type="checkbox"
        className="peer sr-only"
        checked={checked}
        disabled={disabled}
        readOnly={!onCheckedChange}
        aria-label={checkboxLabel}
        onChange={(event) => onCheckedChange?.(event.currentTarget.checked)}
      />
      <span
        aria-hidden="true"
        className={cx(
          "inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-border bg-background peer-focus-visible:shadow-[0_0_0_2px_var(--ring),0_0_0_5px_color-mix(in_srgb,var(--ring)_18%,transparent)]",
          checked && "border-success bg-success text-inverse",
        )}
      >
        {checked ? <Icon name="check" size="sm" tone="inverse" /> : <Icon name="package" size="sm" tone="secondary" />}
      </span>
      <div className="grid min-w-0 gap-2 md:grid-cols-[auto_minmax(0,1fr)] md:items-start">
        <div className="flex h-16 w-12 items-center justify-center overflow-hidden rounded-tokenSm border border-muted bg-background text-secondary">
          {media ?? <Icon name="package" size="md" tone="secondary" />}
        </div>
        <div className="grid min-w-0 gap-1">
          <div className="text-base font-semibold text-foreground">{title}</div>
          {subtitle ? <div className="text-sm text-secondary">{subtitle}</div> : null}
          {description ? <div className="text-sm leading-6 text-secondary">{description}</div> : null}
          {meta ? <div className="flex flex-wrap gap-2 pt-1">{meta}</div> : null}
          {reference ? <div className="pt-1 text-xs text-tertiary">{reference}</div> : null}
        </div>
      </div>
      <div className="flex items-center gap-2 md:flex-col md:items-end md:justify-center">
        <div className="text-xs font-medium uppercase text-tertiary">{quantityLabel}</div>
        <div className="text-2xl font-bold leading-none text-foreground">{quantity}</div>
      </div>
    </label>
  );
}

export interface StickyTaskFooterProps extends Omit<HTMLAttributes<HTMLDivElement>, "className" | "style"> {
  summary: ReactNode;
  detail?: ReactNode;
  children: ReactNode;
}

export function StickyTaskFooter({ summary, detail, children, ...rest }: StickyTaskFooterProps) {
  return (
    <div
      {...rest}
      className="sticky bottom-[calc(7rem+env(safe-area-inset-bottom))] z-20 mb-[calc(7rem+env(safe-area-inset-bottom))] rounded-tokenLg border border-border bg-elevated p-3 shadow-tokenLg md:bottom-4 md:mb-0"
    >
      <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_auto] md:items-center">
        <div className="grid gap-1">
          <div className="text-sm font-semibold text-foreground">{summary}</div>
          {detail ? <div className="text-xs leading-5 text-secondary">{detail}</div> : null}
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end">{children}</div>
      </div>
    </div>
  );
}
