import type { ReactNode } from "react";
import { Icon, type IconName } from "../../icons";
import { Center, Cluster, Grid, Inline, Inset, Stack } from "../../primitives/layout";
import { ToneIcon, type ToneIconTone } from "../../primitives/tone-icon";
import { Badge } from "../feedback";
import { Card } from "../data-display/card";

export interface MarketplaceEmptyStateProps {
  title: ReactNode;
  description: ReactNode;
  recoveryActions?: ReactNode;
  recommendationActions?: ReactNode;
  trustCue?: ReactNode;
}

export function MarketplaceEmptyState({
  title,
  description,
  recoveryActions,
  recommendationActions,
  trustCue,
}: MarketplaceEmptyStateProps) {
  return (
    <section className="grid gap-4 rounded-tokenLg border border-dashed border-[var(--border-strong)] bg-surface p-6 text-center">
      <Center axis="horizontal">
        <Icon name="inbox" size="lg" tone="tertiary" aria-hidden="true" />
      </Center>
      <Stack gap={2}>
        <h2 className="m-0 text-xl font-bold text-foreground">{title}</h2>
        <p className="m-0 mx-auto max-w-xl text-sm leading-6 text-secondary">{description}</p>
      </Stack>
      {trustCue ? <div className="mx-auto w-full max-w-2xl text-left">{trustCue}</div> : null}
      {recommendationActions ? (
        <Cluster justify="center" gap={2}>
          {recommendationActions}
        </Cluster>
      ) : null}
      {recoveryActions ? (
        <Cluster justify="center" gap={2}>
          {recoveryActions}
        </Cluster>
      ) : null}
    </section>
  );
}

export interface MarketplaceStatusTimelineProps {
  steps: Array<{ label: string; description?: ReactNode; status: "complete" | "current" | "upcoming" | "issue" }>;
}

export function MarketplaceStatusTimeline({ steps }: MarketplaceStatusTimelineProps) {
  const iconByStatus: Record<MarketplaceStatusTimelineProps["steps"][number]["status"], IconName> = {
    complete: "checkCircle",
    current: "clock",
    upcoming: "package",
    issue: "warning",
  };

  return (
    <ol className="grid gap-3">
      {steps.map((step) => {
        const iconName = iconByStatus[step.status];
        const tone: ToneIconTone =
          step.status === "issue"
            ? "warning"
            : step.status === "complete"
              ? "success"
              : step.status === "current"
                ? "info"
                : "neutral";

        return (
          <li key={step.label} className="flex gap-3 rounded-tokenMd border border-border bg-surface p-3">
            <ToneIcon name={iconName} tone={tone} size="sm" />
            <div>
              <div className="font-semibold text-foreground">{step.label}</div>
              {step.description ? <div className="text-sm leading-5 text-secondary">{step.description}</div> : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

export interface OfferCardProps {
  title: ReactNode;
  amount: ReactNode;
  status?: ReactNode;
  accountTrust?: ReactNode;
  details?: ReactNode;
  actions?: ReactNode;
}

export function OfferCard({ title, amount, status, accountTrust, details, actions }: OfferCardProps) {
  return (
    <Card>
      <Card.Header>
        <Stack direction="row" justify="between" align="start" gap={3}>
          <div>
            <Card.Title>{title}</Card.Title>
            {status ? <Card.Description>{status}</Card.Description> : null}
            {accountTrust ? <div className="mt-2">{accountTrust}</div> : null}
          </div>
          <div className="text-right text-2xl font-bold tabular-nums text-foreground">{amount}</div>
        </Stack>
      </Card.Header>
      <Card.Body>
        {details ? <div className="text-sm leading-6 text-secondary">{details}</div> : null}
        {actions ? <Inline gap={2}>{actions}</Inline> : null}
      </Card.Body>
    </Card>
  );
}

export interface MarketplaceDashboardPanelProps {
  title: ReactNode;
  description?: ReactNode;
  metrics: Array<{ label: string; value: ReactNode; detail?: ReactNode }>;
  action?: ReactNode;
}

export function MarketplaceDashboardPanel({ title, description, metrics, action }: MarketplaceDashboardPanelProps) {
  return (
    <Card>
      <Card.Header>
        <Stack direction="row" justify="between" align="start" gap={3}>
          <div>
            <Card.Title>{title}</Card.Title>
            {description ? <Card.Description>{description}</Card.Description> : null}
          </div>
          {action}
        </Stack>
      </Card.Header>
      <Card.Body>
        <Grid columns={{ base: 1, sm: 3 }} gap={3}>
          {metrics.map((metric) => (
            <Inset key={metric.label} padding={3}>
              <div className="text-2xl font-bold tabular-nums text-foreground">{metric.value}</div>
              <div className="text-sm font-medium text-secondary">{metric.label}</div>
              {metric.detail ? <div className="mt-1 text-xs text-tertiary">{metric.detail}</div> : null}
            </Inset>
          ))}
        </Grid>
      </Card.Body>
    </Card>
  );
}

export interface MarketplaceTemplateGalleryProps {
  templates: Array<{ name: string; purpose: ReactNode; criticalSignals: string[]; primaryAction: string }>;
}

export function MarketplaceTemplateGallery({ templates }: MarketplaceTemplateGalleryProps) {
  return (
    <Grid columns={{ base: 1, md: 2, xl: 3 }} gap={3}>
      {templates.map((template) => (
        <article key={template.name} className="grid gap-3 rounded-tokenMd border border-border bg-surface p-4">
          <Stack direction="row" justify="between" align="start" gap={3}>
            <div>
              <h3 className="m-0 text-base font-semibold text-foreground">{template.name}</h3>
              <p className="m-0 mt-1 text-sm leading-5 text-secondary">{template.purpose}</p>
            </div>
            <Icon name="chevronRight" size="sm" tone="tertiary" aria-hidden="true" />
          </Stack>
          <Inline gap={2}>
            {template.criticalSignals.map((signal) => (
              <Badge key={signal} tone="neutral" variant="soft">
                {signal}
              </Badge>
            ))}
          </Inline>
          <div className="text-xs font-semibold uppercase text-tertiary">Primary action: {template.primaryAction}</div>
        </article>
      ))}
    </Grid>
  );
}
