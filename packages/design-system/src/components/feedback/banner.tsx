import type { HTMLAttributes, ReactNode } from "react";
import { FlexItem, IconRow, Inline, Stack, Surface } from "../../primitives/layout";
import { Text } from "../../primitives/typography";
import { Icon } from "../../icons";
import { type Tone, toneIcon, toneToSemantic } from "./shared";

export interface BannerProps extends Omit<HTMLAttributes<HTMLDivElement>, "className" | "style" | "title"> {
  title: ReactNode;
  description?: ReactNode;
  tone?: Exclude<Tone, "neutral">;
  actions?: ReactNode;
}

export function Banner({ title, description, tone = "info", actions, ...rest }: BannerProps) {
  return (
    <Surface {...rest} tone={toneToSemantic(tone)} element="div">
      <Stack
        direction={{ base: "column", md: "row" }}
        align={{ base: "stretch", md: "center" }}
        justify={{ base: "start", md: "between" }}
        gap={4}
      >
        <FlexItem grow>
          <IconRow icon={<Icon name={toneIcon(tone)} size="sm" tone={tone} />} align="start" gap={3}>
            <Stack gap={1} minWidth="0">
              <Text size="sm" weight="semibold" tone="inherit">
                {title}
              </Text>
              {description ? (
                <Text size="sm" tone="inherit">
                  {description}
                </Text>
              ) : null}
            </Stack>
          </IconRow>
        </FlexItem>
        {actions ? <Inline gap={2}>{actions}</Inline> : null}
      </Stack>
    </Surface>
  );
}
