import type { HTMLAttributes, ReactNode } from "react";
import { Icon } from "../../icons";
import type { IconName } from "../../icons";
import { Grid, Stack } from "../../primitives/layout";
import { CheckoutStatusBadge } from "./shared";
import type { CheckoutPrimitiveTone } from "./shared";

export interface CheckoutSavedInfoRowProps extends Omit<HTMLAttributes<HTMLDivElement>, "className" | "style"> {
  label: ReactNode;
  value: ReactNode;
  supportingText?: ReactNode;
  icon?: IconName;
  action?: ReactNode;
  status?: ReactNode;
  statusTone?: CheckoutPrimitiveTone;
}

export function CheckoutSavedInfoRow({
  label,
  value,
  supportingText,
  icon,
  action,
  status,
  statusTone = "neutral",
  ...rest
}: CheckoutSavedInfoRowProps) {
  return (
    <div
      {...rest}
      className="grid gap-3 border-b border-muted px-4 py-3 last:border-b-0 sm:grid-cols-[9rem_minmax(0,1fr)_auto] sm:items-center"
    >
      <div className="flex min-w-0 items-center gap-2 text-sm text-secondary">
        {icon ? <Icon name={icon} size="sm" tone="secondary" /> : null}
        <span>{label}</span>
      </div>
      <div className="min-w-0">
        <div className="text-sm font-semibold leading-5 text-foreground">{value}</div>
        {supportingText ? <div className="text-xs leading-5 text-secondary">{supportingText}</div> : null}
      </div>
      <div className="flex min-w-0 items-center gap-2">
        {status ? <CheckoutStatusBadge tone={statusTone}>{status}</CheckoutStatusBadge> : null}
        {action}
      </div>
    </div>
  );
}

export interface CheckoutSavedInfoGroupProps extends Omit<
  HTMLAttributes<HTMLElement>,
  "className" | "style" | "title"
> {
  title?: ReactNode;
  children: ReactNode;
}

export function CheckoutSavedInfoGroup({ title, children, ...rest }: CheckoutSavedInfoGroupProps) {
  return (
    <section {...rest} className="overflow-hidden rounded-tokenLg border border-muted bg-surface shadow-tokenSm">
      {title ? (
        <h2 className="m-0 border-b border-muted px-4 py-3 text-base font-semibold text-foreground">{title}</h2>
      ) : null}
      {children}
    </section>
  );
}

export interface CheckoutFormSectionProps extends Omit<HTMLAttributes<HTMLElement>, "className" | "style" | "title"> {
  title: ReactNode;
  description?: ReactNode;
  badge?: ReactNode;
  children: ReactNode;
}

export function CheckoutFormSection({ title, description, badge, children, ...rest }: CheckoutFormSectionProps) {
  return (
    <Stack {...rest} element="section" gap={3}>
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="m-0 text-xl font-semibold leading-7 text-foreground">{title}</h2>
          {description ? <p className="m-0 mt-1 text-sm leading-5 text-secondary">{description}</p> : null}
        </div>
        {badge}
      </div>
      <Stack gap={3}>{children}</Stack>
    </Stack>
  );
}

export interface CheckoutExpressActionsProps extends Omit<HTMLAttributes<HTMLDivElement>, "className" | "style"> {
  label: ReactNode;
  actions: ReactNode;
  dividerLabel?: ReactNode;
}

export function CheckoutExpressActions({ label, actions, dividerLabel = "OR", ...rest }: CheckoutExpressActionsProps) {
  return (
    <div {...rest} className="grid gap-3 text-center">
      <div className="text-sm text-secondary">{label}</div>
      <Grid columns={{ base: 1, sm: 2 }} gap={2}>
        {actions}
      </Grid>
      <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-3 text-xs text-secondary">
        <span className="h-px bg-muted" aria-hidden="true" />
        <span>{dividerLabel}</span>
        <span className="h-px bg-muted" aria-hidden="true" />
      </div>
    </div>
  );
}
