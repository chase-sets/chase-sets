import type { ReactNode } from "react";
import { DetailPanel, KeyValueList, Stat, StatGrid } from "../../components/data-display";
import { Icon, type IconName } from "../../icons";
import type { OrderSummaryLine } from "./commerce-atoms";

export interface CheckoutTrustPanelProps {
  title?: ReactNode;
  items: Array<{
    icon: IconName;
    title: ReactNode;
    description?: ReactNode;
  }>;
}

export function CheckoutTrustPanel({ title = "Order Protection", items }: CheckoutTrustPanelProps) {
  return (
    <DetailPanel
      title={
        <span className="inline-flex items-center gap-3">
          <Icon name="shield" size="lg" tone="accent" />
          {title}
        </span>
      }
    >
      <div className="space-y-4">
        {items.map((item, index) => (
          <div key={index} className="flex gap-3">
            <Icon name={item.icon} size="sm" tone="accent" />
            <div>
              <div className="text-sm font-semibold text-foreground">{item.title}</div>
              {item.description ? <div className="text-sm text-secondary">{item.description}</div> : null}
            </div>
          </div>
        ))}
      </div>
    </DetailPanel>
  );
}

export interface OrderSummaryProps {
  title?: ReactNode;
  lines: OrderSummaryLine[];
  total: ReactNode;
  totalLabel?: ReactNode;
}

export function OrderSummary({ title = "Order summary", lines, total, totalLabel = "Total" }: OrderSummaryProps) {
  return (
    <DetailPanel title={title}>
      <KeyValueList
        items={lines.map((line) => ({
          key: line.label,
          value: line.value,
        }))}
      />
      <div className="flex items-center justify-between border-t border-muted pt-4">
        <span className="text-sm font-semibold text-foreground">{totalLabel}</span>
        <span className="font-heading text-2xl font-semibold text-foreground">{total}</span>
      </div>
    </DetailPanel>
  );
}

export interface MetricStripItem {
  label: ReactNode;
  value: ReactNode;
  trend?: ReactNode;
}

export interface MetricStripProps {
  items: MetricStripItem[];
}

export function MetricStrip({ items }: MetricStripProps) {
  return (
    <StatGrid columns={{ base: 1, sm: 2, xl: 4 }}>
      {items.map((item, index) => (
        <Stat key={index} label={item.label} value={item.value} trend={item.trend} />
      ))}
    </StatGrid>
  );
}
