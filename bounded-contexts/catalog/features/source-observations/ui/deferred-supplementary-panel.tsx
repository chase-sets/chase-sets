import type { ReactElement } from "react";
import { Skeleton, WorkbenchDetailPanel, WorkbenchStack, WorkbenchText } from "@chase-sets/design-system";

// Shared design-system loading panel for a streamed supplementary boundary:
// a labelled status line plus skeleton bars sized to the panel the
// streamed value will replace. Rendered identically on the server and the client,
// so the deferred Suspense boundary hydrates without a mismatch warning. Lives in
// its own module so both the route view (alias-review slot) and the workbench
// shell (source-options status panel) can use it without a circular import.
export function DeferredSupplementaryPanel({ title, label }: Readonly<{ title: string; label: string }>): ReactElement {
  return (
    <WorkbenchDetailPanel data-catalog-deferred-panel="loading">
      <WorkbenchStack gap="sm">
        <WorkbenchText tone="foreground" weight="semibold">
          {title}
        </WorkbenchText>
        <WorkbenchText size="xs" tone="secondary" role="status">
          {label}
        </WorkbenchText>
        <Skeleton height="sm" />
        <Skeleton height="md" />
      </WorkbenchStack>
    </WorkbenchDetailPanel>
  );
}
