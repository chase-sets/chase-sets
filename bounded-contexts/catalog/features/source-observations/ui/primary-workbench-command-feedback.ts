import { t } from "@chase-sets/localization";
import type {
  CatalogControlPlaneActionId,
  CatalogControlPlaneEntityKey,
} from "./admin-control-plane/information-architecture-v2";

export type CatalogPrimaryWorkbenchCommandFeedback = Readonly<{
  status: "success" | "error";
  intent: string;
  target?: Readonly<{
    entity: CatalogControlPlaneEntityKey;
    id: string | null;
    count: number;
  }>;
  nextStep?: "review-and-confirm" | "re-preview" | "monitor-job" | "correct-input" | null;
  undoAction?: CatalogControlPlaneActionId | null;
  result:
    | "job-queued"
    | "job-cancelled"
    | "preview-ready"
    | "draft-created"
    | "profile-activated"
    | "profile-rolled-back"
    | "profile-deprecated"
    | "profile-retired"
    | "section-saved"
    | "section-conflict"
    | "section-invalid"
    | "lifecycle-conflict"
    | "confirmation-required"
    | "preview-required"
    | "job-required"
    | "reason-required"
    | "catalog-sync-blocked"
    | "unsupported-command"
    | "invalid-intent"
    | "command-failed";
}>;

export function commandSuccessTitle(result: CatalogPrimaryWorkbenchCommandFeedback["result"]): string {
  if (result === "preview-ready") {
    return t("catalog.features.sourceObservations.ui.primaryWorkbench.command.feedback.preview.title");
  }
  if (result === "job-cancelled") {
    return t("catalog.features.sourceObservations.ui.primaryWorkbench.command.feedback.cancelled.title");
  }
  if (result === "draft-created") {
    return t("catalog.features.sourceObservations.ui.primaryWorkbench.command.feedback.draft.title");
  }
  if (result === "profile-activated") {
    return t("catalog.features.sourceObservations.ui.primaryWorkbench.command.feedback.activation.title");
  }
  if (result === "profile-rolled-back") {
    return t("catalog.features.sourceObservations.ui.primaryWorkbench.command.feedback.rollback.title");
  }
  if (result === "profile-deprecated") {
    return t("catalog.features.sourceObservations.ui.primaryWorkbench.command.feedback.deprecated.title");
  }
  if (result === "profile-retired") {
    return t("catalog.features.sourceObservations.ui.primaryWorkbench.command.feedback.retired.title");
  }
  if (result === "section-saved") {
    return t("catalog.features.sourceObservations.ui.primaryWorkbench.command.feedback.section.title");
  }

  return t("catalog.features.sourceObservations.ui.primaryWorkbench.command.feedback.queued.title");
}

export function commandFeedbackDescription(feedback: CatalogPrimaryWorkbenchCommandFeedback): string {
  if (feedback.status === "success") {
    if (feedback.result === "preview-ready") {
      return t("catalog.features.sourceObservations.ui.primaryWorkbench.command.feedback.preview.description");
    }
    if (feedback.result === "job-cancelled") {
      return t("catalog.features.sourceObservations.ui.primaryWorkbench.command.feedback.cancelled.description");
    }
    if (feedback.result === "draft-created") {
      return t("catalog.features.sourceObservations.ui.primaryWorkbench.command.feedback.draft.description");
    }
    if (feedback.result === "profile-activated") {
      return t("catalog.features.sourceObservations.ui.primaryWorkbench.command.feedback.activation.description");
    }
    if (feedback.result === "profile-rolled-back") {
      return t("catalog.features.sourceObservations.ui.primaryWorkbench.command.feedback.rollback.description");
    }
    if (feedback.result === "profile-deprecated") {
      return t("catalog.features.sourceObservations.ui.primaryWorkbench.command.feedback.deprecated.description");
    }
    if (feedback.result === "profile-retired") {
      return t("catalog.features.sourceObservations.ui.primaryWorkbench.command.feedback.retired.description");
    }
    if (feedback.result === "section-saved") {
      return t("catalog.features.sourceObservations.ui.primaryWorkbench.command.feedback.section.description");
    }

    return t("catalog.features.sourceObservations.ui.primaryWorkbench.command.feedback.queued.description");
  }

  switch (feedback.result) {
    case "preview-required":
      return t("catalog.features.sourceObservations.ui.primaryWorkbench.command.feedback.preview.required");
    case "job-required":
      return t("catalog.features.sourceObservations.ui.primaryWorkbench.command.feedback.job.required");
    case "reason-required":
      return t("catalog.features.sourceObservations.ui.primaryWorkbench.command.feedback.reason.required");
    case "catalog-sync-blocked":
      return t("catalog.features.sourceObservations.ui.primaryWorkbench.command.feedback.catalogSync.blocked");
    case "section-conflict":
      return t("catalog.features.sourceObservations.ui.primaryWorkbench.command.feedback.section.conflict");
    case "section-invalid":
      return t("catalog.features.sourceObservations.ui.primaryWorkbench.command.feedback.section.invalid");
    case "lifecycle-conflict":
      return t("catalog.features.sourceObservations.ui.primaryWorkbench.command.feedback.lifecycle.conflict");
    case "confirmation-required":
      return t("catalog.features.sourceObservations.ui.primaryWorkbench.command.feedback.confirmation.required");
    case "unsupported-command":
      return t("catalog.features.sourceObservations.ui.primaryWorkbench.command.feedback.unsupported");
    case "invalid-intent":
      return t("catalog.features.sourceObservations.ui.primaryWorkbench.command.feedback.invalid.intent");
    case "command-failed":
    default:
      return t("catalog.features.sourceObservations.ui.primaryWorkbench.command.feedback.failed");
  }
}

export function commandErrorTitle(result: CatalogPrimaryWorkbenchCommandFeedback["result"]): string {
  if (result === "catalog-sync-blocked") {
    return t("catalog.features.sourceObservations.ui.primaryWorkbench.command.feedback.catalogSync.blocked.title");
  }

  return t("catalog.features.sourceObservations.ui.primaryWorkbench.command.feedback.error.title");
}
