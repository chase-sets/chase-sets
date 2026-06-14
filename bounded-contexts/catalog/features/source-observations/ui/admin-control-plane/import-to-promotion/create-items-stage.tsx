import { useState } from "react";
import {
  Badge,
  Checkbox,
  KeyValueList,
  ProgressiveDisclosure,
  WorkbenchActionRow,
  WorkbenchDetailPanel,
  WorkbenchGrid,
  WorkbenchStack,
  WorkbenchText,
} from "@chase-sets/design-system";
import { t } from "@chase-sets/localization";
import type { CatalogPrimaryWorkbenchReadModel } from "../../../api/primary-workbench-admin-contracts";
import { CommandFormButton } from "./command-controls";
import { CatalogIntegrationCommandPlanDetail } from "./command-plan-module";
import { BlockerList, stateLabel } from "./workbench-formatting";

// Stage 3: create / update Catalog Items. The promotion preview is folded into an
// INLINE confirmation of this single action instead of a separate top-level
// "Preview promotion" step that can silently go stale. The operator generates the
// previewed impact, confirms it inline, then commits the create/update in place.
export function CatalogIntegrationCreateItemsStage({
  readModel,
}: Readonly<{
  readModel: CatalogPrimaryWorkbenchReadModel;
}>) {
  const [confirmed, setConfirmed] = useState(false);
  const preview = readModel.promotionPreview;
  const previewFresh = preview.executionSafeguards.previewFresh && preview.previewId !== null;

  return (
    <WorkbenchStack>
      <WorkbenchText size="sm" tone="secondary">
        {t("catalog.features.sourceObservations.ui.primaryWorkbench.stage.create.description")}
      </WorkbenchText>

      <WorkbenchDetailPanel>
        <WorkbenchActionRow align="between">
          <WorkbenchText tone="foreground" weight="semibold">
            {t("catalog.features.sourceObservations.ui.primaryWorkbench.stage.create.preview.title")}
          </WorkbenchText>
          <Badge tone={previewFresh ? "success" : "warning"}>{stateLabel(preview.freshness)}</Badge>
        </WorkbenchActionRow>

        <WorkbenchGrid columns="detail">
          <KeyValueList
            items={[
              {
                key: t("catalog.features.sourceObservations.ui.primaryWorkbench.command.scope"),
                value: preview.scope.label,
              },
              {
                key: t("catalog.features.sourceObservations.ui.primaryWorkbench.eligible.observations"),
                value: preview.scope.eligibleCount,
              },
              {
                key: t("catalog.features.sourceObservations.ui.primaryWorkbench.command.plan"),
                value:
                  preview.commandPlanHash ??
                  t("catalog.features.sourceObservations.ui.primaryWorkbench.review.preview.required"),
              },
            ]}
          />
          <KeyValueList
            items={[
              {
                key: t("catalog.features.sourceObservations.ui.primaryWorkbench.command.count.eligible"),
                value: preview.outcomeCounts.eligible,
              },
              {
                key: t("catalog.features.sourceObservations.ui.primaryWorkbench.command.count.blocked"),
                value: preview.outcomeCounts.blocked,
              },
              {
                key: t("catalog.features.sourceObservations.ui.primaryWorkbench.command.count.conflicting"),
                value: preview.outcomeCounts.conflicting,
              },
            ]}
          />
        </WorkbenchGrid>

        <WorkbenchText size="xs" tone="secondary">
          {t("catalog.features.sourceObservations.ui.primaryWorkbench.stage.create.impact", {
            eligible: preview.dispositions.eligible,
            blocked: preview.dispositions.blocked,
            destructive: preview.destructiveCount,
          })}
        </WorkbenchText>

        <WorkbenchActionRow align="between">
          <WorkbenchText size="xs" tone={previewFresh ? "secondary" : "foreground"} weight="semibold">
            {previewFresh
              ? t("catalog.features.sourceObservations.ui.primaryWorkbench.stage.create.preview.fresh")
              : t("catalog.features.sourceObservations.ui.primaryWorkbench.stage.create.preview.refresh")}
          </WorkbenchText>
          <CommandFormButton readModel={readModel} intent="preview-promotion" size="sm" tone="secondary">
            {t("catalog.features.sourceObservations.ui.primaryWorkbench.preview.promotion")}
          </CommandFormButton>
        </WorkbenchActionRow>

        <Checkbox
          name="confirm-create-items"
          checked={confirmed}
          disabled={!previewFresh}
          onCheckedChange={(checked) => setConfirmed(checked === true)}
          label={t("catalog.features.sourceObservations.ui.primaryWorkbench.stage.create.confirm")}
        />

        <WorkbenchActionRow>
          <CommandFormButton
            readModel={readModel}
            intent="execute-promotion"
            leadingIcon="check"
            disabled={!previewFresh || !confirmed}
          >
            {t("catalog.features.sourceObservations.ui.primaryWorkbench.stage.create.commit")}
          </CommandFormButton>
        </WorkbenchActionRow>

        <BlockerList blockers={preview.blockers} hideWhenEmpty />
      </WorkbenchDetailPanel>

      <ProgressiveDisclosure
        title={t("catalog.features.sourceObservations.ui.primaryWorkbench.stage.supporting.command.plan")}
        icon="dashboard"
      >
        <CatalogIntegrationCommandPlanDetail readModel={readModel} />
      </ProgressiveDisclosure>
    </WorkbenchStack>
  );
}
