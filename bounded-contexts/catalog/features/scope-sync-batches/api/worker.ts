import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { CatalogSyncRun } from "../../source-observations/api/runtime";
import type { ScopeSyncBatchBudget, ScopeSyncBatchPlannedScope, ScopeSyncBatchUnitState } from "../domain/batch";

export type ClaimedScopeSyncBatchUnit = Readonly<{
  batchId: string;
  scopeRecordId: string;
  state: Extract<ScopeSyncBatchUnitState, "queued" | "running">;
  plan: ScopeSyncBatchPlannedScope;
  syncRunId: string | null;
  budget: ScopeSyncBatchBudget;
  context: EventStoreContext;
}>;

export type ScopeSyncBatchWorkerRepository = Readonly<{
  claimNext: (input: { claimOwnerId: string; claimTtlMs: number }) => Promise<ClaimedScopeSyncBatchUnit | null>;
  recordRunning: (input: { claim: ClaimedScopeSyncBatchUnit; syncRunId: string }) => Promise<void>;
  recordTerminal: (input: {
    claim: ClaimedScopeSyncBatchUnit;
    state: Extract<ScopeSyncBatchUnitState, "completed" | "failed">;
    errorMessage: string | null;
  }) => Promise<void>;
}>;

export function createScopeSyncBatchWorker(deps: {
  repository: ScopeSyncBatchWorkerRepository;
  enqueueCatalogSyncRun: (input: {
    scope: ScopeSyncBatchPlannedScope["scope"];
    context: EventStoreContext;
  }) => Promise<CatalogSyncRun>;
  getCatalogSyncRun: (input: { syncRunId: string; context: EventStoreContext }) => Promise<CatalogSyncRun | null>;
}) {
  async function processNext(input: { claimOwnerId: string; claimTtlMs: number }): Promise<number> {
    let processed = 0;
    let maxScopesPerTurn = 1;
    while (processed < maxScopesPerTurn) {
      const claim = await deps.repository.claimNext(input);
      if (!claim) break;
      maxScopesPerTurn = claim.budget.maxScopesPerTurn;
      await processClaim(claim);
      processed += 1;
    }
    return processed;
  }

  async function processClaim(claim: ClaimedScopeSyncBatchUnit): Promise<void> {
    try {
      const run = claim.syncRunId
        ? await deps.getCatalogSyncRun({ syncRunId: claim.syncRunId, context: claim.context })
        : await deps.enqueueCatalogSyncRun({ scope: claim.plan.scope, context: claim.context });
      if (!run) {
        throw new Error("Scope Sync Run was not found while reconciling the batch unit.");
      }
      if (!claim.syncRunId) {
        await deps.repository.recordRunning({ claim, syncRunId: run.syncRunId });
      }
      if (run.status === "completed") {
        await deps.repository.recordTerminal({ claim, state: "completed", errorMessage: null });
      } else if (run.status === "failed" || run.status === "partial" || run.status === "cancelled") {
        await deps.repository.recordTerminal({
          claim,
          state: "failed",
          errorMessage: supportSafeError(scopeSyncRunError(run) ?? `Scope Sync Run ended ${run.status}.`),
        });
      }
    } catch (error) {
      await deps.repository.recordTerminal({
        claim,
        state: "failed",
        errorMessage: supportSafeError(
          error instanceof Error ? error.message : "Scope Sync Run could not be advanced.",
        ),
      });
    }
  }

  return { processNext };
}

function scopeSyncRunError(run: CatalogSyncRun): string | null {
  if (run.errorMessage) return run.errorMessage;
  for (const child of run.childJobs) {
    if (child.status !== "failed" && child.status !== "partial" && child.status !== "cancelled") continue;
    const message =
      child.errorMessage ||
      child.job?.errorMessage ||
      child.job?.result?.outcomes.find((outcome) => outcome.status === "failed" && outcome.reason)?.reason;
    if (message) return message;
  }
  return null;
}

function supportSafeError(message: string): string {
  return message
    .replaceAll(/https?:\/\/\S+/gi, "[redacted-url]")
    .replaceAll(/\bbearer\s+\S+/gi, "[redacted]")
    .replaceAll(/(?:api[-_ ]?key|token|secret|password|authorization|cookie|account)\s*[=:]\s*\S+/gi, "[redacted]")
    .slice(0, 500);
}
