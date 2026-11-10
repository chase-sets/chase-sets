import { vi } from "vitest";
import type { CatalogRuntimeDeps } from "../../../../support/authoring-support/runtime-support";
import type { SourceObservationPromotionPreview } from "../../read-model/queries";
import type { CatalogIntegrationRolloutControlPolicy } from "../governance/catalog-integration-rollout-controls";
import { createSourceObservationBulkReviewJobRuntime } from "../source-observation-bulk-review-job-runtime";
import { staticCatalogProviderIntegrationProfileVersions } from "../source-observation-runtime-contracts";
import { baseBulkJob } from "./route-test-harness";

type Statement = Readonly<{ sql: string; values: readonly unknown[] | undefined; client: "pool" | "transaction" }>;

export type PromotionAdmissionHarnessOptions = Readonly<{
  onQuery?: (sql: string) => Promise<void> | void;
  rows?: (sql: string, values: readonly unknown[]) => readonly Record<string, unknown>[];
}>;

/**
 * The real bulk promotion admission over a recording pool: every statement,
 * which client ran it, and what the job and work unit stores were asked to
 * write. `preview` is what a fresh preview reads; `onQuery` can fail or hold a
 * statement to stand in for a concurrent writer, and `rows` answers a
 * statement the way the table would.
 */
export function promotionAdmissionHarness(
  preview: { current: SourceObservationPromotionPreview },
  options: PromotionAdmissionHarnessOptions = {},
) {
  const statements: Statement[] = [];
  const record = (client: Statement["client"]) =>
    vi.fn(async (sql: string, values?: readonly unknown[]) => {
      statements.push({ sql, values, client });
      await options.onQuery?.(sql);
      const rows = options.rows?.(sql, values ?? []) ?? [];
      return { rows, rowCount: rows.length };
    });
  const transaction = { query: record("transaction"), release: vi.fn() };
  const pool = { query: record("pool"), connect: vi.fn(async () => transaction) };
  const previewPromotionSelection = vi.fn(
    async (_selection: unknown, _options: unknown, _db?: unknown) => preview.current,
  );
  const enqueueJob = vi.fn(async (input: { jobId: string; jobKind: string; payload: Record<string, unknown> }) => ({
    ...baseBulkJob(),
    jobKind: input.jobKind,
    jobId: input.jobId,
    payload: input.payload,
  }));
  const enqueueUnits = vi.fn(async (input: { units: readonly unknown[] }) => input.units.length);
  const stores = { jobStore: { enqueue: enqueueJob }, workUnitStore: { enqueue: enqueueUnits } };
  const bulkReviewStoresIn = vi.fn(() => stores);
  const { services } = createSourceObservationBulkReviewJobRuntime({
    deps: { db: pool } as unknown as CatalogRuntimeDeps,
    profileVersions: staticCatalogProviderIntegrationProfileVersions,
    rolloutControlPolicy: { assertAllowed: () => undefined } as unknown as CatalogIntegrationRolloutControlPolicy,
    bulkReviewJobStore: stores.jobStore as never,
    bulkReviewWorkUnitStore: stores.workUnitStore as never,
    bulkReviewStoresIn: bulkReviewStoresIn as never,
    promotionReapply: { previewPromotionSelection } as never,
  });

  return {
    admitBulkPromotionJob: services.admitBulkPromotionJob,
    previewPromotionSelection,
    enqueueJob,
    enqueueUnits,
    bulkReviewStoresIn,
    transaction,
    statements,
  };
}
