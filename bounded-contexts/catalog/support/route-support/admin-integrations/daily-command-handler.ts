import type { CatalogPrimaryWorkbenchCommandFeedback } from "../../../features/source-observations/ui/primary-workbench-command-feedback";
import type { createCatalogRequestApiClient } from "../../../support/request-support/api-client";
import {
  catalogSyncScopeFromContext,
  confirmsFreshPromotionPreview,
  hasExplicitPromotionScope,
  integrationScopeFromContext,
  previewPromotionForContext,
  promotionPreviewIdFor,
  promotionScopeFromContext,
  reapplyScopeFromContext,
  type CatalogCommandJobResponse,
} from "./integrations-command-context";
import type { CatalogIntegrationsCommandResult } from "./integrations-command-result";
import { stringValue } from "./integrations-form-values";
import { editedSnapshotFromFormData } from "../../../features/source-observations/api/catalog-merge-candidate-edit";

type Api = ReturnType<typeof createCatalogRequestApiClient>;
type RouteContext = CatalogIntegrationsCommandResult["context"];

// The daily import-to-promotion surface owns the run-sync / create-update flow and
// the Source Observation review wave. Every daily intent stays on the daily route:
// the handler returns a structured result with the import-to-promotion section, and
// the surface renders the command-feedback banner without navigating away.
export type DailyCommandIntent =
  | "start-catalog-sync"
  | "start-provider-import"
  | "retry-import-job"
  | "resume-import-job"
  | "cancel-import-job"
  | "preview-promotion"
  | "execute-promotion"
  | "reject-source-observations"
  | "defer-source-observations"
  | "promote-merge-candidate"
  | "split-merge-candidate"
  | "update-merge-candidate"
  | "ignore-merge-candidate"
  | "defer-merge-candidate"
  | "bulk-promote-merge-candidates"
  | "bulk-defer-merge-candidates"
  | "start-reapply"
  | "start-replay";

const DAILY_COMMAND_INTENTS = new Set<string>([
  "start-catalog-sync",
  "start-provider-import",
  "retry-import-job",
  "resume-import-job",
  "cancel-import-job",
  "preview-promotion",
  "execute-promotion",
  "reject-source-observations",
  "defer-source-observations",
  "promote-merge-candidate",
  "split-merge-candidate",
  "update-merge-candidate",
  "ignore-merge-candidate",
  "defer-merge-candidate",
  "bulk-promote-merge-candidates",
  "bulk-defer-merge-candidates",
  "start-reapply",
  "start-replay",
] satisfies DailyCommandIntent[]);

export function isDailyCommandIntent(intent: string): intent is DailyCommandIntent {
  return DAILY_COMMAND_INTENTS.has(intent);
}

// Run a daily command. Splits the import-job lifecycle, promotion preview/execution,
// and observation-review intents into cohesive blocks. The result always names the
// import-to-promotion section so the daily surface stays put with a status banner.
export async function handleDailyCommand(input: {
  api: Api;
  intent: DailyCommandIntent;
  context: RouteContext;
  formData: FormData;
  selectedObservationIds: readonly string[];
}): Promise<CatalogIntegrationsCommandResult> {
  const { api, intent, context, formData, selectedObservationIds } = input;

  switch (intent) {
    case "start-catalog-sync": {
      const scope = catalogSyncScopeFromContext(context, formData);
      if (!scope) {
        return dailyResult(intent, "error", "command-failed", { ...context, jobId: null, promotionPreviewId: null });
      }

      const run = await api.enqueueCatalogSyncRun<{ syncRunId?: unknown }>(scope);

      return dailyResult(intent, "success", "job-queued", {
        ...context,
        jobId: stringValue(run.syncRunId) ?? context.jobId,
        promotionPreviewId: null,
      });
    }
    case "start-provider-import": {
      if (!hasSelectedImportScope(context)) {
        return dailyResult(intent, "error", "command-failed", { ...context, jobId: null, promotionPreviewId: null });
      }

      const job = await api.enqueueSourceObservationIntegrationJob<CatalogCommandJobResponse>(
        "import",
        integrationScopeFromContext(context),
      );

      return dailyResult(intent, "success", "job-queued", {
        ...context,
        jobId: stringValue(job.jobId) ?? context.jobId,
        promotionPreviewId: null,
      });
    }
    case "retry-import-job":
    case "resume-import-job":
    case "cancel-import-job": {
      if (!context.jobId) {
        return dailyResult(intent, "error", "job-required", { ...context, selectedObservationIds });
      }

      const job =
        intent === "retry-import-job"
          ? await api.retrySourceObservationIntegrationJob<CatalogCommandJobResponse>(context.jobId)
          : intent === "resume-import-job"
            ? await api.resumeSourceObservationIntegrationJob<CatalogCommandJobResponse>(context.jobId)
            : await api.cancelSourceObservationIntegrationJob<CatalogCommandJobResponse>(context.jobId);

      return dailyResult(intent, "success", intent === "cancel-import-job" ? "job-cancelled" : "job-queued", {
        ...context,
        selectedObservationIds,
        jobId: stringValue(job.jobId) ?? context.jobId,
        promotionPreviewId: null,
      });
    }
    case "preview-promotion": {
      if (selectedObservationIds.length === 0 && !hasExplicitPromotionScope(context)) {
        return dailyResult(intent, "error", "command-failed", {
          ...context,
          selectedObservationIds,
          promotionPreviewId: null,
        });
      }

      const preview = await previewPromotionForContext(api, context, selectedObservationIds);

      return dailyResult(intent, "success", "preview-ready", {
        ...context,
        selectedObservationIds,
        promotionPreviewId: promotionPreviewIdFor(preview, context, selectedObservationIds),
      });
    }
    case "execute-promotion": {
      if (selectedObservationIds.length === 0 && !hasExplicitPromotionScope(context)) {
        return dailyResult(intent, "error", "preview-required", {
          ...context,
          selectedObservationIds,
          promotionPreviewId: null,
        });
      }
      if (!context.promotionPreviewId || !(await confirmsFreshPromotionPreview(api, context, selectedObservationIds))) {
        return dailyResult(intent, "error", "preview-required", {
          ...context,
          selectedObservationIds,
          promotionPreviewId: null,
        });
      }

      const job =
        selectedObservationIds.length > 0
          ? await api.bulkPromoteSourceObservations<CatalogCommandJobResponse>([...selectedObservationIds])
          : await api.bulkPromoteSourceObservationsByScope<CatalogCommandJobResponse>(
              promotionScopeFromContext(context),
            );

      return dailyResult(intent, "success", "job-queued", {
        ...context,
        jobId: stringValue(job.jobId) ?? context.jobId,
        promotionPreviewId: null,
      });
    }
    case "reject-source-observations": {
      const reason = String(formData.get("reason") ?? "").trim();
      if (!reason) {
        return dailyResult(intent, "error", "reason-required", { ...context, selectedObservationIds });
      }

      const job =
        selectedObservationIds.length > 0
          ? await api.bulkRejectSourceObservations<CatalogCommandJobResponse>([...selectedObservationIds], reason)
          : await api.bulkRejectSourceObservationsByScope<CatalogCommandJobResponse>(
              promotionScopeFromContext(context),
              reason,
            );

      return dailyResult(intent, "success", "job-queued", {
        ...context,
        selectedObservationIds,
        jobId: stringValue(job.jobId) ?? context.jobId,
        promotionPreviewId: null,
      });
    }
    case "defer-source-observations": {
      const reason = String(formData.get("reason") ?? "").trim() || "Deferred from the primary workbench.";
      const job =
        selectedObservationIds.length > 0
          ? await api.deferSourceObservations<CatalogCommandJobResponse>([...selectedObservationIds], reason)
          : await api.deferSourceObservationsByScope<CatalogCommandJobResponse>(
              promotionScopeFromContext(context),
              reason,
            );

      return dailyResult(intent, "success", "job-queued", {
        ...context,
        selectedObservationIds: [],
        jobId: stringValue(job.jobId) ?? context.jobId,
        promotionPreviewId: null,
      });
    }
    case "promote-merge-candidate":
    case "ignore-merge-candidate":
    case "defer-merge-candidate": {
      const candidateId = String(formData.get("candidateId") ?? "").trim();
      const reason = String(formData.get("reason") ?? "").trim();
      if (!candidateId) {
        return dailyResult(intent, "error", "command-failed", { ...context, selectedObservationIds });
      }
      if (!reason) {
        return dailyResult(intent, "error", "reason-required", { ...context, selectedObservationIds });
      }

      if (intent === "promote-merge-candidate") {
        const conflictResolutions = mergeCandidateConflictResolutionsFromFormData(formData);
        if (conflictResolutions === "missing-resolution") {
          return dailyResult(intent, "error", "reason-required", { ...context, selectedObservationIds });
        }
        await api.promoteCatalogMergeCandidate(candidateId, { reason, conflictResolutions });
      } else if (intent === "ignore-merge-candidate") {
        await api.ignoreCatalogMergeCandidate(candidateId, { reason });
      } else {
        await api.deferCatalogMergeCandidate(candidateId, { reason });
      }

      return dailyResult(intent, "success", "job-queued", {
        ...context,
        selectedObservationIds,
        promotionPreviewId: null,
      });
    }
    case "update-merge-candidate": {
      const candidateId = String(formData.get("candidateId") ?? "").trim();
      if (!candidateId) {
        return dailyResult(intent, "error", "command-failed", {
          ...context,
          selectedObservationIds,
          promotionPreviewId: null,
        });
      }

      // Edit-form path (#3800): the operator authored a typed candidate edit. The
      // embedded base snapshot plus overrides reconstruct the replacement snapshot
      // the UpdateCatalogMergeCandidate command carries, with a required reason.
      const editedSnapshot = editedSnapshotFromFormData(formData);
      if (editedSnapshot) {
        const reason = String(formData.get("reason") ?? "").trim();
        if (!reason) {
          return dailyResult(intent, "error", "reason-required", { ...context, selectedObservationIds });
        }
        await api.updateCatalogMergeCandidate(candidateId, { reason, snapshot: editedSnapshot });
        return dailyResult(intent, "success", "job-queued", {
          ...context,
          selectedObservationIds,
          promotionPreviewId: null,
        });
      }

      // Typed command-preview path: the workbench precomputed the update body.
      const body = mergeCandidateCommandBody(formData);
      if (!body) {
        return dailyResult(intent, "error", "command-failed", {
          ...context,
          selectedObservationIds,
          promotionPreviewId: null,
        });
      }
      await api.updateCatalogMergeCandidate(candidateId, body);
      return dailyResult(intent, "success", "job-queued", {
        ...context,
        selectedObservationIds,
        promotionPreviewId: null,
      });
    }
    case "split-merge-candidate": {
      const candidateId = String(formData.get("candidateId") ?? "").trim();
      const body = mergeCandidateCommandBody(formData);
      if (!candidateId || !body) {
        return dailyResult(intent, "error", "command-failed", {
          ...context,
          selectedObservationIds,
          promotionPreviewId: null,
        });
      }

      await api.splitCatalogMergeCandidate(candidateId, body);

      return dailyResult(intent, "success", "job-queued", {
        ...context,
        selectedObservationIds,
        promotionPreviewId: null,
      });
    }
    case "bulk-promote-merge-candidates": {
      // Scope-level promote-all-ready (#3800). Only the candidate IDs the read
      // model classified as ready reach this set, so blocking-conflict resolution
      // requirements stay intact: has-conflicts / stale / deferred candidates are
      // never bulk-promoted. Ready candidates carry no blocking conflicts, so no
      // conflict resolutions are required.
      const candidateIds = candidateIdList(formData);
      if (candidateIds.length === 0) {
        return dailyResult(intent, "error", "command-failed", { ...context, selectedObservationIds });
      }
      const reason =
        String(formData.get("reason") ?? "").trim() || "Bulk promote all ready candidates in the current scope.";
      for (const candidateId of candidateIds) {
        await api.promoteCatalogMergeCandidate(candidateId, { reason });
      }
      return dailyResult(intent, "success", "job-queued", { ...context, selectedObservationIds });
    }
    case "bulk-defer-merge-candidates": {
      const candidateIds = candidateIdList(formData);
      const reason = String(formData.get("reason") ?? "").trim();
      if (!reason) {
        return dailyResult(intent, "error", "reason-required", { ...context, selectedObservationIds });
      }
      if (candidateIds.length === 0) {
        return dailyResult(intent, "error", "command-failed", { ...context, selectedObservationIds });
      }
      for (const candidateId of candidateIds) {
        await api.deferCatalogMergeCandidate(candidateId, { reason });
      }
      return dailyResult(intent, "success", "job-queued", { ...context, selectedObservationIds });
    }
    case "start-reapply":
    case "start-replay": {
      const job =
        intent === "start-reapply"
          ? selectedObservationIds.length > 0
            ? await api.reapplySourceObservations<CatalogCommandJobResponse>([...selectedObservationIds])
            : await api.reapplySourceObservationsByScope<CatalogCommandJobResponse>(reapplyScopeFromContext(context))
          : selectedObservationIds.length > 0
            ? await api.replaySourceObservations<CatalogCommandJobResponse>([...selectedObservationIds])
            : await api.replaySourceObservationsByScope<CatalogCommandJobResponse>(reapplyScopeFromContext(context));

      return dailyResult(intent, "success", "job-queued", {
        ...context,
        selectedObservationIds,
        jobId: stringValue(job.jobId) ?? context.jobId,
        promotionPreviewId: null,
      });
    }
  }
}

function hasSelectedImportScope(context: RouteContext): boolean {
  return Boolean(context.providerKey && context.unitKey && context.importScope);
}

// The bulk review forms submit the candidate IDs to act on as a comma-separated
// list, deduplicated. The read model partitions candidates by status so the
// promote form only ever carries `ready` IDs and the defer form the remainder.
function candidateIdList(formData: FormData): readonly string[] {
  const raw = String(formData.get("bulkCandidateIds") ?? "");
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const entry of raw.split(",")) {
    const candidateId = entry.trim();
    if (candidateId && !seen.has(candidateId)) {
      seen.add(candidateId);
      ids.push(candidateId);
    }
  }
  return ids;
}

function mergeCandidateCommandBody(formData: FormData): Record<string, unknown> | null {
  const value = String(formData.get("mergeCandidateCommandBody") ?? "").trim();
  if (!value) {
    return null;
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

type MergeCandidateBlockingConflictField = Readonly<{
  code: string;
  fieldPath: string | null;
  existingValueJson: string;
  proposedValueJson: string;
  observationIds: readonly string[];
}>;

type MergeCandidateConflictResolutionBody = Readonly<{
  conflictCode: string;
  fieldPath: string | null;
  chosenValue: unknown;
  reason: string;
  observationIds: readonly string[];
}>;

// Conflict resolution dissolved into candidate review: the review drawer submits
// one radio choice (`resolution.<code>`) and one reason (`reason.<code>`) per
// blocking conflict, alongside a `blockingConflictsJson` blob naming exactly
// which conflicts (and their existing/proposed values) the operator is
// resolving. Reconstitutes the typed conflictResolutions promote-command field
// the domain's requireConflictResolutionsForBlockingConflicts invariant
// requires — every blocking conflict on the candidate must have a resolution by
// code, or promotion is rejected. Returns "missing-resolution" if any blocking
// conflict on the submitted form lacks a reason, and undefined (no candidate had
// blocking conflicts) when the sheet did not submit a conflicts blob at all.
function mergeCandidateConflictResolutionsFromFormData(
  formData: FormData,
): readonly MergeCandidateConflictResolutionBody[] | "missing-resolution" | undefined {
  const raw = String(formData.get("blockingConflictsJson") ?? "").trim();
  if (!raw) {
    return undefined;
  }

  let conflicts: readonly MergeCandidateBlockingConflictField[];
  try {
    const parsed = JSON.parse(raw) as unknown;
    conflicts = Array.isArray(parsed) ? (parsed as MergeCandidateBlockingConflictField[]) : [];
  } catch {
    return "missing-resolution";
  }
  if (conflicts.length === 0) {
    return undefined;
  }

  const resolutions: MergeCandidateConflictResolutionBody[] = [];
  for (const conflict of conflicts) {
    const choice = String(formData.get(`resolution.${conflict.code}`) ?? "existing");
    const reason = String(formData.get(`reason.${conflict.code}`) ?? "").trim();
    if (!reason) {
      return "missing-resolution";
    }
    const chosenValueJson = choice === "proposed" ? conflict.proposedValueJson : conflict.existingValueJson;
    resolutions.push({
      conflictCode: conflict.code,
      fieldPath: conflict.fieldPath,
      chosenValue: parseJsonValue(chosenValueJson),
      reason,
      observationIds: conflict.observationIds,
    });
  }

  return resolutions;
}

function parseJsonValue(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

// Every daily result names the import-to-promotion section, so the daily surface
// stays on its route and renders the command-feedback banner.
function dailyResult(
  intent: DailyCommandIntent,
  status: CatalogPrimaryWorkbenchCommandFeedback["status"],
  result: CatalogPrimaryWorkbenchCommandFeedback["result"],
  context: RouteContext,
): CatalogIntegrationsCommandResult {
  return {
    feedback: { status, intent, result },
    context,
    section: "import-to-promotion",
  };
}
