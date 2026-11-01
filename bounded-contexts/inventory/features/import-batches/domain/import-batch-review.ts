import type { InventoryImportSourceKey } from "./import-source-adapters";

export type ImportBatchReviewStatus =
  | "uploaded"
  | "validating"
  | "ready-to-commit"
  | "committing"
  | "committed"
  | "partial"
  | "failed-safe"
  | "ambiguous"
  | "expired";

export type ImportBatchReviewRow = Readonly<{
  sourceKey: InventoryImportSourceKey;
  status: "accepted" | "rejected" | "committed";
  resolutionStatus: "native" | "resolved" | "unresolved";
  productId: string | null;
  committedAt: string | null;
}>;

export function importRowNeedsSeller(row: ImportBatchReviewRow): boolean {
  return (
    row.status === "rejected" &&
    row.committedAt === null &&
    (row.sourceKey === "saved-list" || row.resolutionStatus === "unresolved" || row.productId === null)
  );
}

export type ImportBatchCommitReadinessInput = Readonly<{
  status: ImportBatchReviewStatus;
  acceptedCount: number;
  committedCount: number;
  stockProgressionEnabled?: boolean;
}>;

export type ImportBatchCommitReadiness = Readonly<{
  canCommit: boolean;
  commitReadyCount: number;
}>;

export function importBatchCommitReadiness(input: ImportBatchCommitReadinessInput): ImportBatchCommitReadiness {
  const commitReadyCount = Math.max(0, input.acceptedCount - input.committedCount);
  const statusAllowsCommit = ["uploaded", "ready-to-commit", "partial"].includes(input.status);

  return {
    commitReadyCount,
    canCommit: statusAllowsCommit && commitReadyCount > 0 && input.stockProgressionEnabled !== false,
  };
}
