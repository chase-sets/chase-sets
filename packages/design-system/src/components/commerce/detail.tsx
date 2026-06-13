import type { ReactNode } from "react";
import { CheckCircle2, ImageIcon, MessageSquare } from "lucide-react";
import { cn } from "../../lib/utils";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../compat/card";
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
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <MessageSquare className="h-5 w-5 text-[var(--primary)]" aria-hidden="true" />
          {title}
        </CardTitle>
        {responseTime ? (
          <CardDescription>
            {responseTimeLabel} {responseTime}
          </CardDescription>
        ) : null}
      </CardHeader>
      <CardContent>
        <div className="grid gap-3">
          {messages.map((message) => (
            <div
              key={`${message.author}-${String(message.body)}`}
              className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface-2)] p-3"
            >
              <div className="mb-1 flex items-center justify-between gap-2 text-xs font-semibold text-[var(--muted-foreground)]">
                <span>{message.author}</span>
                {message.meta ? <span>{message.meta}</span> : null}
              </div>
              <div className="text-sm leading-5 text-[var(--foreground)]">{message.body}</div>
            </div>
          ))}
          {action}
        </div>
      </CardContent>
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
    <section className="grid gap-3" aria-label={`${title} media`}>
      <div className="relative grid min-h-80 place-items-center overflow-hidden rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface-2)]">
        {primary?.src ? (
          <img src={primary.src} alt={primary.alt} className="h-full max-h-[32rem] w-full object-contain p-4" />
        ) : (
          <div className="grid place-items-center gap-3 text-center text-[var(--muted-foreground)]">
            <ImageIcon className="h-10 w-10" aria-hidden="true" />
            <span className="text-sm font-semibold">{primary?.alt ?? "Product media"}</span>
          </div>
        )}
        {badges ? <div className="absolute left-3 top-3 flex flex-wrap gap-2">{badges}</div> : null}
      </div>
      {thumbnails.length ? (
        <div className="grid grid-cols-4 gap-2">
          {thumbnails.map((item) => (
            <button
              key={item.alt}
              type="button"
              className="ds-focus aspect-square overflow-hidden rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface-2)]"
              aria-label={`View ${item.alt}`}
            >
              {item.src ? (
                <img src={item.src} alt="" className="h-full w-full object-contain p-2" />
              ) : (
                <span className="grid h-full place-items-center text-xs font-semibold text-[var(--muted-foreground)]">
                  {item.label ?? "Media"}
                </span>
              )}
            </button>
          ))}
        </div>
      ) : null}
    </section>
  );
}

export interface DetailConfidenceModuleProps {
  title: ReactNode;
  description?: ReactNode;
  items: Array<{ label: string; value: ReactNode; icon?: ReactNode; tone?: StatusTone }>;
}

export function DetailConfidenceModule({ title, description, items }: DetailConfidenceModuleProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        {description ? <CardDescription>{description}</CardDescription> : null}
      </CardHeader>
      <CardContent>
        <div className="grid gap-3 sm:grid-cols-2">
          {items.map((item) => (
            <div
              key={item.label}
              className="flex gap-3 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface-2)] p-3"
            >
              <div className={cn("mt-0.5", item.tone ? statusClasses[item.tone].split(" ").at(-1) : "text-trust")}>
                {item.icon ?? <CheckCircle2 className="h-5 w-5" aria-hidden="true" />}
              </div>
              <div>
                <div className="text-xs font-medium text-[var(--muted-foreground)]">{item.label}</div>
                <div className="text-sm font-semibold leading-5 text-[var(--foreground)]">{item.value}</div>
              </div>
            </div>
          ))}
        </div>
      </CardContent>
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
        <CardHeader>
          <CardTitle>{title}</CardTitle>
        </CardHeader>
      ) : null}
      <CardContent>
        <dl className="grid gap-0">
          {specs.map((spec) => (
            <div
              key={spec.label}
              className="grid grid-cols-[minmax(8rem,0.8fr)_1fr] gap-3 border-b border-[var(--border)] py-2.5 first:pt-0 last:border-b-0 last:pb-0"
            >
              <dt className="text-sm text-[var(--muted-foreground)]">{spec.label}</dt>
              <dd className="m-0 text-sm font-semibold text-[var(--foreground)]">{spec.value}</dd>
            </div>
          ))}
        </dl>
      </CardContent>
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
        <CardHeader>
          {title ? <CardTitle>{title}</CardTitle> : null}
          {description ? <CardDescription>{description}</CardDescription> : null}
        </CardHeader>
      ) : null}
      <CardContent>
        <div className="overflow-x-auto">
          <table className="min-w-[42rem] w-full border-collapse text-sm">
            <thead>
              <tr>
                <th className="border-b border-[var(--border)] px-3 py-2 text-left text-[var(--muted-foreground)]">
                  {signalLabel}
                </th>
                {columns.map((column) => (
                  <th
                    key={column}
                    className="border-b border-[var(--border)] px-3 py-2 text-left font-semibold text-[var(--foreground)]"
                  >
                    {column}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.label}>
                  <th className="border-b border-[var(--border)] px-3 py-2 text-left font-medium text-[var(--text-secondary)]">
                    {row.label}
                  </th>
                  {row.values.map((value, index) => (
                    <td
                      key={`${row.label}-${columns[index]}`}
                      className="border-b border-[var(--border)] px-3 py-2 font-semibold text-[var(--foreground)]"
                    >
                      {value}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}
