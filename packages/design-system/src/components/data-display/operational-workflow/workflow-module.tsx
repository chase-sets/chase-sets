import { useId, type HTMLAttributes, type ReactNode } from "react";
import { Inline, Stack, Surface } from "../../../primitives/layout";
import { Subheading, Text } from "../../../primitives/typography";
import { resolveDensityMode, type DensityInput } from "../../../theme/tokens";
import { WorkflowActionBar } from "./workflow-action-bar";

export interface WorkflowModuleProps extends Omit<HTMLAttributes<HTMLElement>, "className" | "style" | "title"> {
  title: ReactNode;
  description?: ReactNode;
  status?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  headingLevel?: 2 | 3 | 4;
  density?: DensityInput;
}

/**
 * Dense workflow section: a titled card surface that groups a heading, optional
 * status chip and action bar, and its body content, used to frame one step of
 * an operational workflow.
 */
export function WorkflowModule({
  title,
  description,
  status,
  actions,
  children,
  headingLevel = 3,
  density = "comfortable",
  ...rest
}: WorkflowModuleProps) {
  const titleId = useId();
  const resolvedDensity = resolveDensityMode(density);

  return (
    <Surface
      {...rest}
      element="section"
      aria-labelledby={titleId}
      padding={resolvedDensity === "compact" ? 3 : 4}
      gap={3}
    >
      <Stack
        direction={{ base: "column", md: "row" }}
        align={{ base: "stretch", md: "start" }}
        justify={{ base: "start", md: "between" }}
        gap={3}
      >
        <Stack gap={1} minWidth="0">
          <Inline gap={2}>
            <Subheading id={titleId} level={headingLevel}>
              {title}
            </Subheading>
            {status}
          </Inline>
          {description ? (
            <Text size="sm" tone="secondary">
              {description}
            </Text>
          ) : null}
        </Stack>
        {actions ? <WorkflowActionBar align="end">{actions}</WorkflowActionBar> : null}
      </Stack>
      <Stack gap={3}>{children}</Stack>
    </Surface>
  );
}
