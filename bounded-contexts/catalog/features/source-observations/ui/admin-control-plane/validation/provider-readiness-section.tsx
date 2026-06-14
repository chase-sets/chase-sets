import {
  Badge,
  KeyValueList,
  OperationalStatusBanner,
  WorkbenchStack,
  WorkbenchText,
  WorkflowModule,
} from "@chase-sets/design-system";
import { t } from "@chase-sets/localization";
import type {
  CatalogPrimaryWorkbenchBlockerCategory,
  CatalogPrimaryWorkbenchProviderTransportCategory,
  CatalogPrimaryWorkbenchReadModel,
} from "../../../api/primary-workbench-admin-contracts";
import {
  catalogPrimaryWorkbenchProviderTransportSummary,
  getCatalogPrimaryWorkbenchBlockerCopy,
  getCatalogPrimaryWorkbenchProviderTransportCopy,
} from "../../primary-workbench-copy";
import { statusLabel, type BadgeTone } from "./validation-shared";

const credentialBlockerCategories = [
  "provider-credential-missing",
  "provider-credential-invalid",
  "provider-credential-expired",
] as const satisfies readonly CatalogPrimaryWorkbenchBlockerCategory[];

type ProviderReadinessState = "ready" | "blocked" | "degraded";

export function ProviderReadinessSection({ readModel }: { readModel: CatalogPrimaryWorkbenchReadModel }) {
  const readiness = readModel.readiness;
  const scopeReadiness = readModel.importJobs.selectedScope?.readiness ?? null;
  const transport = uniqueTransport(readiness.providerTransport);
  const credentialBlockers = readiness.blockers.filter((blocker) =>
    (credentialBlockerCategories as readonly string[]).includes(blocker),
  );
  const state = providerReadinessState(transport.length, credentialBlockers.length);

  return (
    <WorkflowModule
      title={t("catalog.features.sourceObservations.ui.primaryWorkbench.validation.provider.title")}
      description={t("catalog.features.sourceObservations.ui.primaryWorkbench.validation.provider.description")}
      status={<Badge tone={stateTone(state)}>{statusLabel(state)}</Badge>}
      headingLevel={2}
      density="compact"
    >
      <WorkbenchStack>
        <OperationalStatusBanner
          tone={state === "blocked" ? "danger" : state === "degraded" ? "warning" : "success"}
          title={providerBannerTitle(state)}
          description={providerBannerDescription(state)}
        />
        <KeyValueList
          density="compact"
          items={[
            {
              key: t("catalog.features.sourceObservations.ui.primaryWorkbench.validation.provider.adapter"),
              value: scopeReadiness
                ? statusLabel(scopeReadiness.adapterReadiness)
                : t("catalog.features.sourceObservations.ui.primaryWorkbench.validation.provider.noScope"),
            },
            {
              key: t("catalog.features.sourceObservations.ui.primaryWorkbench.validation.provider.credential"),
              value: scopeReadiness
                ? statusLabel(scopeReadiness.credentialReadiness)
                : t("catalog.features.sourceObservations.ui.primaryWorkbench.validation.provider.noScope"),
            },
            {
              key: t("catalog.features.sourceObservations.ui.primaryWorkbench.validation.provider.transport"),
              value:
                transport.length > 0
                  ? catalogPrimaryWorkbenchProviderTransportSummary(transport)
                  : t("catalog.features.sourceObservations.ui.primaryWorkbench.validation.provider.transportReady"),
            },
          ]}
        />
        <ProviderRemediationList transport={transport} credentialBlockers={credentialBlockers} />
      </WorkbenchStack>
    </WorkflowModule>
  );
}

function ProviderRemediationList({
  transport,
  credentialBlockers,
}: {
  transport: readonly CatalogPrimaryWorkbenchProviderTransportCategory[];
  credentialBlockers: readonly CatalogPrimaryWorkbenchBlockerCategory[];
}) {
  if (transport.length === 0 && credentialBlockers.length === 0) {
    return (
      <WorkbenchText size="xs" tone="tertiary">
        {t("catalog.features.sourceObservations.ui.primaryWorkbench.validation.provider.noRemediation")}
      </WorkbenchText>
    );
  }

  return (
    <WorkbenchStack gap="sm">
      <WorkbenchText tone="foreground" weight="semibold">
        {t("catalog.features.sourceObservations.ui.primaryWorkbench.validation.provider.remediation")}
      </WorkbenchText>
      {credentialBlockers.map((blocker) => {
        const remediation = getCatalogPrimaryWorkbenchBlockerCopy(blocker);
        return (
          <KeyValueList
            key={blocker}
            density="compact"
            variant="surface"
            items={[
              { key: remediation.label, value: remediation.reason },
              {
                key: t("catalog.features.sourceObservations.ui.primaryWorkbench.validation.provider.nextStep"),
                value: remediation.nextStep,
              },
            ]}
          />
        );
      })}
      {transport.map((category) => {
        const remediation = getCatalogPrimaryWorkbenchProviderTransportCopy(category);
        return (
          <KeyValueList
            key={category}
            density="compact"
            variant="surface"
            items={[
              { key: remediation.label, value: remediation.reason },
              {
                key: t("catalog.features.sourceObservations.ui.primaryWorkbench.validation.provider.nextStep"),
                value: remediation.nextStep,
              },
            ]}
          />
        );
      })}
    </WorkbenchStack>
  );
}

function uniqueTransport(
  categories: readonly CatalogPrimaryWorkbenchProviderTransportCategory[],
): readonly CatalogPrimaryWorkbenchProviderTransportCategory[] {
  return [...new Set(categories)];
}

function providerReadinessState(transportCount: number, credentialBlockerCount: number): ProviderReadinessState {
  if (credentialBlockerCount > 0) {
    return "blocked";
  }
  if (transportCount > 0) {
    return "degraded";
  }
  return "ready";
}

function providerBannerTitle(state: ProviderReadinessState): string {
  if (state === "blocked") {
    return t("catalog.features.sourceObservations.ui.primaryWorkbench.validation.provider.banner.blocked.title");
  }
  if (state === "degraded") {
    return t("catalog.features.sourceObservations.ui.primaryWorkbench.validation.provider.banner.degraded.title");
  }
  return t("catalog.features.sourceObservations.ui.primaryWorkbench.validation.provider.banner.ready.title");
}

function providerBannerDescription(state: ProviderReadinessState): string {
  if (state === "blocked") {
    return t("catalog.features.sourceObservations.ui.primaryWorkbench.validation.provider.banner.blocked.description");
  }
  if (state === "degraded") {
    return t("catalog.features.sourceObservations.ui.primaryWorkbench.validation.provider.banner.degraded.description");
  }
  return t("catalog.features.sourceObservations.ui.primaryWorkbench.validation.provider.banner.ready.description");
}

function stateTone(state: ProviderReadinessState): BadgeTone {
  if (state === "ready") return "success";
  if (state === "blocked") return "danger";
  return "warning";
}
