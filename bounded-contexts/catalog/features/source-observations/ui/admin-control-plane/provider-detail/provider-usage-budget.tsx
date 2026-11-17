import { KeyValueList } from "@chase-sets/design-system";
import { formatDateTime, t } from "@chase-sets/localization";
import type { CatalogPrimaryWorkbenchReadModel } from "../../../api/primary-workbench-admin-contracts";

export function ProviderUsageBudget({
  provider,
}: Readonly<{
  provider: CatalogPrimaryWorkbenchReadModel["healthTriage"]["providers"][number];
}>) {
  const budget = provider.usageBudget;
  const unreported = t("catalog.features.sourceObservations.ui.primaryWorkbench.health.usage.not.reported");
  return (
    <KeyValueList
      density="compact"
      layout="grid"
      items={[
        {
          key: t("catalog.features.sourceObservations.ui.healthFacts.creditBalance"),
          value: budget
            ? `${budget.creditBalance ?? unreported} / ${budget.creditAllowance ?? unreported} / ${budget.creditUnit ?? unreported}`
            : unreported,
        },
        {
          key: t("catalog.features.sourceObservations.ui.primaryWorkbench.health.capability.budget.readiness"),
          value: budget?.readiness ?? "unavailable",
        },
        {
          key: t("catalog.features.sourceObservations.ui.primaryWorkbench.health.capability.usage.freshness"),
          value: budget?.freshness ?? "unavailable",
        },
        {
          key: t("catalog.features.sourceObservations.ui.healthFacts.observedAt"),
          value: budget?.observedAt ? formatDateTime(budget.observedAt) : unreported,
        },
        {
          key: t("catalog.features.sourceObservations.ui.primaryWorkbench.health.capability.usage.lag"),
          value: budget?.lagCategory ?? unreported,
        },
        {
          key: t("catalog.features.sourceObservations.ui.primaryWorkbench.health.capability.usage.diagnostic"),
          value: budget?.diagnostic ?? unreported,
        },
        {
          key: t("catalog.features.sourceObservations.ui.healthFacts.diagnosticCodes"),
          value: budget?.diagnosticCode ?? unreported,
        },
        {
          key: t("catalog.features.sourceObservations.ui.primaryWorkbench.health.capability.estimated.calls"),
          value: budget?.estimatedCalls === null || !budget ? unreported : String(budget.estimatedCalls),
        },
        {
          key: t("catalog.features.sourceObservations.ui.healthFacts.estimatedScope"),
          value: budget?.estimatedScope ?? unreported,
        },
        {
          key: t("catalog.features.scopeSyncBatches.count.spend"),
          value: provider.countSpend?.length
            ? provider.countSpend
                .map(
                  (spend) =>
                    `${spend.kind}: ${spend.credits} / ${spend.outcome} / ${spend.observedAt ?? unreported} / ${spend.expiresAt ?? unreported}`,
                )
                .join("; ")
            : t("catalog.features.scopeSyncBatches.count.unobserved"),
        },
      ]}
    />
  );
}
