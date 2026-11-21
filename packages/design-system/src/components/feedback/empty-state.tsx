import type { HTMLAttributes, ReactNode } from "react";
import type { IconName } from "../../icons";
import { Center, Inline, Stack } from "../../primitives/layout";
import { ToneIcon } from "../../primitives/tone-icon";
import { Heading, Text } from "../../primitives/typography";

export interface EmptyStateProps extends Omit<HTMLAttributes<HTMLDivElement>, "className" | "style" | "title"> {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  icon?: IconName;
  /**
   * Whether the title is a section heading. Pass `false` when the empty state is a status inside a
   * section that already has its heading (a chart with no data), so it stays out of the page outline.
   */
  heading?: boolean;
}

export function EmptyState({ title, description, actions, icon = "spark", heading = true, ...rest }: EmptyStateProps) {
  return (
    <div {...rest} className="rounded-tokenLg border border-dashed border-muted bg-background p-6 text-center">
      <div className="mx-auto max-w-sm">
        <Stack align="center" gap={4} minWidth="0">
          <ToneIcon name={icon} tone="primary" size="lg" />
          <Stack gap={2} align="center">
            {heading ? (
              <Heading level={2} visualSize={4} align="center">
                {title}
              </Heading>
            ) : (
              <Text size="lg" weight="semibold" align="center">
                {title}
              </Text>
            )}
            {description ? (
              <Text size="sm" tone="secondary" align="center">
                {description}
              </Text>
            ) : null}
          </Stack>
          {actions ? (
            <Center>
              <Inline gap={2} align="center">
                {actions}
              </Inline>
            </Center>
          ) : null}
        </Stack>
      </div>
    </div>
  );
}
