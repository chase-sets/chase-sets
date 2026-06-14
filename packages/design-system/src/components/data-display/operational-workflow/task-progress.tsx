import { type HTMLAttributes, type ReactNode } from "react";
import { Cluster, Stack } from "../../../primitives/layout";
import { Caption, Text } from "../../../primitives/typography";
import { Progress } from "../../feedback/loading";

export interface TaskProgressProps extends Omit<HTMLAttributes<HTMLDivElement>, "className" | "style"> {
  label: ReactNode;
  value: number;
  valueLabel?: ReactNode;
  description?: ReactNode;
  tone?: "neutral" | "active" | "success" | "blocked";
}

/**
 * Task progress readout: a labelled determinate progress bar with an optional
 * numeric value and helper line, used to show how far a workstation checklist
 * has advanced.
 */
export function TaskProgress({ label, value, valueLabel, description, tone = "active", ...rest }: TaskProgressProps) {
  return (
    <Stack {...rest} gap={2}>
      <Cluster justify="between" gap={3}>
        <Text size="xs" weight="medium" tone="secondary">
          {label}
        </Text>
        {valueLabel ? <span className="text-xs font-medium tabular-nums text-foreground">{valueLabel}</span> : null}
      </Cluster>
      <Progress value={value} tone={tone} />
      {description ? (
        <Caption element="div" tone="secondary">
          {description}
        </Caption>
      ) : null}
    </Stack>
  );
}
