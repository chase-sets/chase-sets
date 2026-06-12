import { LinkButton, OperationalStatusBanner } from "@chase-sets/design-system";
import { t } from "@chase-sets/localization";
import type { CatalogPrimaryWorkbenchReadModel } from "../../../api/primary-workbench-admin-contracts";
import { catalogPrimaryWorkbenchSupportingHref } from "../../primary-workbench-route-context";
import { CatalogIntegrationImportJobsModule } from "../import-jobs/import-jobs-module";
import { CatalogIntegrationSourceObservationReviewModule } from "../source-observation-review/source-observation-review-module";
import { CatalogIntegrationCommandPlanModule } from "./command-plan-module";
import { CatalogIntegrationPrimaryStepsModule } from "./primary-steps-module";
import { useImportToPromotionWorkspace } from "./use-import-to-promotion-workspace";

export function CatalogIntegrationImportToPromotionWorkspace({
  readModel,
}: Readonly<{
  readModel: CatalogPrimaryWorkbenchReadModel;
}>) {
  const {
    steps,
    selectableStepKeys,
    selectedKeys,
    setSelectedKeys,
    selectedCount,
    selectedObservationKeys,
    setSelectedObservationKeys,
    selectedEligibleObservationCount,
    selectedReviewableObservationCount,
  } = useImportToPromotionWorkspace(readModel);

  return (
    <>
      <OperationalStatusBanner
        tone={readModel.readiness.blockers.length > 0 ? "warning" : "success"}
        title={
          readModel.readiness.blockers.length > 0
            ? t("catalog.features.sourceObservations.ui.primaryWorkbench.banner.blocked.title")
            : t("catalog.features.sourceObservations.ui.primaryWorkbench.banner.ready.title")
        }
        description={
          readModel.readiness.blockers.length > 0
            ? t("catalog.features.sourceObservations.ui.primaryWorkbench.banner.blocked.description")
            : t("catalog.features.sourceObservations.ui.primaryWorkbench.banner.ready.description")
        }
        action={
          <LinkButton
            size="sm"
            tone="secondary"
            leadingIcon="externalLink"
            href={
              readModel.readiness.auditEvidenceUrl ??
              catalogPrimaryWorkbenchSupportingHref(readModel.routeContext, "audit-evidence")
            }
          >
            {t("catalog.features.sourceObservations.ui.primaryWorkbench.view.supporting.evidence")}
          </LinkButton>
        }
      />

      <CatalogIntegrationPrimaryStepsModule
        readModel={readModel}
        steps={steps}
        selectableStepKeys={selectableStepKeys}
        selectedKeys={selectedKeys}
        onSelectedKeysChange={setSelectedKeys}
        selectedCount={selectedCount}
      />

      <CatalogIntegrationImportJobsModule readModel={readModel} />

      <CatalogIntegrationSourceObservationReviewModule
        readModel={readModel}
        selectedObservationKeys={selectedObservationKeys}
        onSelectedObservationKeysChange={setSelectedObservationKeys}
        selectedEligibleObservationCount={selectedEligibleObservationCount}
        selectedReviewableObservationCount={selectedReviewableObservationCount}
      />

      <CatalogIntegrationCommandPlanModule readModel={readModel} />
    </>
  );
}
