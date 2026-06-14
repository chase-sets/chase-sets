import { type HTMLAttributes, type ReactNode } from "react";
import { cx } from "../../../utils/cx";
import { Grid, IconRow, Inline, Stack, Surface, type SurfaceSemanticTone } from "../../../primitives/layout";
import { Text } from "../../../primitives/typography";
import { ToneIcon, type ToneIconTone } from "../../../primitives/tone-icon";
import { type IconName } from "../../../icons";

export type WorkflowReadinessStatus = "passed" | "blocked" | "warning" | "pending";

export interface WorkflowReadinessItem {
  key: string;
  label: ReactNode;
  status: WorkflowReadinessStatus;
  statusLabel: ReactNode;
  description?: ReactNode;
  meta?: ReactNode;
  action?: ReactNode;
}

export interface WorkflowReadinessChecklistProps extends Omit<HTMLAttributes<HTMLUListElement>, "className" | "style"> {
  items: readonly WorkflowReadinessItem[];
  emptyState?: ReactNode;
}

const readinessIcon: Record<WorkflowReadinessStatus, IconName> = {
  passed: "check",
  blocked: "warning",
  warning: "info",
  pending: "clock",
};

const readinessTone: Record<WorkflowReadinessStatus, ToneIconTone> = {
  passed: "success",
  blocked: "danger",
  warning: "warning",
  pending: "neutral",
};

const readinessSurfaceTone: Record<WorkflowReadinessStatus, SurfaceSemanticTone> = {
  passed: "success",
  blocked: "danger",
  warning: "warning",
  pending: "neutral",
};

const readinessStatusTextClass: Record<WorkflowReadinessStatus, string> = {
  passed: "text-success",
  blocked: "text-danger",
  warning: "text-warning",
  pending: "text-tertiary",
};

/**
 * Workflow readiness checklist: a tone-coded list of activation checks, each
 * pairing a status glyph, label, and detail with its outcome and an optional
 * remediation action, used to gate a workflow step.
 */
export function WorkflowReadinessChecklist({ items, emptyState, ...rest }: WorkflowReadinessChecklistProps) {
  if (items.length === 0) {
    return emptyState ? (
      <Text size="sm" tone="secondary">
        {emptyState}
      </Text>
    ) : null;
  }

  return (
    <ul {...rest} className="m-0 grid list-none gap-2 p-0">
      {items.map((item) => (
        <li key={item.key}>
          <Surface tone={readinessSurfaceTone[item.status]} padding={3}>
            <Grid templateColumns="minmax(0,1fr) auto" stackUntil="sm" gap={2}>
              <IconRow
                icon={<ToneIcon name={readinessIcon[item.status]} tone={readinessTone[item.status]} size="sm" />}
                gap={2}
              >
                <Stack gap={1} minWidth="0">
                  <Text size="sm" weight="semibold">
                    {item.label}
                  </Text>
                  {item.description ? (
                    <Text size="sm" tone="secondary">
                      {item.description}
                    </Text>
                  ) : null}
                  {item.meta ? <Inline gap={2}>{item.meta}</Inline> : null}
                </Stack>
              </IconRow>
              <Stack gap={2} align={{ base: "stretch", sm: "end" }}>
                <span className={cx("text-xs font-semibold uppercase", readinessStatusTextClass[item.status])}>
                  {item.statusLabel}
                </span>
                {item.action}
              </Stack>
            </Grid>
          </Surface>
        </li>
      ))}
    </ul>
  );
}
