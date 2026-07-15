import { t } from "@chase-sets/localization";
import { EntityDetailPage } from "../../../support/shell-support/ui/entity-detail-page";
import { toCatalogAdminHref } from "../../../support/shell-support/ui/catalog-admin-hrefs";
import type { ScopeCoverageMatrix } from "./contracts";
import { CatalogScopeCoverageMatrixPanel } from "./scope-coverage-matrix-panel";

export function ScopeCoverageDetailPage({
  scopeRecordId,
  initialData,
}: {
  scopeRecordId: string;
  initialData?: ScopeCoverageMatrix | null;
}) {
  return (
    <EntityDetailPage
      title={
        initialData?.scopeName ?? t("catalog.features.providerScopeMapping.ui.scopeCoverageDetailPage.scope.coverage")
      }
      breadcrumbs={[
        {
          label: t("catalog.features.providerScopeMapping.ui.scopeCoverageDetailPage.unmapped.scope.inbox"),
          href: toCatalogAdminHref("/scope-coverage"),
        },
        { label: initialData?.scopeName ?? scopeRecordId },
      ]}
      loading={false}
      notFound={false}
      error={null}
    >
      <CatalogScopeCoverageMatrixPanel
        key={scopeRecordId}
        scopeRecordId={scopeRecordId}
        matrix={initialData ?? null}
        failed={initialData === null}
      />
    </EntityDetailPage>
  );
}
