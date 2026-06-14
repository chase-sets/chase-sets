import { type HTMLAttributes, type ReactNode } from "react";
import { Stack } from "../../../primitives/layout";

export interface WorkflowActionBarProps extends Omit<HTMLAttributes<HTMLDivElement>, "className" | "style"> {
  children: ReactNode;
  align?: "start" | "end";
}

/**
 * Workflow action row: stacks its buttons on mobile and lays them out in a row
 * from `sm` up, anchored to the start or end so module-level actions line up
 * with their section heading.
 */
export function WorkflowActionBar({ children, align = "start", ...rest }: WorkflowActionBarProps) {
  return (
    <Stack
      {...rest}
      direction={{ base: "column", sm: "row" }}
      align={{ base: "stretch", sm: "end" }}
      justify={{ base: "start", sm: align === "end" ? "end" : "start" }}
      gap={2}
    >
      {children}
    </Stack>
  );
}
