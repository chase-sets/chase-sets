import { Banner, Skeleton, Stack } from "@chase-sets/design-system";
import type { ReactNode } from "react";

export function CollectionSectionLoading({ label, rows = 4 }: { label: string; rows?: number }) {
  return (
    <Stack gap={3} aria-busy="true" aria-label={label} role="status">
      {Array.from({ length: rows }, (_, index) => (
        <Skeleton key={index} height="md" />
      ))}
    </Stack>
  );
}

export function CollectionSectionError({ message }: { message: string }) {
  return <Banner tone="danger" title={message} />;
}

export function CollectionSectionDegraded({
  title,
  description,
  actions,
}: {
  title: string;
  description: string;
  actions?: ReactNode;
}) {
  return <Banner tone="warning" title={title} description={description} actions={actions} />;
}
