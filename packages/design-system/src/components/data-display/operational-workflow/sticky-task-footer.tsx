import { type HTMLAttributes, type ReactNode } from "react";
import { cx } from "../../../utils/cx";
import { Grid, Stack } from "../../../primitives/layout";
import { Caption, Text } from "../../../primitives/typography";

export interface StickyTaskFooterProps extends Omit<HTMLAttributes<HTMLDivElement>, "className" | "style"> {
  summary: ReactNode;
  detail?: ReactNode;
  mobileOffset?: "app-shell" | "none" | "in-flow";
  children: ReactNode;
}

/**
 * Sticky task footer: an in-flow action bar that pins to the bottom of a
 * workstation flow, carrying a running summary plus the primary action, with
 * mobile offsets that clear the app shell's bottom navigation.
 */
export function StickyTaskFooter({
  summary,
  detail,
  mobileOffset = "app-shell",
  children,
  ...rest
}: StickyTaskFooterProps) {
  return (
    <div
      {...rest}
      className={cx(
        "z-20 rounded-tokenLg border border-border bg-elevated p-3 shadow-tokenLg md:sticky md:bottom-4 md:mb-0",
        mobileOffset === "app-shell" &&
          "sticky bottom-[calc(4.75rem+env(safe-area-inset-bottom))] mb-[calc(4.75rem+env(safe-area-inset-bottom))]",
        mobileOffset === "none" && "sticky bottom-4 mb-0",
        mobileOffset === "in-flow" && "relative mb-0",
      )}
    >
      <Grid templateColumns="minmax(0,1fr) auto" stackUntil="md" gap={3}>
        <Stack gap={1}>
          <Text size="sm" weight="semibold">
            {summary}
          </Text>
          {detail ? (
            <Caption element="div" tone="secondary">
              {detail}
            </Caption>
          ) : null}
        </Stack>
        <Stack direction={{ base: "column", sm: "row" }} align={{ base: "stretch", sm: "end" }} gap={2}>
          {children}
        </Stack>
      </Grid>
    </div>
  );
}
