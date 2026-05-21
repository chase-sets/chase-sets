import type { HTMLAttributes, ReactNode } from "react";

export interface TimelineItem {
  title: ReactNode;
  description?: ReactNode;
  timestamp?: ReactNode;
}

export interface TimelineProps extends Omit<HTMLAttributes<HTMLOListElement>, "className" | "style"> {
  items: TimelineItem[];
}

export function Timeline({ items, ...rest }: TimelineProps) {
  return (
    <ol {...rest} className="modern-surface space-y-4 rounded-tokenLg border border-muted p-4 shadow-tokenSm">
      {items.map((item, index) => (
        <li key={index} className="flex gap-3">
          <span className="mt-1 inline-flex h-3 w-3 shrink-0 rounded-full bg-accent" />
          <div className="space-y-1">
            <div className="text-sm font-semibold text-foreground">{item.title}</div>
            {item.description ? <div className="text-sm text-secondary">{item.description}</div> : null}
            {item.timestamp ? <div className="text-xs text-secondary">{item.timestamp}</div> : null}
          </div>
        </li>
      ))}
    </ol>
  );
}

export interface ActivityItem extends TimelineItem {
  actor?: ReactNode;
}

export interface ActivityListProps extends Omit<HTMLAttributes<HTMLUListElement>, "className" | "style"> {
  items: ActivityItem[];
}

export function ActivityList({ items, ...rest }: ActivityListProps) {
  return (
    <ul {...rest} className="modern-surface space-y-3 rounded-tokenLg border border-muted p-4 shadow-tokenSm">
      {items.map((item, index) => (
        <li key={index} className="rounded-tokenMd bg-background px-4 py-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="space-y-1">
              <div className="text-sm font-semibold text-foreground">{item.title}</div>
              {item.description ? <div className="text-sm text-secondary">{item.description}</div> : null}
            </div>
            <div className="text-xs text-secondary">
              {item.actor}
              {item.actor && item.timestamp ? " • " : null}
              {item.timestamp}
            </div>
          </div>
        </li>
      ))}
    </ul>
  );
}
