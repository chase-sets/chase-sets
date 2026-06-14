import { type HTMLAttributes, type ReactNode } from "react";
import { Stack, Surface } from "../../../primitives/layout";
import { Heading, Text } from "../../../primitives/typography";

export interface ChecklistCardProps extends Omit<HTMLAttributes<HTMLElement>, "className" | "style" | "title"> {
  title: ReactNode;
  description?: ReactNode;
  progress?: ReactNode;
  children: ReactNode;
}

/**
 * Checklist card: a titled card that frames a list of task line items with an
 * optional summary description and progress readout, used to track packing and
 * fulfillment checklists.
 */
export function ChecklistCard({ title, description, progress, children, ...rest }: ChecklistCardProps) {
  return (
    <Surface {...rest} element="section" tone="subtle" gap={3}>
      <Stack
        direction={{ base: "column", md: "row" }}
        align={{ base: "stretch", md: "start" }}
        justify={{ base: "start", md: "between" }}
        gap={3}
      >
        <Stack gap={1}>
          <Heading level={2} visualSize={4}>
            {title}
          </Heading>
          {description ? (
            <Text size="sm" tone="secondary">
              {description}
            </Text>
          ) : null}
        </Stack>
        {progress ? <div className="md:min-w-48">{progress}</div> : null}
      </Stack>
      <Stack gap={2}>{children}</Stack>
    </Surface>
  );
}
