import { useId, type FormEvent, type HTMLAttributes, type ReactNode } from "react";
import { Icon } from "../../icons";
import { cx } from "../../utils/cx";
import { Button, IconButton } from "../actions/button";
import { CopyButton } from "../actions/copy-button";
import { controlHeightClasses, controlPaddingClasses, controlTextClasses } from "../control-sizing";
import { Progress } from "../feedback/loading";
import { Form, type FormProps } from "../forms/form";

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
              "mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-tokenFull",
              tone === "info" && "bg-info text-info-contrast",
              tone === "success" && "bg-success text-success-contrast",
              tone === "warning" && "bg-warning text-warning-contrast",
              tone === "danger" && "bg-danger text-danger-contrast",
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

export interface OperationalLockBannerProps extends Omit<
  HTMLAttributes<HTMLDivElement>,
  "className" | "style" | "title"
> {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
}

export function OperationalLockBanner({ title, description, action, ...rest }: OperationalLockBannerProps) {
  return (
    <div {...rest} className="rounded-tokenMd border border-warning bg-elevated p-4 shadow-tokenSm">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 gap-3">
          <span className="mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-tokenFull bg-warning text-warning-contrast">
            <Icon name="lock" size="sm" tone="inverse" />
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

export interface WorkflowModuleProps extends Omit<HTMLAttributes<HTMLElement>, "className" | "style" | "title"> {
  title: ReactNode;
  description?: ReactNode;
  status?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  headingLevel?: 2 | 3 | 4;
  density?: "regular" | "compact";
}

export function WorkflowModule({
  title,
  description,
  status,
  actions,
  children,
  headingLevel = 3,
  density = "regular",
  ...rest
}: WorkflowModuleProps) {
  const titleId = useId();
  const Heading = headingLevel === 2 ? "h2" : headingLevel === 4 ? "h4" : "h3";

  return (
    <section
      {...rest}
      aria-labelledby={titleId}
      className={cx(
        "rounded-tokenMd border border-muted bg-background shadow-tokenSm",
        density === "compact" ? "p-3" : "p-4",
      )}
    >
      <div className="grid gap-3">
        <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
          <div className="grid min-w-0 gap-1">
            <div className="flex flex-wrap items-center gap-2">
              <Heading id={titleId} className="m-0 text-base font-semibold text-foreground">
                {title}
              </Heading>
              {status ? <div className="shrink-0">{status}</div> : null}
            </div>
            {description ? <p className="m-0 text-sm leading-6 text-secondary">{description}</p> : null}
          </div>
          {actions ? <WorkflowActionBar align="end">{actions}</WorkflowActionBar> : null}
        </div>
        <div className="grid gap-3">{children}</div>
      </div>
    </section>
  );
}

export interface WorkflowActionBarProps extends Omit<HTMLAttributes<HTMLDivElement>, "className" | "style"> {
  children: ReactNode;
  align?: "start" | "end";
}

export function WorkflowActionBar({ children, align = "start", ...rest }: WorkflowActionBarProps) {
  return (
    <div
      {...rest}
      className={cx(
        "flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-end",
        align === "end" ? "sm:justify-end" : "sm:justify-start",
      )}
    >
      {children}
    </div>
  );
}

export type WorkflowReadinessStatus = "passed" | "blocked" | "warning" | "pending";

export interface WorkflowReadinessItem {
  key: string;
  label: ReactNode;
  status: WorkflowReadinessStatus;
  statusLabel: ReactNode;
  description?: ReactNode;
  meta?: ReactNode;
  action?: ReactNode;
}

export interface WorkflowReadinessChecklistProps extends Omit<HTMLAttributes<HTMLUListElement>, "className" | "style"> {
  items: readonly WorkflowReadinessItem[];
  emptyState?: ReactNode;
}

export function WorkflowReadinessChecklist({ items, emptyState, ...rest }: WorkflowReadinessChecklistProps) {
  if (items.length === 0) {
    return emptyState ? <div className="text-sm text-secondary">{emptyState}</div> : null;
  }

  return (
    <ul {...rest} className="m-0 grid list-none gap-2 p-0">
      {items.map((item) => (
        <li
          key={item.key}
          className={cx(
            "grid gap-2 rounded-tokenMd border bg-elevated p-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start",
            item.status === "passed" && "border-success",
            item.status === "blocked" && "border-danger",
            item.status === "warning" && "border-warning",
            item.status === "pending" && "border-muted",
          )}
        >
          <div className="flex min-w-0 gap-2">
            <span className="mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-tokenFull bg-background">
              <Icon name={workflowReadinessIcon(item.status)} size="sm" tone={workflowReadinessIconTone(item.status)} />
            </span>
            <div className="grid min-w-0 gap-1">
              <div className="text-sm font-semibold text-foreground">{item.label}</div>
              {item.description ? <div className="text-sm leading-6 text-secondary">{item.description}</div> : null}
              {item.meta ? <div className="flex flex-wrap gap-2 pt-1 text-xs text-tertiary">{item.meta}</div> : null}
            </div>
          </div>
          <div className="flex flex-col gap-2 sm:items-end">
            <span className={cx("text-xs font-semibold uppercase", workflowReadinessTextClass(item.status))}>
              {item.statusLabel}
            </span>
            {item.action ? <div>{item.action}</div> : null}
          </div>
        </li>
      ))}
    </ul>
  );
}

function workflowReadinessIcon(status: WorkflowReadinessStatus) {
  if (status === "passed") {
    return "check";
  }
  if (status === "blocked") {
    return "warning";
  }
  if (status === "warning") {
    return "info";
  }
  return "clock";
}

function workflowReadinessIconTone(status: WorkflowReadinessStatus) {
  if (status === "passed") {
    return "success";
  }
  if (status === "blocked") {
    return "danger";
  }
  if (status === "warning") {
    return "warning";
  }
  return "secondary";
}

function workflowReadinessTextClass(status: WorkflowReadinessStatus) {
  if (status === "passed") {
    return "text-success";
  }
  if (status === "blocked") {
    return "text-danger";
  }
  if (status === "warning") {
    return "text-warning";
  }
  return "text-tertiary";
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
  valueLabel?: ReactNode;
  description?: ReactNode;
  tone?: "neutral" | "active" | "success" | "blocked";
}

export function TaskProgress({ label, value, valueLabel, description, tone = "active", ...rest }: TaskProgressProps) {
  return (
    <div {...rest} className="grid gap-2">
      <div className="flex items-center justify-between gap-3 text-xs font-medium text-secondary">
        <span>{label}</span>
        {valueLabel ? <span className="tabular-nums text-foreground">{valueLabel}</span> : null}
      </div>
      <Progress value={value} tone={tone} />
      {description ? <div className="text-xs leading-5 text-tertiary">{description}</div> : null}
    </div>
  );
}

export interface TaskReferenceProps extends Omit<HTMLAttributes<HTMLDivElement>, "className" | "style"> {
  label: ReactNode;
  value: string;
  displayValue?: ReactNode;
  copyLabel?: string;
  copiedLabel?: string;
}

export function TaskReference({
  label,
  value,
  displayValue,
  copyLabel = "Copy",
  copiedLabel = "Copied",
  ...rest
}: TaskReferenceProps) {
  return (
    <div {...rest} className="inline-flex min-w-0 items-center gap-1.5 rounded-tokenSm bg-background px-2 py-1">
      <span className="text-2xs font-medium uppercase text-tertiary">{label}</span>
      <span className="min-w-0 font-mono text-xs text-secondary">{displayValue ?? value}</span>
      <CopyButton value={value} label={copyLabel} copiedLabel={copiedLabel} size="sm" tone="ghost" />
    </div>
  );
}

export interface QuantityChecklistControlProps extends Omit<
  HTMLAttributes<HTMLDivElement>,
  "className" | "style" | "onChange"
> {
  value: number;
  total: number;
  valueLabel?: ReactNode;
  decreaseLabel: string;
  increaseLabel: string;
  disabled?: boolean;
  onChange?: (value: number) => void;
}

export function QuantityChecklistControl({
  value,
  total,
  valueLabel,
  decreaseLabel,
  increaseLabel,
  disabled = false,
  onChange,
  ...rest
}: QuantityChecklistControlProps) {
  const resolvedValue = Math.max(0, Math.min(total, value));
  const isComplete = total > 0 && resolvedValue >= total;

  return (
    <div {...rest} className="grid gap-2 justify-items-end">
      <div
        className={cx(
          "inline-flex items-center gap-2 rounded-tokenMd border border-muted bg-background p-1",
          controlHeightClasses.md,
          isComplete && "border-success",
        )}
      >
        <IconButton
          label={decreaseLabel}
          icon="minus"
          tone="secondary"
          size="sm"
          disabled={disabled || resolvedValue <= 0}
          onClick={() => onChange?.(resolvedValue - 1)}
        />
        <span className="min-w-14 text-center text-sm font-semibold tabular-nums text-foreground">
          {resolvedValue}/{total}
        </span>
        <IconButton
          label={increaseLabel}
          icon="plus"
          tone="secondary"
          size="sm"
          disabled={disabled || resolvedValue >= total}
          onClick={() => onChange?.(resolvedValue + 1)}
        />
      </div>
      {valueLabel ? <div className="text-xs text-tertiary">{valueLabel}</div> : null}
    </div>
  );
}

export interface TaskScanInputProps extends Omit<FormProps, "children" | "className" | "onSubmit" | "style"> {
  label: ReactNode;
  value: string;
  onValueChange: (value: string) => void;
  onSubmit: (value: string) => void;
  placeholder?: string;
  buttonLabel: ReactNode;
  description?: ReactNode;
  feedback?: ReactNode;
  feedbackTone?: "info" | "success" | "warning" | "danger";
  disabled?: boolean;
}

export function TaskScanInput({
  label,
  value,
  onValueChange,
  onSubmit,
  placeholder,
  buttonLabel,
  description,
  feedback,
  feedbackTone = "info",
  disabled = false,
  ...rest
}: TaskScanInputProps) {
  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onSubmit(value);
  }

  return (
    <Form
      {...rest}
      disabled={disabled}
      spacing="none"
      className="rounded-tokenMd border border-muted bg-elevated p-3"
      onSubmit={handleSubmit}
    >
      <div className="grid gap-2 md:grid-cols-[minmax(0,1fr)_auto] md:items-end">
        <label className="grid min-w-0 gap-1 text-sm font-medium text-foreground">
          <span>{label}</span>
          {description ? <span className="text-xs font-normal leading-5 text-secondary">{description}</span> : null}
          <span className="relative">
            <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center">
              <Icon name="search" size="sm" tone="secondary" />
            </span>
            <input
              type="search"
              value={value}
              disabled={disabled}
              placeholder={placeholder}
              onChange={(event) => onValueChange(event.currentTarget.value)}
              className={cx(
                "w-full rounded-tokenMd border border-border bg-background pl-10 text-foreground outline-none transition-shadow placeholder:text-tertiary focus-visible:shadow-[0_0_0_2px_var(--ring),0_0_0_5px_color-mix(in_srgb,var(--ring)_18%,transparent)] disabled:cursor-not-allowed disabled:opacity-60",
                controlHeightClasses.md,
                controlPaddingClasses.md,
                controlTextClasses.md,
              )}
            />
          </span>
        </label>
        <Button type="submit" tone="secondary" leadingIcon="check" disabled={disabled || value.trim().length === 0}>
          {buttonLabel}
        </Button>
      </div>
      {feedback ? (
        <div
          className={cx(
            "mt-2 text-xs leading-5",
            feedbackTone === "info" && "text-secondary",
            feedbackTone === "success" && "text-success",
            feedbackTone === "warning" && "text-warning",
            feedbackTone === "danger" && "text-danger",
          )}
        >
          {feedback}
        </div>
      ) : null}
    </Form>
  );
}

export interface TaskLineItemProps extends Omit<HTMLAttributes<HTMLDivElement>, "className" | "style" | "title"> {
  title: ReactNode;
  subtitle?: ReactNode;
  description?: ReactNode;
  quantity: ReactNode;
  quantityLabel?: ReactNode;
  quantityDetail?: ReactNode;
  quantityControl?: ReactNode;
  checked: boolean;
  disabled?: boolean;
  meta?: ReactNode;
  reference?: ReactNode;
  media?: ReactNode;
  status?: "idle" | "saving" | "saved" | "error" | "matched";
  statusLabel?: ReactNode;
  checkboxLabel: string;
  onCheckedChange?: (checked: boolean) => void;
}

export function TaskLineItem({
  title,
  subtitle,
  description,
  quantity,
  quantityLabel = "Qty",
  quantityDetail,
  quantityControl,
  checked,
  disabled = false,
  meta,
  reference,
  media,
  status = "idle",
  statusLabel,
  checkboxLabel,
  onCheckedChange,
  ...rest
}: TaskLineItemProps) {
  return (
    <div
      {...rest}
      className={cx(
        "grid cursor-pointer gap-3 rounded-tokenMd border border-muted bg-elevated p-3 transition-colors md:grid-cols-[auto_minmax(0,1fr)_auto]",
        checked && "border-success",
        status === "saving" && "border-info",
        status === "error" && "border-danger",
        status === "matched" && "border-accent",
        disabled && "cursor-not-allowed opacity-70",
      )}
    >
      <button
        type="button"
        className={cx(
          "inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-tokenFull border border-border bg-background transition-shadow focus-visible:shadow-[0_0_0_2px_var(--ring),0_0_0_5px_color-mix(in_srgb,var(--ring)_18%,transparent)]",
          checked && "border-success bg-success text-success-contrast",
          !onCheckedChange && "pointer-events-none",
        )}
        aria-pressed={checked}
        disabled={disabled}
        aria-label={checkboxLabel}
        onClick={() => onCheckedChange?.(!checked)}
      >
        {checked ? <Icon name="check" size="sm" tone="inverse" /> : <Icon name="package" size="sm" tone="secondary" />}
      </button>
      <div className="grid min-w-0 gap-2 md:grid-cols-[auto_minmax(0,1fr)] md:items-start">
        <div className="flex h-16 w-12 items-center justify-center overflow-hidden rounded-tokenSm border border-muted bg-background text-secondary">
          {media ?? <Icon name="package" size="md" tone="secondary" />}
        </div>
        <div className="grid min-w-0 gap-1">
          <div className="text-base font-semibold text-foreground">{title}</div>
          {subtitle ? <div className="text-sm text-secondary">{subtitle}</div> : null}
          {description ? <div className="text-sm leading-6 text-secondary">{description}</div> : null}
          {meta ? <div className="flex flex-wrap gap-2 pt-1">{meta}</div> : null}
          {reference ? <div className="flex flex-wrap gap-2 pt-1 text-xs text-tertiary">{reference}</div> : null}
          {statusLabel ? (
            <div
              className={cx(
                "pt-1 text-xs font-medium",
                status === "saving" && "text-info",
                status === "saved" && "text-success",
                status === "error" && "text-danger",
                status === "matched" && "text-accent",
                status === "idle" && "text-tertiary",
              )}
            >
              {statusLabel}
            </div>
          ) : null}
        </div>
      </div>
      <div className="flex items-center justify-between gap-3 md:flex-col md:items-end md:justify-center">
        {quantityControl ? (
          quantityControl
        ) : (
          <>
            <div className="text-xs font-medium uppercase text-tertiary">{quantityLabel}</div>
            <div className="text-2xl font-bold leading-none text-foreground">{quantity}</div>
          </>
        )}
        {quantityDetail ? <div className="text-xs leading-5 text-tertiary">{quantityDetail}</div> : null}
      </div>
    </div>
  );
}

export interface StickyTaskFooterProps extends Omit<HTMLAttributes<HTMLDivElement>, "className" | "style"> {
  summary: ReactNode;
  detail?: ReactNode;
  mobileOffset?: "app-shell" | "none" | "in-flow";
  children: ReactNode;
}

export function StickyTaskFooter({
  summary,
  detail,
  mobileOffset = "app-shell",
  children,
  ...rest
}: StickyTaskFooterProps) {
  return (
    <div
      {...rest}
      className={cx(
        "z-20 rounded-tokenLg border border-border bg-elevated p-3 shadow-tokenLg md:sticky md:bottom-4 md:mb-0",
        mobileOffset === "app-shell" &&
          "sticky bottom-[calc(4.75rem+env(safe-area-inset-bottom))] mb-[calc(4.75rem+env(safe-area-inset-bottom))]",
        mobileOffset === "none" && "sticky bottom-4 mb-0",
        mobileOffset === "in-flow" && "relative mb-0",
      )}
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
