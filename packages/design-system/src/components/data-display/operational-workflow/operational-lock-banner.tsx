import { type HTMLAttributes, type ReactNode } from "react";
import { IconRow, Stack, Surface } from "../../../primitives/layout";
import { Text } from "../../../primitives/typography";
import { ToneIcon } from "../../../primitives/tone-icon";

export interface OperationalLockBannerProps extends Omit<
  HTMLAttributes<HTMLDivElement>,
  "className" | "style" | "title"
> {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
}

/**
 * Lock notice: a warning-toned surface with a padlock glyph that signals a
 * workstation task is frozen against edits while it is in progress.
 */
export function OperationalLockBanner({ title, description, action, ...rest }: OperationalLockBannerProps) {
  return (
    <Surface {...rest} tone="warning">
      <Stack
        direction={{ base: "column", sm: "row" }}
        align={{ base: "stretch", sm: "start" }}
        justify={{ base: "start", sm: "between" }}
        gap={3}
      >
        <IconRow icon={<ToneIcon name="lock" tone="warning" />} gap={3}>
          <Stack gap={1}>
            <Text size="sm" weight="semibold">
              {title}
            </Text>
            {description ? (
              <Text size="sm" tone="secondary">
                {description}
              </Text>
            ) : null}
          </Stack>
        </IconRow>
        {action}
      </Stack>
    </Surface>
  );
}
