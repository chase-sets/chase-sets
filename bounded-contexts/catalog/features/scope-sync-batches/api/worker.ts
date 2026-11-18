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
          errorMessage: scopeSyncRunFailureDiagnostic(run),
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

function scopeSyncRunFailureDiagnostic(run: CatalogSyncRun): string {
  const runDiagnostic = knownHttpStatusDiagnostic(run.errorMessage);
  if (runDiagnostic) return runDiagnostic;
  const runSummary = `Scope Sync Run ended ${run.status}`;
  let childSummary: string | undefined;
  for (const child of run.childJobs) {
    if (child.status !== "failed" && child.status !== "partial" && child.status !== "cancelled") continue;
    const childDiagnostic =
      knownHttpStatusDiagnostic(child.errorMessage) ?? knownHttpStatusDiagnostic(child.job?.errorMessage);
    if (childDiagnostic) return childDiagnostic;
    const result = child.job?.result;
    for (const outcome of result?.outcomes ?? []) {
      if (outcome.status !== "failed") continue;
      const diagnostic = knownHttpStatusDiagnostic(outcome.reason);
      if (diagnostic) return diagnostic;
    }
    if (!childSummary && child.providerKey && child.unitKey) {
      const failed = result ? `, ${result.failed} failed` : "";
      childSummary = `${child.providerKey.slice(0, 64)} / ${child.unitKey.slice(0, 256)} (${child.status}${failed})`;
    }
  }
  return childSummary ? `${runSummary}: ${childSummary}.` : `${runSummary}.`;
}

function knownHttpStatusDiagnostic(message: string | null | undefined): string | undefined {
  // Keep only fixed adapter messages; parser errors can quote provider response text.
  return /^(?:LorcanaJSON|Lorcast|MTGJSON|Scryfall|YGOPRODeck|YGOJSON) request failed with HTTP [0-9]{3}\.$/.exec(
    message ?? "",
  )?.[0];
}

function supportSafeError(message: string): string {
  return message
    .replaceAll(/https?:\/\/\S+/gi, "[redacted-url]")
    .replaceAll(/\bbearer\s+\S+/gi, "[redacted]")
    .replaceAll(/(?:api[-_ ]?key|token|secret|password|authorization|cookie|account)\s*[=:]\s*\S+/gi, "[redacted]")
    .slice(0, 500);
}
