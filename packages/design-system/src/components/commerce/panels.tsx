import type { ReactNode } from "react";
import { AlertTriangle, CheckCircle2, ChevronRight, Clock, Inbox, Package } from "lucide-react";
import { cn } from "../../lib/utils";
import { Inset } from "../../primitives/layout";
import { Badge } from "../compat/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../compat/card";
import { statusClasses } from "./shared";

export interface MarketplaceEmptyStateProps {
  title: ReactNode;
  description: ReactNode;
  recoveryActions?: ReactNode;
  recommendations?: string[];
  trustCue?: ReactNode;
}

export function MarketplaceEmptyState({
  title,
  description,
  recoveryActions,
  recommendations = [],
  trustCue,
}: MarketplaceEmptyStateProps) {
  return (
    <section className="grid gap-4 rounded-[var(--radius-lg)] border border-dashed border-[var(--border-strong)] bg-[var(--card)] p-6 text-center">
      <Inbox className="mx-auto h-10 w-10 text-[var(--muted-foreground)]" aria-hidden="true" />
      <div className="grid gap-2">
        <h2 className="m-0 text-xl font-bold text-[var(--foreground)]">{title}</h2>
        <p className="m-0 mx-auto max-w-xl text-sm leading-6 text-[var(--text-secondary)]">{description}</p>
      </div>
      {trustCue ? <div className="mx-auto w-full max-w-2xl text-left">{trustCue}</div> : null}
      {recommendations.length ? (
        <div className="flex flex-wrap justify-center gap-2">
          {recommendations.map((recommendation) => (
            <Badge key={recommendation} variant="secondary">
              {recommendation}
            </Badge>
          ))}
        </div>
      ) : null}
      {recoveryActions ? <div className="flex flex-wrap justify-center gap-2">{recoveryActions}</div> : null}
    </section>
  );
}

export interface MarketplaceStatusTimelineProps {
  steps: Array<{ label: string; description?: ReactNode; status: "complete" | "current" | "upcoming" | "issue" }>;
}

export function MarketplaceStatusTimeline({ steps }: MarketplaceStatusTimelineProps) {
  const iconByStatus = {
    complete: CheckCircle2,
    current: Clock,
    upcoming: Package,
    issue: AlertTriangle,
  };

  return (
    <ol className="grid gap-3">
      {steps.map((step) => {
        const Icon = iconByStatus[step.status];
        const tone =
          step.status === "issue"
            ? "warning"
            : step.status === "complete"
              ? "success"
              : step.status === "current"
                ? "info"
                : "neutral";

        return (
          <li
            key={step.label}
            className="flex gap-3 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--card)] p-3"
          >
            <span className={cn("grid h-8 w-8 shrink-0 place-items-center rounded-full border", statusClasses[tone])}>
              <Icon className="h-4 w-4" aria-hidden="true" />
            </span>
            <div>
              <div className="font-semibold text-[var(--foreground)]">{step.label}</div>
              {step.description ? (
                <div className="text-sm leading-5 text-[var(--text-secondary)]">{step.description}</div>
              ) : null}
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
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle>{title}</CardTitle>
            {status ? <CardDescription>{status}</CardDescription> : null}
            {accountTrust ? <div className="mt-2">{accountTrust}</div> : null}
          </div>
          <div className="text-right text-2xl font-bold tabular-nums text-[var(--foreground)]">{amount}</div>
        </div>
      </CardHeader>
      <CardContent>
        {details ? <div className="text-sm leading-6 text-[var(--text-secondary)]">{details}</div> : null}
        {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
      </CardContent>
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
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle>{title}</CardTitle>
            {description ? <CardDescription>{description}</CardDescription> : null}
          </div>
          {action}
        </div>
      </CardHeader>
      <CardContent>
        <div className="grid gap-3 sm:grid-cols-3">
          {metrics.map((metric) => (
            <Inset key={metric.label} padding={3}>
              <div className="text-2xl font-bold tabular-nums text-[var(--foreground)]">{metric.value}</div>
              <div className="text-sm font-medium text-[var(--text-secondary)]">{metric.label}</div>
              {metric.detail ? (
                <div className="mt-1 text-xs text-[var(--muted-foreground)]">{metric.detail}</div>
              ) : null}
            </Inset>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

export interface MarketplaceTemplateGalleryProps {
  templates: Array<{ name: string; purpose: ReactNode; criticalSignals: string[]; primaryAction: string }>;
}

export function MarketplaceTemplateGallery({ templates }: MarketplaceTemplateGalleryProps) {
  return (
    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
      {templates.map((template) => (
        <article
          key={template.name}
          className="grid gap-3 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--card)] p-4"
        >
          <div className="flex items-start justify-between gap-3">
            <div>
              <h3 className="m-0 text-base font-semibold text-[var(--foreground)]">{template.name}</h3>
              <p className="m-0 mt-1 text-sm leading-5 text-[var(--text-secondary)]">{template.purpose}</p>
            </div>
            <ChevronRight className="h-4 w-4 text-[var(--muted-foreground)]" aria-hidden="true" />
          </div>
          <div className="flex flex-wrap gap-2">
            {template.criticalSignals.map((signal) => (
              <Badge key={signal} variant="secondary">
                {signal}
              </Badge>
            ))}
          </div>
          <div className="text-xs font-semibold uppercase text-[var(--muted-foreground)]">
            Primary action: {template.primaryAction}
          </div>
        </article>
      ))}
    </div>
  );
}
