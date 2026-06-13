import { EvidenceStringList } from "@chase-sets/design-system";
import { t } from "@chase-sets/localization";
import type { CatalogPrimaryWorkbenchReadModel } from "../../../api/primary-workbench-admin-contracts";

export type ValidationReadiness = CatalogPrimaryWorkbenchReadModel["validationReadiness"];
export type FixtureFlow = ValidationReadiness["fixtureFlows"][number];
export type DryRunEvidence = ValidationReadiness["dryRunEvidence"][number];
export type SemanticSection = ValidationReadiness["semanticCompare"]["sections"][number];
export type ActivationGroup = ValidationReadiness["activationReadiness"]["groups"][number];
export type ActivationDecision = ValidationReadiness["activationDecision"];
export type EvidenceRow = DryRunEvidence["duplicateCandidates"][number];
export type BadgeTone = "success" | "warning" | "danger" | "neutral" | "info" | "accent";

export function EvidenceList({ title, items }: { title: string; items: readonly string[] }) {
  return (
    <EvidenceStringList
      title={title}
      items={items}
      emptyLabel={t("catalog.features.sourceObservations.ui.primaryWorkbench.validation.evidence.noneDeclared")}
      emptyTone="neutral"
    />
  );
}

export function statusLabel(value: string): string {
  return value
    .split("-")
    .map((segment) => segment.replace(/^\w/, (char) => char.toUpperCase()))
    .join(" ");
}
