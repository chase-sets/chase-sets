import type { ReactNode } from "react";
import { Star } from "lucide-react";
import { cn } from "../../lib/utils";
import { IconButton } from "../actions";
import { Badge } from "./badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./card";
import { Progress } from "./progress";
import { Table, TableBody, TableCell, TableRow } from "./table";

export function Stat({
  label,
  value,
  trend,
  icon,
}: {
  label: ReactNode;
  value: ReactNode;
  trend?: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <div className="inset-surface rounded-[var(--radius)] border p-4">
      <div className="grid gap-2">
        <div className="flex items-center justify-between gap-2 text-sm text-[var(--muted-foreground)]">
          <span>{label}</span>
          {icon}
        </div>
        <div className="ds-display text-3xl text-[var(--foreground)]">{value}</div>
        {trend ? <div className="text-xs text-[var(--success)]">{trend}</div> : null}
      </div>
    </div>
  );
}

export function MetricStrip({ items }: { items: Array<{ label: string; value: string; trend?: string }> }) {
  return (
    <div className="grid gap-3 md:grid-cols-5">
      {items.map((item) => (
        <Stat key={item.label} label={item.label} value={item.value} trend={item.trend} />
      ))}
    </div>
  );
}

export function Rating({ value, max = 5 }: { value: number; max?: number }) {
  return (
    <span className="inline-flex items-center gap-0.5" aria-label={`${value} out of ${max}`}>
      {Array.from({ length: max }, (_, index) => (
        <Star
          key={index}
          className={cn(
            "h-4 w-4",
            index < value ? "fill-[var(--warning)] text-[var(--warning)]" : "text-[var(--muted)]",
          )}
          aria-hidden="true"
        />
      ))}
    </span>
  );
}

export function ProductCard({
  title,
  subtitle,
  price,
  status,
  meta,
  imageSrc,
  imageAlt,
  actions,
}: {
  title: string;
  subtitle?: string;
  price?: string;
  status?: ReactNode;
  meta?: string;
  imageSrc?: string;
  imageAlt?: string;
  actions?: ReactNode;
}) {
  return (
    <Card className="overflow-hidden p-0">
      <div className="grid aspect-[4/3] place-items-center bg-[linear-gradient(135deg,var(--secondary),color-mix(in_srgb,var(--accent)_18%,var(--card)))]">
        {imageSrc ? (
          <img src={imageSrc} alt={imageAlt ?? title} className="h-full w-full object-contain p-4" />
        ) : (
          <span className="ds-display text-5xl text-[var(--muted-foreground)]">{title.slice(0, 2).toUpperCase()}</span>
        )}
      </div>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle>{title}</CardTitle>
            {subtitle ? <CardDescription>{subtitle}</CardDescription> : null}
          </div>
          {status}
        </div>
      </CardHeader>
      <CardContent className="pb-5">
        <div className="flex items-end justify-between gap-3">
          <div>
            {price ? <div className="text-2xl font-bold text-[var(--primary)]">{price}</div> : null}
            {meta ? <div className="text-sm text-[var(--muted-foreground)]">{meta}</div> : null}
          </div>
          {actions ?? <IconButton label={`Save ${title}`} icon="heart" tone="ghost" />}
        </div>
      </CardContent>
    </Card>
  );
}

export function CategoryTile({ label, detail, icon }: { label: string; detail?: string; icon?: ReactNode }) {
  return (
    <Card className="p-4">
      <CardContent className="gap-2 p-0">
        <div className="text-[var(--primary)]">{icon}</div>
        <div className="font-semibold">{label}</div>
        {detail ? <div className="text-sm text-[var(--muted-foreground)]">{detail}</div> : null}
      </CardContent>
    </Card>
  );
}

export function FeatureCard({ icon, title, description }: { icon?: ReactNode; title: string; description: string }) {
  return (
    <Card>
      <CardContent className="gap-3 p-0">
        {icon ? <div className="text-[var(--primary)]">{icon}</div> : null}
        <div>
          <h3 className="m-0 text-lg font-semibold">{title}</h3>
          <p className="m-0 mt-1 text-sm leading-6 text-[var(--muted-foreground)]">{description}</p>
        </div>
      </CardContent>
    </Card>
  );
}

export function OrderSummary({
  title = "Order Summary",
  lines,
  total,
}: {
  title?: string;
  lines: Array<{ label: string; value: ReactNode }>;
  total: ReactNode;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <Table>
          <TableBody>
            {lines.map((line) => (
              <TableRow key={line.label}>
                <TableCell data-label="Line" className="font-medium">
                  {line.label}
                </TableCell>
                <TableCell data-label="Amount" className="font-semibold md:text-right">
                  {line.value}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        <div className="inset-surface flex items-center justify-between rounded-[var(--radius)] border p-4">
          <span className="font-semibold">Total</span>
          <span className="text-2xl font-bold text-[var(--primary)]">{total}</span>
        </div>
      </CardContent>
    </Card>
  );
}

export function ProgressCard({ value, label }: { value: number; label: string }) {
  return (
    <Card className="p-4">
      <CardContent className="gap-3 p-0">
        <div className="flex justify-between text-sm font-medium">
          <span>{label}</span>
          <span>{value}%</span>
        </div>
        <Progress value={value} />
      </CardContent>
    </Card>
  );
}
