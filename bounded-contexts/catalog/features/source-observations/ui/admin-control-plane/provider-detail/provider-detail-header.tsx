import {
  Badge,
  BadgeCluster,
  KeyValueList,
  OperationalStatusBanner,
  WorkbenchStack,
  WorkflowModule,
} from "@chase-sets/design-system";
import { t } from "@chase-sets/localization";
import type { CatalogPrimaryWorkbenchReadModel } from "../../../api/primary-workbench-admin-contracts";
import { stateLabel } from "../import-to-promotion/workbench-formatting";

type BadgeTone = "success" | "warning" | "danger" | "neutral" | "info" | "accent";

// Identity + credential/transport readiness header for the v2 Provider detail
// page. Health-triage's provider/unit rows already carry the same
// credential and transport blocker facts the deprecated health-triage workspace
// rendered as a standalone destination — the blueprint folds that transport
// readiness into the provider header instead ("fix in place", never a detour).
export function ProviderDetailHeader({
  readModel,
  providerKey,
}: Readonly<{
  readModel: CatalogPrimaryWorkbenchReadModel;
  providerKey: string | null;
}>) {
  const providerRow = providerKey
    ? readModel.healthTriage.providers.find((provider) => provider.providerKey === providerKey)
    : null;
  const units = providerKey ? readModel.healthTriage.units.filter((unit) => unit.providerKey === providerKey) : [];
  const blockedUnits = units.filter((unit) => unit.status === "blocked").length;

  if (!providerKey) {
    return (
      <OperationalStatusBanner
        tone="warning"
        title={t("catalog.features.sourceObservations.ui.providerDetail.header.missing.title")}
        description={t("catalog.features.sourceObservations.ui.providerDetail.header.missing.description")}
      />
    );
  }

  return (
    <WorkflowModule
      title={providerRow?.providerKey ?? providerKey}
      description={t("catalog.features.sourceObservations.ui.providerDetail.header.description")}
      status={
        <BadgeCluster
          items={[
            {
              key: "status",
              label: providerRow ? stateLabel(providerRow.status) : stateLabel("unavailable"),
              tone: providerStatusTone(providerRow?.status ?? "unavailable"),
            },
            {
              key: "credential",
              label:
                providerRow?.credentialReadinessState ??
                t("catalog.features.sourceObservations.ui.primaryWorkbench.not.selected"),
              tone: readinessTone(providerRow?.credentialReadiness ?? "unknown"),
            },
          ]}
        />
      }
      headingLevel={2}
    >
      <WorkbenchStack>
        <OperationalStatusBanner
          tone={headerTone(providerRow?.status ?? "unavailable")}
          title={headerTitle(providerRow?.status ?? "unavailable")}
          description={t("catalog.features.sourceObservations.ui.providerDetail.header.units", {
            count: String(units.length),
            blocked: String(blockedUnits),
          })}
        />
        <KeyValueList
          density="compact"
          layout="grid"
          items={[
            {
              key: t("catalog.features.sourceObservations.ui.primaryWorkbench.health.capability.api"),
              value:
                providerRow?.apiReachability ??
                t("catalog.features.sourceObservations.ui.primaryWorkbench.not.selected"),
            },
            {
              key: t("catalog.features.sourceObservations.ui.primaryWorkbench.health.capability.options"),
              value:
                providerRow?.optionQueryHealth ??
                t("catalog.features.sourceObservations.ui.primaryWorkbench.not.selected"),
            },
            {
              key: t("catalog.features.sourceObservations.ui.primaryWorkbench.health.capability.rate.limit"),
              value:
                providerRow?.rateLimitStatus ??
                t("catalog.features.sourceObservations.ui.primaryWorkbench.not.selected"),
            },
            {
              key: t("catalog.features.sourceObservations.ui.primaryWorkbench.health.capability.payload"),
              value:
                providerRow?.payloadAcquisition ??
                t("catalog.features.sourceObservations.ui.primaryWorkbench.not.selected"),
            },
          ]}
        />
      </WorkbenchStack>
    </WorkflowModule>
  );
}

function providerStatusTone(status: string): BadgeTone {
  if (status === "ready") return "success";
  if (status === "blocked" || status === "unavailable") return "danger";
  return "warning";
}

function readinessTone(status: string): BadgeTone {
  if (status === "ready" || status === "configured") return "success";
  if (status === "blocked" || status === "missing" || status === "invalid" || status === "expired") return "danger";
  if (status === "degraded" || status === "unknown") return "warning";
  return "neutral";
}

function headerTone(status: string): "success" | "danger" | "warning" {
  if (status === "ready") return "success";
  if (status === "blocked" || status === "unavailable") return "danger";
  return "warning";
}

function headerTitle(status: string): string {
  if (status === "ready") {
    return t("catalog.features.sourceObservations.ui.providerDetail.header.ready.title");
  }
  if (status === "blocked" || status === "unavailable") {
    return t("catalog.features.sourceObservations.ui.providerDetail.header.blocked.title");
  }
  return t("catalog.features.sourceObservations.ui.providerDetail.header.degraded.title");
}
