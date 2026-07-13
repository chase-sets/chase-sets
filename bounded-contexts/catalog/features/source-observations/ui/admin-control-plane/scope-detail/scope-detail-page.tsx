import { Badge, Banner, Page, PageHeader, PageSection } from "@chase-sets/design-system";
import { t } from "@chase-sets/localization";
import type { CatalogScopeRecordDetail } from "../../../../scope-registry/ui/contracts";
import { CatalogIntegrationLanguageEditionsPanel } from "./language-editions/language-editions-panel";
import {
  buildCatalogScopeLanguageEditionReviewReadModel,
  catalogScopeHasLanguageEditionsToReview,
} from "./language-editions/language-edition-review";
import type { CatalogAliasReviewReadModel } from "../../../../alias-equivalence/api/alias-review-admin-contracts";

// Scope Detail page (v2 control-plane IA: `/scopes/:scopeId`): the whole
// journey for one scope in place. This slice ships the language-editions
// section, the first piece of the fuller scope-detail journey (coverage
// matrix → sync → jobs → candidate review → promotion), which lands in later
// slices. This page composes only the header and the language-editions
// section today; it is the real home those slices extend, not a placeholder
// page that gets replaced.
export type CatalogScopeDetailPageProps = Readonly<{
  scope: CatalogScopeRecordDetail;
  /** Alias review read model, already scoped to this scope's reference record. */
  languageEditionAliasReview: CatalogAliasReviewReadModel;
  actionHref: string;
  canManageAliases?: boolean;
}>;

export function CatalogScopeDetailPage({
  scope,
  languageEditionAliasReview,
  actionHref,
  canManageAliases = true,
}: CatalogScopeDetailPageProps) {
  const hasLanguageEditions = catalogScopeHasLanguageEditionsToReview(scope);
  const languageEditionsReadModel = hasLanguageEditions
    ? buildCatalogScopeLanguageEditionReviewReadModel({ scope, aliasReview: languageEditionAliasReview })
    : null;

  return (
    <Page>
      <PageHeader
        eyebrow={t("catalog.features.sourceObservations.ui.scopeDetail.eyebrow", {
          productDomain: scope.productDomain,
          scopeKind: scope.scopeKind,
        })}
        title={scope.name}
        description={t("catalog.features.sourceObservations.ui.scopeDetail.description")}
        actions={<Badge tone={lifecycleTone(scope.lifecycleStatus)}>{scope.lifecycleStatus}</Badge>}
      />

      {hasLanguageEditions && languageEditionsReadModel ? (
        <PageSection>
          <CatalogIntegrationLanguageEditionsPanel
            readModel={languageEditionsReadModel}
            actionHref={actionHref}
            canManageAliases={canManageAliases}
          />
        </PageSection>
      ) : null}

      <PageSection>
        <Banner
          tone="info"
          title={t("catalog.features.sourceObservations.ui.scopeDetail.journeyPending.title")}
          description={t("catalog.features.sourceObservations.ui.scopeDetail.journeyPending.description")}
        />
      </PageSection>
    </Page>
  );
}

function lifecycleTone(lifecycleStatus: string): "success" | "warning" | "neutral" {
  switch (lifecycleStatus) {
    case "active":
      return "success";
    case "draft":
      return "warning";
    default:
      return "neutral";
  }
}
