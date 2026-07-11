import type { ReactNode } from "react";
import { Icon } from "../../icons";
import { Cluster, Grid, IconRow, Inline, Inset, Stack } from "../../primitives/layout";
import { Badge } from "../feedback";
import { RatingSummary, TrustBadge } from "./trust";

export interface AccountProfileHeaderProps {
  name: string;
  verified?: boolean;
  tagline?: ReactNode;
  stats?: Array<{ label: string; value: ReactNode }>;
  actions?: ReactNode;
}

export function AccountProfileHeader({
  name,
  verified = false,
  tagline,
  stats = [],
  actions,
}: AccountProfileHeaderProps) {
  return (
    <section className="ds-panel grid gap-4 rounded-tokenLg border border-border p-4 md:grid-cols-[1fr_auto] md:items-end">
      <Stack gap={3}>
        <Inline gap={2}>
          <h2 className="m-0 text-2xl font-bold leading-8 text-foreground">{name}</h2>
          {verified ? (
            <TrustBadge>Verified account</TrustBadge>
          ) : (
            <Badge variant="outline" tone="neutral">
              Building trust
            </Badge>
          )}
        </Inline>
        {tagline ? <p className="m-0 max-w-2xl text-sm leading-6 text-secondary">{tagline}</p> : null}
        {stats.length ? (
          <Grid columns={{ base: 1, sm: 4 }} gap={2}>
            {stats.map((stat) => (
              <Inset key={stat.label} padding={3}>
                <div className="text-lg font-bold tabular-nums text-foreground">{stat.value}</div>
                <div className="text-xs text-tertiary">{stat.label}</div>
              </Inset>
            ))}
          </Grid>
        ) : null}
      </Stack>
      {actions ? <Inline gap={2}>{actions}</Inline> : null}
    </section>
  );
}

export interface AccountCredibilityHeaderProps {
  name: ReactNode;
  verification: ReactNode;
  summary?: ReactNode;
  /** Account badges (m87 badge facts), rendered beside the verification badge -- e.g. a trusted-seller badge list. */
  badges?: ReactNode;
  facts: Array<{ label: ReactNode; value: ReactNode }>;
  policies?: Array<{ label: ReactNode; value: ReactNode }>;
  contactAction?: ReactNode;
  reportAction?: ReactNode;
}

export function AccountCredibilityHeader({
  name,
  verification,
  summary,
  badges,
  facts,
  policies = [],
  contactAction,
  reportAction,
}: AccountCredibilityHeaderProps) {
  return (
    <section className="ds-panel grid gap-4 rounded-tokenLg border border-border p-4">
      <Grid templateColumns="1fr auto" stackUntil="md" gap={3} align={{ base: "stretch", md: "start" }}>
        <Stack gap={2}>
          <Inline gap={2}>
            <h2 className="m-0 text-2xl font-bold leading-8 text-foreground">{name}</h2>
            <TrustBadge>{verification}</TrustBadge>
            {badges}
          </Inline>
          {summary ? <p className="m-0 max-w-3xl text-sm leading-6 text-secondary">{summary}</p> : null}
        </Stack>
        {contactAction || reportAction ? (
          <Inline gap={2}>
            {contactAction}
            {reportAction}
          </Inline>
        ) : null}
      </Grid>
      <Grid columns={{ base: 1, sm: 2, lg: 4 }} gap={2}>
        {facts.map((fact) => (
          <Inset key={String(fact.label)} padding={3}>
            <div className="text-sm font-semibold text-foreground">{fact.value}</div>
            <div className="text-xs text-tertiary">{fact.label}</div>
          </Inset>
        ))}
      </Grid>
      {policies.length ? (
        <div className="grid gap-2 border-t border-border pt-4 sm:grid-cols-2">
          {policies.map((policy) => (
            <IconRow
              key={String(policy.label)}
              gap={2}
              icon={<Icon name="shield" size="sm" tone="trust" aria-hidden="true" />}
            >
              <div className="text-sm font-semibold text-foreground">{policy.label}</div>
              <div className="text-sm text-secondary">{policy.value}</div>
            </IconRow>
          ))}
        </div>
      ) : null}
    </section>
  );
}

export interface ReviewCardProps {
  author: string;
  rating: number;
  body: ReactNode;
  meta?: ReactNode;
  verified?: boolean;
  sellerResponse?: ReactNode;
}

export function ReviewCard({ author, rating, body, meta, verified = false, sellerResponse }: ReviewCardProps) {
  return (
    <article className="grid gap-3 rounded-tokenMd border border-border bg-surface p-4">
      <Cluster gap={2}>
        <div>
          <div className="font-semibold text-foreground">{author}</div>
          {meta ? <div className="text-xs text-tertiary">{meta}</div> : null}
        </div>
        <Inline gap={2}>
          <RatingSummary value={rating} compact />
          {verified ? (
            <Badge tone="trust" variant="soft">
              Verified purchase
            </Badge>
          ) : null}
        </Inline>
      </Cluster>
      <p className="m-0 text-sm leading-6 text-secondary">{body}</p>
      {sellerResponse ? (
        <div className="rounded-tokenMd bg-surface-2 p-3 text-sm leading-5 text-secondary">
          <span className="font-semibold text-foreground">Seller response: </span>
          {sellerResponse}
        </div>
      ) : null}
    </article>
  );
}
