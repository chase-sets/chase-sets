import { type HTMLAttributes, type ReactNode } from "react";
import { Surface } from "../../../primitives/layout";
import { Subheading } from "../../../primitives/typography";

export interface TaskSummaryItem {
  label: ReactNode;
  value: ReactNode;
}

export interface TaskSummaryProps extends Omit<HTMLAttributes<HTMLDivElement>, "className" | "style" | "title"> {
  title: ReactNode;
  items: readonly TaskSummaryItem[];
}

/**
 * Task summary card: a titled definition list of label/value pairs that frames
 * the standing facts of a workstation task (status, counts, references).
 */
export function TaskSummary({ title, items, ...rest }: TaskSummaryProps) {
  return (
    <Surface {...rest} element="section" tone="subtle" gap={3}>
      <Subheading level={2}>{title}</Subheading>
      <dl className="m-0 grid gap-3">
        {items.map((item, index) => (
          <div key={index} className="grid gap-1 border-t border-muted pt-3 first:border-t-0 first:pt-0">
            <dt className="text-xs font-medium uppercase text-tertiary">{item.label}</dt>
            <dd className="m-0 min-w-0 text-sm text-foreground">{item.value}</dd>
          </div>
        ))}
      </dl>
    </Surface>
  );
}
