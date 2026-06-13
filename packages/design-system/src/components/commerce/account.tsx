import type { ReactNode } from "react";
import { ShieldCheck } from "lucide-react";
import { Inset } from "../../primitives/layout";
import { Badge } from "../compat/badge";
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
    <section className="ds-panel grid gap-4 rounded-[var(--radius-lg)] border border-[var(--border)] p-4 md:grid-cols-[1fr_auto] md:items-end">
      <div className="grid gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="m-0 text-2xl font-bold leading-8 text-[var(--foreground)]">{name}</h2>
          {verified ? <TrustBadge>Verified account</TrustBadge> : <Badge variant="outline">Building trust</Badge>}
        </div>
        {tagline ? <p className="m-0 max-w-2xl text-sm leading-6 text-[var(--text-secondary)]">{tagline}</p> : null}
        {stats.length ? (
          <div className="grid gap-2 sm:grid-cols-4">
            {stats.map((stat) => (
              <Inset key={stat.label} padding={3}>
                <div className="text-lg font-bold tabular-nums text-[var(--foreground)]">{stat.value}</div>
                <div className="text-xs text-[var(--muted-foreground)]">{stat.label}</div>
              </Inset>
            ))}
          </div>
        ) : null}
      </div>
      {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
    </section>
  );
}

export interface AccountCredibilityHeaderProps {
  name: ReactNode;
  verification: ReactNode;
  summary?: ReactNode;
  facts: Array<{ label: ReactNode; value: ReactNode }>;
  policies?: Array<{ label: ReactNode; value: ReactNode }>;
  contactAction?: ReactNode;
  reportAction?: ReactNode;
}

export function AccountCredibilityHeader({
  name,
  verification,
  summary,
  facts,
  policies = [],
  contactAction,
  reportAction,
}: AccountCredibilityHeaderProps) {
  return (
    <section className="ds-panel grid gap-4 rounded-[var(--radius-lg)] border border-[var(--border)] p-4">
      <div className="grid gap-3 md:grid-cols-[1fr_auto] md:items-start">
        <div className="grid gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="m-0 text-2xl font-bold leading-8 text-[var(--foreground)]">{name}</h2>
            <TrustBadge>{verification}</TrustBadge>
          </div>
          {summary ? <p className="m-0 max-w-3xl text-sm leading-6 text-[var(--text-secondary)]">{summary}</p> : null}
        </div>
        {contactAction || reportAction ? (
          <div className="flex flex-wrap gap-2">
            {contactAction}
            {reportAction}
          </div>
        ) : null}
      </div>
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        {facts.map((fact) => (
          <Inset key={String(fact.label)} padding={3}>
            <div className="text-sm font-semibold text-[var(--foreground)]">{fact.value}</div>
            <div className="text-xs text-[var(--muted-foreground)]">{fact.label}</div>
          </Inset>
        ))}
      </div>
      {policies.length ? (
        <div className="grid gap-2 border-t border-[var(--border)] pt-4 sm:grid-cols-2">
          {policies.map((policy) => (
            <div key={String(policy.label)} className="flex gap-2 text-sm">
              <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-[var(--trust)]" aria-hidden="true" />
              <div>
                <div className="font-semibold text-[var(--foreground)]">{policy.label}</div>
                <div className="text-[var(--text-secondary)]">{policy.value}</div>
              </div>
            </div>
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
    <article className="grid gap-3 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--card)] p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="font-semibold text-[var(--foreground)]">{author}</div>
          {meta ? <div className="text-xs text-[var(--muted-foreground)]">{meta}</div> : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <RatingSummary value={rating} compact />
          {verified ? <Badge variant="trust">Verified purchase</Badge> : null}
        </div>
      </div>
      <p className="m-0 text-sm leading-6 text-[var(--text-secondary)]">{body}</p>
      {sellerResponse ? (
        <div className="rounded-[var(--radius)] bg-[var(--surface-2)] p-3 text-sm leading-5 text-[var(--text-secondary)]">
          <span className="font-semibold text-[var(--foreground)]">Seller response: </span>
          {sellerResponse}
        </div>
      ) : null}
    </article>
  );
}
