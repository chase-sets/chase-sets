import { useEffect, type ReactNode } from "react";
import { Heading, LiveRegion, Stack, Surface, Text } from "@chase-sets/design-system";

/**
 * The outcome of a checkout submission that did not simply succeed. Its
 * heading takes focus and its description is announced, so a buyer using
 * assistive technology learns the outcome without hunting for it. The copy
 * never claims more than the last owner answer showed.
 */
export function CheckoutAttemptResultNotice({
  id,
  title,
  description,
  action,
}: Readonly<{ id: string; title: string; description: string; action?: ReactNode }>) {
  useEffect(() => {
    globalThis.document?.getElementById(id)?.focus();
  }, [id, title]);

  return (
    <Surface tone="subtle" elevation="tinted">
      <Stack gap={3}>
        <Heading level={2} visualSize={4} id={id} tabIndex={-1}>
          {title}
        </Heading>
        <LiveRegion politeness="polite">
          <Text tone="secondary">{description}</Text>
        </LiveRegion>
        {action}
      </Stack>
    </Surface>
  );
}
