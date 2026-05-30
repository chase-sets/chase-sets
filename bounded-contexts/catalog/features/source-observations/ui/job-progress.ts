import type { CatalogBulkActionProgress } from "../../../support/shell-support/api/client";

export function shouldAcceptSourceObservationJobProgress(
  current: CatalogBulkActionProgress | null,
  next: CatalogBulkActionProgress,
): boolean {
  if (!current || isTerminalProgress(next)) {
    return true;
  }

  if (phaseRank(next.phase) < phaseRank(current.phase)) {
    return false;
  }

  return next.completed >= current.completed;
}

function isTerminalProgress(progress: CatalogBulkActionProgress): boolean {
  return progress.phase === "completed" || progress.phase === "failed";
}

function phaseRank(phase: string): number {
  if (phase === "completed" || phase === "failed") {
    return 2;
  }

  if (phase === "queued") {
    return 0;
  }

  return 1;
}
