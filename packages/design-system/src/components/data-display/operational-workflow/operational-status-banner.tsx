import { type HTMLAttributes, type ReactNode } from "react";
import { IconRow, Stack, Surface, type SurfaceSemanticTone } from "../../../primitives/layout";
import { Text } from "../../../primitives/typography";
import { ToneIcon, type ToneIconTone } from "../../../primitives/tone-icon";
import { type IconName } from "../../../icons";

export type OperationalStatusBannerTone = "info" | "success" | "warning" | "danger";

export interface OperationalStatusBannerProps extends Omit<
  HTMLAttributes<HTMLDivElement>,
  "className" | "style" | "title"
> {
  title: ReactNode;
  description?: ReactNode;
  tone?: OperationalStatusBannerTone;
  action?: ReactNode;
}

const statusBannerIcon: Record<OperationalStatusBannerTone, IconName> = {
  info: "info",
  success: "check",
  warning: "warning",
  danger: "warning",
};

/**
 * Operational status notice: a tone-tinted surface pairing a status glyph,
 * heading, and supporting copy with an optional trailing action, used to flag
 * the live state of a workstation task.
 */
export function OperationalStatusBanner({
  title,
  description,
  tone = "info",
  action,
  ...rest
}: OperationalStatusBannerProps) {
  return (
    <Surface {...rest} tone={tone as SurfaceSemanticTone}>
      <Stack
        direction={{ base: "column", sm: "row" }}
        align={{ base: "stretch", sm: "start" }}
        justify={{ base: "start", sm: "between" }}
        gap={3}
      >
        <IconRow icon={<ToneIcon name={statusBannerIcon[tone]} tone={tone as ToneIconTone} />} gap={3}>
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
