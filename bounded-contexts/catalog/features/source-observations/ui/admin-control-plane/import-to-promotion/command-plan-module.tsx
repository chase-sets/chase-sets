import {
  Badge,
  KeyValueList,
  WorkbenchActionRow,
  WorkbenchGrid,
  WorkbenchStack,
  WorkbenchText,
} from "@chase-sets/design-system";
import { t } from "@chase-sets/localization";
import type { CatalogPrimaryWorkbenchReadModel } from "../../../api/primary-workbench-admin-contracts";
import { BlockerList, stateLabel } from "./workbench-formatting";

// Supporting detail for the promotion command plan. Demoted from a co-equal
// top-level module into the "Create / update items" stage disclosure: it explains
// the command plan, stale protections, and recovery decisions, but the execute
// action itself lives inline in the stage's confirmation, not here.
export function CatalogIntegrationCommandPlanDetail({
  readModel,
}: Readonly<{
  readModel: CatalogPrimaryWorkbenchReadModel;
}>) {
  return (
    <WorkbenchStack>
      <WorkbenchActionRow align="between">
        <WorkbenchText element="h3" tone="foreground" weight="semibold">
          {t("catalog.features.sourceObservations.ui.primaryWorkbench.command.plan.title")}
        </WorkbenchText>
        <Badge tone={readModel.promotionPreview.freshness === "stale" ? "warning" : "success"}>
          {stateLabel(readModel.promotionPreview.freshness)}
        </Badge>
      </WorkbenchActionRow>

      <WorkbenchText size="xs" tone="secondary">
        {t("catalog.features.sourceObservations.ui.primaryWorkbench.command.plan.description")}
      </WorkbenchText>

      <WorkbenchGrid columns="detail">
        <KeyValueList
          items={[
            {
              key: t("catalog.features.sourceObservations.ui.primaryWorkbench.command.scope"),
              value: readModel.promotionPreview.scope.label,
            },
            {
              key: t("catalog.features.sourceObservations.ui.primaryWorkbench.command.requested.observations"),
              value: readModel.promotionPreview.scope.requestedCount,
            },
            {
              key: t("catalog.features.sourceObservations.ui.primaryWorkbench.eligible.observations"),
              value: readModel.promotionPreview.scope.eligibleCount,
            },
            {
              key: t("catalog.features.sourceObservations.ui.primaryWorkbench.command.plan"),
              value:
                readModel.promotionPreview.commandPlanHash ??
                t("catalog.features.sourceObservations.ui.primaryWorkbench.review.preview.required"),
            },
            {
              key: t("catalog.features.sourceObservations.ui.primaryWorkbench.command.execution.preview.fresh"),
              value: readModel.promotionPreview.executionSafeguards.previewFresh
                ? t("catalog.features.sourceObservations.ui.primaryWorkbench.ready")
                : t("catalog.features.sourceObservations.ui.primaryWorkbench.review.preview.required"),
            },
          ]}
        />
        <KeyValueList
          items={[
            {
              key: t("catalog.features.sourceObservations.ui.primaryWorkbench.command.count.eligible"),
              value: readModel.promotionPreview.outcomeCounts.eligible,
            },
            {
              key: t("catalog.features.sourceObservations.ui.primaryWorkbench.command.count.blocked"),
              value: readModel.promotionPreview.outcomeCounts.blocked,
            },
            {
              key: t("catalog.features.sourceObservations.ui.primaryWorkbench.command.count.skipped"),
              value: readModel.promotionPreview.outcomeCounts.skipped,
            },
            {
              key: t("catalog.features.sourceObservations.ui.primaryWorkbench.command.count.conflicting"),
              value: readModel.promotionPreview.outcomeCounts.conflicting,
            },
            {
              key: t("catalog.features.sourceObservations.ui.primaryWorkbench.command.count.failed"),
              value: readModel.promotionPreview.outcomeCounts.failed,
            },
          ]}
        />
      </WorkbenchGrid>

      <KeyValueList
        items={[
          {
            key: t("catalog.features.sourceObservations.ui.primaryWorkbench.command.reject.key"),
            value: t("catalog.features.sourceObservations.ui.primaryWorkbench.command.reject.value"),
          },
          {
            key: t("catalog.features.sourceObservations.ui.primaryWorkbench.command.defer.key"),
            value: t("catalog.features.sourceObservations.ui.primaryWorkbench.command.defer.value"),
          },
          {
            key: t("catalog.features.sourceObservations.ui.primaryWorkbench.command.profile.reapply.key"),
            value: t("catalog.features.sourceObservations.ui.primaryWorkbench.command.profile.reapply.value"),
          },
          {
            key: t("catalog.features.sourceObservations.ui.primaryWorkbench.command.profile.replay.key"),
            value: t("catalog.features.sourceObservations.ui.primaryWorkbench.command.profile.replay.value"),
          },
          {
            key: t("catalog.features.sourceObservations.ui.primaryWorkbench.command.execution.stale.guard"),
            value: t("catalog.features.sourceObservations.ui.primaryWorkbench.command.execution.stale.value"),
          },
          {
            key: t("catalog.features.sourceObservations.ui.primaryWorkbench.command.partial.failure.key"),
            value: t("catalog.features.sourceObservations.ui.primaryWorkbench.command.partial.failure.value"),
          },
          {
            key: t("catalog.features.sourceObservations.ui.primaryWorkbench.command.idempotency.key"),
            value: t("catalog.features.sourceObservations.ui.primaryWorkbench.command.idempotency.value"),
          },
        ]}
      />

      <WorkbenchStack gap="sm">
        <WorkbenchText tone="foreground" weight="semibold">
          {t("catalog.features.sourceObservations.ui.primaryWorkbench.table.blockers")}
        </WorkbenchText>
        <BlockerList blockers={readModel.promotionPreview.blockers} />
      </WorkbenchStack>
    </WorkbenchStack>
  );
}
