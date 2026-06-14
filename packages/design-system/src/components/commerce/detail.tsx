import type { ReactNode } from "react";
import { Icon, type IconName } from "../../icons";
import { cx } from "../../utils/cx";
import { Grid, Stack } from "../../primitives/layout";
import { Card } from "../data-display/card";
import { statusClasses, type StatusTone } from "./shared";

export interface MessageThreadPreviewProps {
  sellerName: string;
  title: ReactNode;
  responseTimeLabel?: ReactNode;
  responseTime?: ReactNode;
  messages: Array<{ author: string; body: ReactNode; meta?: ReactNode }>;
  action?: ReactNode;
}

export function MessageThreadPreview({
  title,
  responseTimeLabel,
  responseTime,
  messages,
  action,
}: MessageThreadPreviewProps) {
  return (
    <Card>
      <Card.Header>
        <Card.Title>
          <span className="flex items-center gap-2">
            <Icon name="message" size="md" tone="accent" aria-hidden="true" />
            {title}
          </span>
        </Card.Title>
        {responseTime ? (
          <Card.Description>
            {responseTimeLabel} {responseTime}
          </Card.Description>
        ) : null}
      </Card.Header>
      <Card.Body>
        <Stack gap={3}>
          {messages.map((message) => (
            <div
              key={`${message.author}-${String(message.body)}`}
              className="rounded-tokenMd border border-border bg-surface-2 p-3"
            >
              <div className="mb-1 flex items-center justify-between gap-2 text-xs font-semibold text-tertiary">
                <span>{message.author}</span>
                {message.meta ? <span>{message.meta}</span> : null}
              </div>
              <div className="text-sm leading-5 text-foreground">{message.body}</div>
            </div>
          ))}
          {action}
        </Stack>
      </Card.Body>
    </Card>
  );
}

export interface ProductMediaModuleProps {
  title: string;
  media?: Array<{ src?: string; alt: string; label?: ReactNode }>;
  badges?: ReactNode;
}

export function ProductMediaModule({ title, media = [], badges }: ProductMediaModuleProps) {
  const primary = media[0];
  const thumbnails = media.slice(1, 5);

  return (
    <Stack element="section" gap={3} aria-label={`${title} media`}>
      <div className="relative grid min-h-80 place-items-center overflow-hidden rounded-tokenLg border border-border bg-surface-2">
        {primary?.src ? (
          <img src={primary.src} alt={primary.alt} className="h-full max-h-[32rem] w-full object-contain p-4" />
        ) : (
          <div className="grid place-items-center gap-3 text-center text-tertiary">
            <Icon name="image" size="lg" tone="inherit" aria-hidden="true" />
            <span className="text-sm font-semibold">{primary?.alt ?? "Product media"}</span>
          </div>
        )}
        {badges ? <div className="absolute left-3 top-3 flex flex-wrap gap-2">{badges}</div> : null}
      </div>
      {thumbnails.length ? (
        <Grid columns={4} gap={2}>
          {thumbnails.map((item) => (
            <button
              key={item.alt}
              type="button"
              className="ds-focus aspect-square overflow-hidden rounded-tokenMd border border-border bg-surface-2"
              aria-label={`View ${item.alt}`}
            >
              {item.src ? (
                <img src={item.src} alt="" className="h-full w-full object-contain p-2" />
              ) : (
                <span className="grid h-full place-items-center text-xs font-semibold text-tertiary">
                  {item.label ?? "Media"}
                </span>
              )}
            </button>
          ))}
        </Grid>
      ) : null}
    </Stack>
  );
}

export interface DetailConfidenceModuleProps {
  title: ReactNode;
  description?: ReactNode;
  items: Array<{ label: string; value: ReactNode; icon?: IconName; tone?: StatusTone }>;
}

export function DetailConfidenceModule({ title, description, items }: DetailConfidenceModuleProps) {
  return (
    <Card>
      <Card.Header>
        <Card.Title>{title}</Card.Title>
        {description ? <Card.Description>{description}</Card.Description> : null}
      </Card.Header>
      <Card.Body>
        <Grid columns={{ base: 1, sm: 2 }} gap={3}>
          {items.map((item) => (
            <div key={item.label} className="flex gap-3 rounded-tokenMd border border-border bg-surface-2 p-3">
              <div className={cx("mt-0.5", item.tone ? statusClasses[item.tone].split(" ").at(-1) : "text-trust")}>
                <Icon name={item.icon ?? "check"} size="md" tone="inherit" />
              </div>
              <div>
                <div className="text-xs font-medium text-tertiary">{item.label}</div>
                <div className="text-sm font-semibold leading-5 text-foreground">{item.value}</div>
              </div>
            </div>
          ))}
        </Grid>
      </Card.Body>
    </Card>
  );
}

export interface SpecificationListProps {
  title?: ReactNode;
  specs: Array<{ label: string; value: ReactNode }>;
}

export function SpecificationList({ title, specs }: SpecificationListProps) {
  return (
    <Card>
      {title ? (
        <Card.Header>
          <Card.Title>{title}</Card.Title>
        </Card.Header>
      ) : null}
      <Card.Body>
        <dl className="grid gap-0">
          {specs.map((spec) => (
            <div
              key={spec.label}
              className="grid grid-cols-[minmax(8rem,0.8fr)_1fr] gap-3 border-b border-border py-2.5 first:pt-0 last:border-b-0 last:pb-0"
            >
              <dt className="text-sm text-tertiary">{spec.label}</dt>
              <dd className="m-0 text-sm font-semibold text-foreground">{spec.value}</dd>
            </div>
          ))}
        </dl>
      </Card.Body>
    </Card>
  );
}

export interface ComparisonModuleProps {
  title?: ReactNode;
  description?: ReactNode;
  signalLabel?: ReactNode;
  columns: string[];
  rows: Array<{ label: string; values: ReactNode[] }>;
}

export function ComparisonModule({ title, description, signalLabel, columns, rows }: ComparisonModuleProps) {
  return (
    <Card>
      {title || description ? (
        <Card.Header>
          {title ? <Card.Title>{title}</Card.Title> : null}
          {description ? <Card.Description>{description}</Card.Description> : null}
        </Card.Header>
      ) : null}
      <Card.Body>
        <div className="overflow-x-auto">
          <table className="min-w-[42rem] w-full border-collapse text-sm">
            <thead>
              <tr>
                <th className="border-b border-border px-3 py-2 text-left text-tertiary">{signalLabel}</th>
                {columns.map((column) => (
                  <th key={column} className="border-b border-border px-3 py-2 text-left font-semibold text-foreground">
                    {column}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.label}>
                  <th className="border-b border-border px-3 py-2 text-left font-medium text-secondary">{row.label}</th>
                  {row.values.map((value, index) => (
                    <td
                      key={`${row.label}-${columns[index]}`}
                      className="border-b border-border px-3 py-2 font-semibold text-foreground"
                    >
                      {value}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card.Body>
    </Card>
  );
}
