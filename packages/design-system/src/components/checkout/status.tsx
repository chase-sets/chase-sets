import type { HTMLAttributes, ReactNode } from "react";
import { Icon } from "../../icons";
import type { IconName } from "../../icons";
import { cx } from "../../utils/cx";
import { Grid, IconRow, Stack, Surface } from "../../primitives/layout";
import { CheckoutStatusBadge } from "./shared";
import type { CheckoutPrimitiveTone, CheckoutSummaryLine } from "./shared";

export interface CheckoutStateNoticeProps extends Omit<
  HTMLAttributes<HTMLDivElement>,
  "className" | "style" | "title"
> {
  tone?: CheckoutPrimitiveTone;
  title: ReactNode;
  description?: ReactNode;
  icon?: IconName;
  action?: ReactNode;
}

const defaultNoticeIcons: Record<CheckoutPrimitiveTone, IconName> = {
  neutral: "info",
  info: "info",
  success: "check",
  warning: "warning",
  danger: "warning",
};

export function CheckoutStateNotice({
  tone = "info",
  title,
  description,
  icon = defaultNoticeIcons[tone],
  action,
  ...rest
}: CheckoutStateNoticeProps) {
  return (
    <Surface {...rest} tone={tone}>
      <IconRow
        gap={3}
        nudge={false}
        icon={
          <Icon
            name={icon}
            size="sm"
            tone={
              tone === "danger" ? "danger" : tone === "warning" ? "warning" : tone === "success" ? "success" : "accent"
            }
          />
        }
      >
        <div className="text-sm font-semibold text-foreground">{title}</div>
        {description ? <div className="mt-1 text-sm leading-5 text-secondary">{description}</div> : null}
        {action ? <div className="mt-3">{action}</div> : null}
      </IconRow>
    </Surface>
  );
}

export interface CheckoutReadinessPromptProps extends CheckoutStateNoticeProps {
  facts?: CheckoutSummaryLine[];
  secondaryAction?: ReactNode;
}

export function CheckoutReadinessPrompt({
  facts = [],
  action,
  secondaryAction,
  children,
  ...rest
}: CheckoutReadinessPromptProps) {
  return (
    <CheckoutStateNotice
      {...rest}
      action={
        action || secondaryAction || facts.length || children ? (
          <Stack gap={3}>
            {facts.length ? (
              <dl className="grid gap-2 text-sm">
                {facts.map((fact, index) => (
                  <div key={index} className="flex items-start justify-between gap-4">
                    <dt className="text-secondary">{fact.label}</dt>
                    <dd className="text-right font-semibold tabular-nums text-foreground">{fact.value}</dd>
                  </div>
                ))}
              </dl>
            ) : null}
            {children}
            {action || secondaryAction ? (
              <div className="flex flex-wrap gap-2" data-primary-action-count={action ? "1" : undefined}>
                {action}
                {secondaryAction}
              </div>
            ) : null}
          </Stack>
        ) : null
      }
    />
  );
}

export interface CheckoutConfirmationPanelProps extends Omit<
  HTMLAttributes<HTMLElement>,
  "className" | "style" | "title"
> {
  title: ReactNode;
  description?: ReactNode;
  referenceLabel?: ReactNode;
  referenceValue?: ReactNode;
  supportReferenceLabel?: ReactNode;
  supportReferenceValue?: ReactNode;
  totalLabel?: ReactNode;
  total?: ReactNode;
  nextSteps?: Array<{ title: ReactNode; description: ReactNode; icon?: IconName }>;
  actions?: ReactNode;
  tone?: CheckoutPrimitiveTone;
}

export function CheckoutConfirmationPanel({
  title,
  description,
  referenceLabel,
  referenceValue,
  supportReferenceLabel,
  supportReferenceValue,
  totalLabel,
  total,
  nextSteps = [],
  actions,
  tone = "success",
  ...rest
}: CheckoutConfirmationPanelProps) {
  return (
    <Surface {...rest} element="section" tone={tone} padding={5}>
      <Stack gap={3}>
        <CheckoutStatusBadge tone={tone}>{title}</CheckoutStatusBadge>
        {description ? <p className="m-0 text-sm leading-5 text-secondary">{description}</p> : null}
        {referenceLabel || supportReferenceLabel || totalLabel ? (
          <dl className="grid gap-2 rounded-tokenMd border border-muted bg-background p-3 text-sm">
            {referenceLabel ? (
              <div className="flex justify-between gap-4">
                <dt className="text-secondary">{referenceLabel}</dt>
                <dd className="min-w-0 break-words text-right font-semibold text-foreground">{referenceValue}</dd>
              </div>
            ) : null}
            {supportReferenceLabel ? (
              <div className="flex justify-between gap-4">
                <dt className="text-secondary">{supportReferenceLabel}</dt>
                <dd className="min-w-0 break-words text-right font-semibold text-foreground">
                  {supportReferenceValue}
                </dd>
              </div>
            ) : null}
            {totalLabel ? (
              <div className="flex justify-between gap-4">
                <dt className="text-secondary">{totalLabel}</dt>
                <dd className="min-w-0 break-words text-right font-bold tabular-nums text-foreground">{total}</dd>
              </div>
            ) : null}
          </dl>
        ) : null}
        {nextSteps.length ? (
          <Grid columns={{ base: 1, sm: 3 }} gap={3}>
            {nextSteps.map((step, index) => (
              <div key={index} className="min-w-0">
                <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
                  {step.icon ? <Icon name={step.icon} size="sm" tone="accent" /> : null}
                  {step.title}
                </div>
                <div className="mt-1 text-sm leading-5 text-secondary">{step.description}</div>
              </div>
            ))}
          </Grid>
        ) : null}
        {actions ? (
          <div className="flex flex-wrap gap-2" data-primary-action-count="1">
            {actions}
          </div>
        ) : null}
      </Stack>
    </Surface>
  );
}

export interface CheckoutStickyActionBarProps extends Omit<HTMLAttributes<HTMLDivElement>, "className" | "style"> {
  totalLabel: ReactNode;
  total: ReactNode;
  context?: ReactNode;
  /** Canonical reassurance slot — pass a `SecurePaymentIndicator`. */
  reassurance?: ReactNode;
  primaryAction: ReactNode;
  secondaryAction?: ReactNode;
  mobileOffset?: "navigation" | "none";
  /** Accessible label for the bar region. Defaults to `"Checkout actions"`. */
  label?: string;
}

export function CheckoutStickyActionBar({
  totalLabel,
  total,
  context,
  reassurance,
  primaryAction,
  secondaryAction,
  mobileOffset = "navigation",
  label = "Checkout actions",
  ...rest
}: CheckoutStickyActionBarProps) {
  return (
    <div
      {...rest}
      role="region"
      aria-label={label}
      className={cx(
        "sticky z-sticky rounded-tokenLg border border-muted bg-background/overlay px-3 py-2 shadow-tokenLg backdrop-blur-xl md:hidden",
        mobileOffset === "navigation"
          ? "bottom-[calc(var(--shell-bottom-nav-height,0px)+var(--space-3)+env(safe-area-inset-bottom))]"
          : "bottom-0",
      )}
    >
      <Stack gap={3}>
        <div className="flex items-end justify-between gap-4">
          <div className="min-w-0">
            <div className="text-xs font-medium text-secondary">{totalLabel}</div>
            {context ? <div className="text-xs leading-5 text-secondary">{context}</div> : null}
            {reassurance ? <div className="mt-1">{reassurance}</div> : null}
          </div>
          <div className="text-right text-xl font-bold tabular-nums text-foreground">{total}</div>
        </div>
        <Grid columns={secondaryAction ? 2 : 1} gap={2} data-primary-action-count="1">
          {secondaryAction}
          {primaryAction}
        </Grid>
      </Stack>
    </div>
  );
}
