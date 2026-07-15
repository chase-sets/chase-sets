import { editedSnapshotFromFormData } from "../../../features/source-observations/api/catalog-merge-candidate-edit";
import type { createCatalogRequestApiClient } from "../../../support/request-support/api-client";
import type { CatalogIntegrationsCommandResult } from "./integrations-command-result";

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

  if (formData.has("bulkCandidateIds")) {
    return handleCandidateSetCommand(api, intent, context, formData, selectedObservationIds);
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
    case "candidate.edit": {
      const editedSnapshot = editedSnapshotFromFormData(formData);
      if (editedSnapshot) {
        const reason = String(formData.get("reason") ?? "").trim();
        if (!reason) {
          return candidateResult(intent, "error", "reason-required", { ...context, selectedObservationIds });
        }
        await api.updateCatalogMergeCandidate(candidateId, { reason, snapshot: editedSnapshot });
        break;
      }

      const body = mergeCandidateCommandBody(formData);
      if (!body) {
        return candidateResult(intent, "error", "command-failed", { ...context, selectedObservationIds });
      }
      await api.updateCatalogMergeCandidate(candidateId, body);
      break;
    }
    case "candidate.split": {
      const body = mergeCandidateCommandBody(formData);
      if (!body) {
        return candidateResult(intent, "error", "command-failed", { ...context, selectedObservationIds });
      }
      await api.splitCatalogMergeCandidate(candidateId, body);
      break;
    }
  }

  return candidateResult(intent, "success", "job-queued", {
    ...context,
    selectedObservationIds,
    promotionPreviewId: null,
  });
}

async function handleCandidateSetCommand(
  api: Api,
  intent: CandidateCommandIntent,
  context: RouteContext,
  formData: FormData,
  selectedObservationIds: readonly string[],
): Promise<CatalogIntegrationsCommandResult> {
  if (intent !== "candidate.promote" && intent !== "candidate.defer") {
    return candidateResult(intent, "error", "invalid-intent", { ...context, selectedObservationIds });
  }

  const candidateIds = candidateIdList(formData);
  if (candidateIds.length === 0) {
    return candidateResult(intent, "error", "command-failed", { ...context, selectedObservationIds });
  }

  const reason =
    String(formData.get("reason") ?? "").trim() ||
    (intent === "candidate.promote" ? "Promote all ready candidates in the current scope." : "");
  if (!reason) {
    return candidateResult(intent, "error", "reason-required", { ...context, selectedObservationIds });
  }

  for (const candidateId of candidateIds) {
    if (intent === "candidate.promote") {
      await api.promoteCatalogMergeCandidate(candidateId, { reason });
    } else {
      await api.deferCatalogMergeCandidate(candidateId, { reason });
    }
  }

  return candidateResult(intent, "success", "job-queued", { ...context, selectedObservationIds });
}

function candidateIdList(formData: FormData): readonly string[] {
  return [
    ...new Set(
      String(formData.get("bulkCandidateIds") ?? "")
        .split(",")
        .map((candidateId) => candidateId.trim())
        .filter(Boolean),
    ),
  ];
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
