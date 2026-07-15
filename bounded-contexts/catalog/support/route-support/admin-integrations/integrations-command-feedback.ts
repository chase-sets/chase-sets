import type { CatalogPrimaryWorkbenchCommandFeedback } from "../../../features/source-observations/ui/primary-workbench-command-feedback";
import {
  CATALOG_CONTROL_PLANE_ACTIONS,
  CATALOG_CONTROL_PLANE_ENTITIES,
  type CatalogControlPlaneActionId,
  type CatalogControlPlaneEntityKey,
} from "../../../features/source-observations/ui/admin-control-plane/information-architecture-v2";

// Parse the post-command redirect query (?commandStatus/&commandResult/&commandIntent)
// into the typed feedback banner state. Shared by every integrations surface
// loader so each route surfaces the same command outcome banner.
export function commandFeedbackFromUrl(url: string | URL): CatalogPrimaryWorkbenchCommandFeedback | null {
  const parsedUrl = typeof url === "string" ? new URL(url) : url;
  const status = parsedUrl.searchParams.get("commandStatus");
  const result = parsedUrl.searchParams.get("commandResult");
  const intent = parsedUrl.searchParams.get("commandIntent") ?? "unknown";

  if ((status !== "success" && status !== "error") || !isCommandFeedbackResult(result)) {
    return null;
  }

  const targetEntity = parsedUrl.searchParams.get("commandTargetEntity");
  const targetCount = Number(parsedUrl.searchParams.get("commandTargetCount") ?? "0");
  const nextStep = parsedUrl.searchParams.get("commandNextStep");
  const undoAction = parsedUrl.searchParams.get("commandUndoAction");

  return {
    status,
    intent,
    result,
    ...(isCommandTargetEntity(targetEntity)
      ? {
          target: {
            entity: targetEntity,
            id: parsedUrl.searchParams.get("commandTargetId"),
            count: Number.isSafeInteger(targetCount) && targetCount >= 0 ? targetCount : 0,
          },
        }
      : {}),
    nextStep: isCommandNextStep(nextStep) ? nextStep : null,
    undoAction: isCommandAction(undoAction) ? undoAction : null,
  };
}

function isCommandTargetEntity(value: string | null): value is CatalogControlPlaneEntityKey {
  return CATALOG_CONTROL_PLANE_ENTITIES.some((entity) => entity.key === value);
}

function isCommandNextStep(
  value: string | null,
): value is NonNullable<CatalogPrimaryWorkbenchCommandFeedback["nextStep"]> {
  return ["review-and-confirm", "re-preview", "monitor-job", "correct-input"].includes(value ?? "");
}

function isCommandAction(value: string | null): value is CatalogControlPlaneActionId {
  return CATALOG_CONTROL_PLANE_ACTIONS.some((action) => action.id === value);
}

function isCommandFeedbackResult(value: string | null): value is CatalogPrimaryWorkbenchCommandFeedback["result"] {
  return (
    value === "job-queued" ||
    value === "job-cancelled" ||
    value === "preview-ready" ||
    value === "draft-created" ||
    value === "profile-activated" ||
    value === "profile-rolled-back" ||
    value === "profile-deprecated" ||
    value === "profile-retired" ||
    value === "section-saved" ||
    value === "section-conflict" ||
    value === "section-invalid" ||
    value === "lifecycle-conflict" ||
    value === "confirmation-required" ||
    value === "preview-required" ||
    value === "job-required" ||
    value === "reason-required" ||
    value === "catalog-sync-blocked" ||
    value === "unsupported-command" ||
    value === "invalid-intent" ||
    value === "command-failed"
  );
}
