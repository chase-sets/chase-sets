import {
  Badge,
  KeyValueList,
  WorkbenchGrid,
  WorkbenchStack,
  WorkbenchText,
  WorkflowModule,
  WorkflowReadinessChecklist,
  type WorkflowReadinessItem,
} from "@chase-sets/design-system";
import { t } from "@chase-sets/localization";
import type { CatalogPrimaryWorkbenchReadModel } from "../../../api/primary-workbench-admin-contracts";
import { catalogPrimaryWorkbenchProviderTransportSummary } from "../../primary-workbench-copy";
import { CommandFormButton } from "./command-controls";
import { BlockerList, stateLabel } from "./workbench-formatting";

export function CatalogIntegrationCommandPlanModule({
  readModel,
}: Readonly<{
  readModel: CatalogPrimaryWorkbenchReadModel;
}>) {
  return (
    <>
      <WorkflowModule
        title={t("catalog.features.sourceObservations.ui.primaryWorkbench.command.plan.title")}
        description={t("catalog.features.sourceObservations.ui.primaryWorkbench.command.plan.description")}
        status={
          <Badge tone={readModel.promotionPreview.freshness === "stale" ? "warning" : "success"}>
            {stateLabel(readModel.promotionPreview.freshness)}
          </Badge>
        }
        actions={
          <CommandFormButton readModel={readModel} intent="execute-promotion" size="sm" leadingIcon="check">
            {t("catalog.features.sourceObservations.ui.primaryWorkbench.promote.catalog.facts")}
          </CommandFormButton>
        }
        headingLevel={2}
        density="compact"
      >
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
      </WorkflowModule>

      <WorkbenchGrid columns="detail">
        <WorkflowModule
          title={t("catalog.features.sourceObservations.ui.primaryWorkbench.readiness.recovery.title")}
          description={t("catalog.features.sourceObservations.ui.primaryWorkbench.readiness.recovery.description")}
          density="compact"
          status={
            <Badge tone={readModel.readiness.blockers.length > 0 ? "warning" : "success"}>
              {t("catalog.features.sourceObservations.ui.primaryWorkbench.readiness")}
            </Badge>
          }
        >
          <WorkflowReadinessChecklist items={readinessItems(readModel)} />
        </WorkflowModule>

        <WorkflowModule
          title={t("catalog.features.sourceObservations.ui.primaryWorkbench.context.preservation.title")}
          description={t("catalog.features.sourceObservations.ui.primaryWorkbench.context.preservation.description")}
          density="compact"
          status={<Badge tone="info">#1057 handoff</Badge>}
        >
          <KeyValueList
            items={[
              {
                key: t("catalog.features.sourceObservations.ui.primaryWorkbench.key.provider"),
                value:
                  readModel.routeContext.providerKey ??
                  t("catalog.features.sourceObservations.ui.primaryWorkbench.not.selected"),
              },
              {
                key: t("catalog.features.sourceObservations.ui.primaryWorkbench.key.unit"),
                value:
                  readModel.routeContext.unitKey ??
                  t("catalog.features.sourceObservations.ui.primaryWorkbench.not.selected"),
              },
              {
                key: t("catalog.features.sourceObservations.ui.primaryWorkbench.key.selected.observations"),
                value: readModel.routeContext.selectedObservationIds.length,
              },
              {
                key: t("catalog.features.sourceObservations.ui.primaryWorkbench.key.promotion.preview"),
                value:
                  readModel.routeContext.promotionPreviewId ??
                  t("catalog.features.sourceObservations.ui.primaryWorkbench.not.queued"),
              },
              {
                key: t("catalog.features.sourceObservations.ui.primaryWorkbench.key.return.path"),
                value:
                  readModel.routeContext.returnPath ??
                  t("catalog.features.sourceObservations.ui.primaryWorkbench.primary.workbench"),
              },
            ]}
          />
        </WorkflowModule>
      </WorkbenchGrid>
    </>
  );
}

function readinessItems(readModel: CatalogPrimaryWorkbenchReadModel): readonly WorkflowReadinessItem[] {
  return [
    {
      key: "rbac",
      label: t("catalog.features.sourceObservations.ui.primaryWorkbench.readiness.rbac.label"),
      status: readModel.readiness.rbacAllowed && readModel.readiness.rolloutEnabled ? "passed" : "blocked",
      statusLabel:
        readModel.readiness.rbacAllowed && readModel.readiness.rolloutEnabled
          ? t("catalog.features.sourceObservations.ui.primaryWorkbench.ready")
          : t("catalog.features.sourceObservations.ui.primaryWorkbench.blocked"),
      description: t("catalog.features.sourceObservations.ui.primaryWorkbench.readiness.rbac.description"),
    },
    {
      key: "transport",
      label: t("catalog.features.sourceObservations.ui.primaryWorkbench.readiness.transport.label"),
      status: readModel.readiness.providerTransport.length > 0 ? "warning" : "passed",
      statusLabel:
        readModel.readiness.providerTransport.length > 0
          ? t("catalog.features.sourceObservations.ui.primaryWorkbench.degraded")
          : t("catalog.features.sourceObservations.ui.primaryWorkbench.ready"),
      description:
        readModel.readiness.providerTransport.length > 0
          ? catalogPrimaryWorkbenchProviderTransportSummary(readModel.readiness.providerTransport)
          : t("catalog.features.sourceObservations.ui.primaryWorkbench.readiness.transport.ready.description"),
    },
    {
      key: "redaction",
      label: t("catalog.features.sourceObservations.ui.primaryWorkbench.readiness.redaction.label"),
      status: readModel.securityPrivacy.redactionApplied ? "passed" : "blocked",
      statusLabel: readModel.securityPrivacy.redactionApplied
        ? t("catalog.features.sourceObservations.ui.primaryWorkbench.applied")
        : t("catalog.features.sourceObservations.ui.primaryWorkbench.blocked"),
      description: t("catalog.features.sourceObservations.ui.primaryWorkbench.readiness.redaction.description"),
    },
    {
      key: "deploy-skew",
      label: t("catalog.features.sourceObservations.ui.primaryWorkbench.readiness.deploy.skew.label"),
      status: readModel.deploySkew.supported ? "passed" : "blocked",
      statusLabel: readModel.deploySkew.supported
        ? t("catalog.features.sourceObservations.ui.primaryWorkbench.current")
        : t("catalog.features.sourceObservations.ui.primaryWorkbench.fail.closed"),
      description: t("catalog.features.sourceObservations.ui.primaryWorkbench.readiness.deploy.skew.description"),
    },
  ];
}
