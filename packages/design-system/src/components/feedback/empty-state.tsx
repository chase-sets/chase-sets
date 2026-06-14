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
}

export function EmptyState({ title, description, actions, icon = "spark", ...rest }: EmptyStateProps) {
  return (
    <div {...rest} className="rounded-tokenLg border border-dashed border-muted bg-background p-6 text-center">
      <div className="mx-auto max-w-sm">
        <Stack align="center" gap={4} minWidth="0">
          <ToneIcon name={icon} tone="primary" size="lg" />
          <Stack gap={2} align="center">
            <Heading level={2} visualSize={4} align="center">
              {title}
            </Heading>
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
