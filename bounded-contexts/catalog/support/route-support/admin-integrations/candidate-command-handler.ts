import { catalogMergeCandidateEditRequestFromFormData } from "../../../features/source-observations/api/catalog-merge-candidate-edit";
import type { createCatalogRequestApiClient } from "../../../support/request-support/api-client";
import { ApiError as CatalogApiError } from "../../shell-support/api/client";
import type { CatalogCommandJobResponse } from "./integrations-command-context";
import type { CatalogIntegrationsCommandResult } from "./integrations-command-result";
import { stringValue } from "./integrations-form-values";

type Api = ReturnType<typeof createCatalogRequestApiClient>;
type RouteContext = CatalogIntegrationsCommandResult["context"];

export type CandidateCommandIntent =
  | "candidate.promote"
  | "candidate.edit"
  | "candidate.split"
  | "candidate.ignore"
  | "candidate.defer";

const CANDIDATE_COMMAND_INTENTS = new Set<string>([
  "candidate.promote",
  "candidate.edit",
  "candidate.split",
  "candidate.ignore",
  "candidate.defer",
] satisfies CandidateCommandIntent[]);

export function isCandidateCommandIntent(intent: string): intent is CandidateCommandIntent {
  return CANDIDATE_COMMAND_INTENTS.has(intent);
}

export async function handleCandidateCommand(input: {
  api: Api;
  intent: CandidateCommandIntent;
  context: RouteContext;
  formData: FormData;
  selectedObservationIds: readonly string[];
}): Promise<CatalogIntegrationsCommandResult> {
  const { api, intent, context, formData, selectedObservationIds } = input;

  if (formData.get("candidateSelection") === "scope") {
    return handleCandidateScopeCommand(api, intent, context, formData, selectedObservationIds);
  }

  const candidateId = String(formData.get("candidateId") ?? "").trim();
  if (!candidateId) {
    return candidateResult(intent, "error", "command-failed", { ...context, selectedObservationIds });
  }

  switch (intent) {
    case "candidate.promote":
    case "candidate.ignore":
    case "candidate.defer": {
      const reason = String(formData.get("reason") ?? "").trim();
      if (!reason) {
        return candidateResult(intent, "error", "reason-required", { ...context, selectedObservationIds });
      }

      if (intent === "candidate.promote") {
        const conflictResolutions = mergeCandidateConflictResolutionsFromFormData(formData);
        if (conflictResolutions === "missing-resolution") {
          return candidateResult(intent, "error", "reason-required", { ...context, selectedObservationIds });
        }
        await api.promoteCatalogMergeCandidate(candidateId, { reason, conflictResolutions });
      } else if (intent === "candidate.ignore") {
        await api.ignoreCatalogMergeCandidate(candidateId, { reason });
      } else {
        await api.deferCatalogMergeCandidate(candidateId, { reason });
      }
      break;
    }
    case "candidate.edit":
    case "candidate.split": {
      // The page names the candidate version it read and the operator's typed change; the Catalog
      // API applies it to the snapshot it holds and refuses a version it has moved on from.
      const expectedVersion = candidateVersionFrom(formData);
      if (expectedVersion === null) {
        return candidateResult(intent, "error", "command-failed", { ...context, selectedObservationIds });
      }
      const reason = String(formData.get("reason") ?? "").trim();
      if (!reason) {
        return candidateResult(intent, "error", "reason-required", { ...context, selectedObservationIds });
      }
      const splitObservationIds = idList(formData.get("splitObservationIds"));
      if (intent === "candidate.split" && splitObservationIds.length === 0) {
        return candidateResult(intent, "error", "command-failed", { ...context, selectedObservationIds });
      }
      try {
        if (intent === "candidate.edit") {
          await api.updateCatalogMergeCandidate(candidateId, {
            reason,
            expectedVersion,
            edit: catalogMergeCandidateEditRequestFromFormData(formData),
          });
        } else {
          await api.splitCatalogMergeCandidate(candidateId, { reason, expectedVersion, splitObservationIds });
        }
      } catch (error) {
        if (isStaleCandidateRefusal(error)) {
          return candidateResult(intent, "error", "candidate-stale", { ...context, selectedObservationIds });
        }
        throw error;
      }
      break;
    }
  }

  return candidateResult(intent, "success", "job-queued", {
    ...context,
    selectedObservationIds,
    promotionPreviewId: null,
  });
}

// The scope toolbar's promote-all-ready and defer-remainder actions: the same
// candidate verbs applied to every matching candidate in the scope. The page
// submits only the scope; the server enqueues one durable job that selects the
// candidates itself when it starts.
async function handleCandidateScopeCommand(
  api: Api,
  intent: CandidateCommandIntent,
  context: RouteContext,
  formData: FormData,
  selectedObservationIds: readonly string[],
): Promise<CatalogIntegrationsCommandResult> {
  if (intent !== "candidate.promote" && intent !== "candidate.defer") {
    return candidateResult(intent, "error", "invalid-intent", { ...context, selectedObservationIds });
  }

  const scopeRecordId = stringValue(formData.get("scopeRecordId")) ?? context.scopeRecordId;
  if (!scopeRecordId) {
    return candidateResult(intent, "error", "command-failed", { ...context, selectedObservationIds });
  }

  const reason = String(formData.get("reason") ?? "").trim();
  if (intent === "candidate.defer" && !reason) {
    return candidateResult(intent, "error", "reason-required", { ...context, selectedObservationIds });
  }

  const job = await api.enqueueCatalogMergeCandidateBulkJob<CatalogCommandJobResponse>(
    intent === "candidate.promote" ? "merge-candidate-promote" : "merge-candidate-defer",
    scopeRecordId,
    reason || null,
  );

  return candidateResult(intent, "success", "job-queued", {
    ...context,
    selectedObservationIds,
    jobId: stringValue(job.jobId) ?? context.jobId,
    promotionPreviewId: null,
  });
}

function candidateVersionFrom(formData: FormData): number | null {
  const raw = String(formData.get("candidateVersion") ?? "").trim();
  const version = raw === "" ? Number.NaN : Number(raw);
  return Number.isSafeInteger(version) && version >= 0 ? version : null;
}

function idList(value: FormDataEntryValue | null): readonly string[] {
  return typeof value === "string"
    ? value
        .split(",")
        .map((id) => id.trim())
        .filter(Boolean)
    : [];
}

// The Catalog API's answer for a candidate that changed after the page read it.
function isStaleCandidateRefusal(error: unknown): boolean {
  if (!(error instanceof CatalogApiError) || error.status !== 409) {
    return false;
  }
  const body = error.body;
  const detail =
    body && typeof body === "object" && !Array.isArray(body) ? (body as { error?: unknown }).error : undefined;
  return !!detail && typeof detail === "object" && (detail as { code?: unknown }).code === "stale_merge_candidate";
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

  const resolutions: MergeCandidateConflictResolutionBody[] = [];
  for (const conflict of conflicts) {
    const choice = String(formData.get(`resolution.${conflict.code}`) ?? "existing");
    const reason = String(formData.get(`reason.${conflict.code}`) ?? "").trim();
    if (!reason) {
      return "missing-resolution";
    }
    resolutions.push({
      conflictCode: conflict.code,
      fieldPath: conflict.fieldPath,
      chosenValue: parseJsonValue(choice === "proposed" ? conflict.proposedValueJson : conflict.existingValueJson),
      reason,
      observationIds: conflict.observationIds,
    });
  }

  return resolutions.length > 0 ? resolutions : undefined;
}

function parseJsonValue(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function candidateResult(
  intent: CandidateCommandIntent,
  status: CatalogIntegrationsCommandResult["feedback"]["status"],
  result: CatalogIntegrationsCommandResult["feedback"]["result"],
  context: RouteContext,
): CatalogIntegrationsCommandResult {
  return { feedback: { status, intent, result }, context, section: "import-to-promotion" };
}
