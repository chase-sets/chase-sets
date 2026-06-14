import { type HTMLAttributes, type ReactNode } from "react";
import { Icon } from "../../../icons";
import { Box, Show, Stack } from "../../../primitives/layout";
import { Caption } from "../../../primitives/typography";

export interface WorkstationLayoutProps extends Omit<HTMLAttributes<HTMLDivElement>, "className" | "style"> {
  primary: ReactNode;
  secondary: ReactNode;
  secondaryTitle: ReactNode;
  secondaryDescription?: ReactNode;
}

/**
 * Two-column operational workstation shell: a fluid primary work area beside a
 * fixed-width secondary rail on desktop that collapses into a disclosure on
 * mobile so the rail's reference detail stays one tap away.
 */
export function WorkstationLayout({
  primary,
  secondary,
  secondaryTitle,
  secondaryDescription,
  ...rest
}: WorkstationLayoutProps) {
  return (
    <div {...rest} className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(18rem,22rem)] lg:items-start">
      <Box minWidth="0">{primary}</Box>
      <Show above="lg">{secondary}</Show>
      <details className="group rounded-tokenMd border border-muted bg-background p-3 lg:hidden">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 text-sm font-semibold text-foreground">
          <span>{secondaryTitle}</span>
          <Icon name="chevronDown" size="sm" tone="secondary" />
        </summary>
        <Stack gap={3} element="div">
          {secondaryDescription ? <Caption element="div">{secondaryDescription}</Caption> : null}
          <Box>{secondary}</Box>
        </Stack>
      </details>
    </div>
  );
}
