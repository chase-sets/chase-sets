import { Badge, Page, PageHeader, PageSection } from "@chase-sets/design-system";
import { t } from "@chase-sets/localization";
import type { CatalogScopeRecordDetail } from "../../../../scope-registry/ui/contracts";
import { CatalogIntegrationLanguageEditionsPanel } from "./language-editions/language-editions-panel";
import {
  buildCatalogScopeLanguageEditionReviewReadModel,
  catalogScopeHasLanguageEditionsToReview,
} from "./language-editions/language-edition-review";
import { CatalogScopeJourneyOverviewPanel } from "./scope-journey-overview-panel";
import { buildCatalogScopeJourneyOverviewReadModel } from "./scope-journey-overview";
import type { CatalogAliasReviewReadModel } from "../../../../alias-equivalence/api/alias-review-admin-contracts";
import type { ScopeCoverageMatrix } from "../../../../provider-scope-mapping/ui/contracts";
import { CatalogScopeCoverageMatrixPanel } from "../../../../provider-scope-mapping/ui/scope-coverage-matrix-panel";
import type { CatalogIntegrationsRouteData } from "../../integrations-surface-route-view";
import type { CatalogPrimaryWorkbenchCommandFeedback } from "../../primary-workbench-command-feedback";
import { CatalogCommandFeedbackBanner } from "../../workbench-shell";
import { CatalogIntegrationImportToPromotionWorkspace } from "../import-to-promotion/import-to-promotion-workspace";

// Scope Detail page (v2 control-plane IA: `/scopes/:scopeId`): the whole
// journey for one scope in place. The journey overview maps the scope's path
// from registry to promoted Catalog Items (coverage → sync → live jobs →
// candidate review → promotion) and its current condition; the language-editions
// section runs the alias-equivalence review in place. This page is the real home
// the remaining interactive per-stage command surfaces extend, not a placeholder
// that gets replaced.
export type CatalogScopeDetailPageProps = Readonly<{
  scope: CatalogScopeRecordDetail;
  /** Alias review read model, already scoped to this scope's reference record. */
  languageEditionAliasReview: CatalogAliasReviewReadModel;
  actionHref: string;
  canManageAliases?: boolean;
  /** True when the supplementary alias-review load degraded to an empty model. */
  languageEditionAliasReviewFailed?: boolean;
  /** True while the route is revalidating, so the overview shows its loading state. */
  loading?: boolean;
  /** Injectable clock for the sync-freshness proxy; defaults to now. */
  now?: string;
  coverageMatrix?: ScopeCoverageMatrix | null;
  coverageMatrixFailed?: boolean;
  journey?: CatalogIntegrationsRouteData | null;
  commandFeedback?: CatalogPrimaryWorkbenchCommandFeedback | null;
}>;

export function CatalogScopeDetailPage({
  scope,
  languageEditionAliasReview,
  actionHref,
  canManageAliases = true,
  languageEditionAliasReviewFailed = false,
  loading = false,
  now,
  coverageMatrix = null,
  coverageMatrixFailed = false,
  journey = null,
  commandFeedback = null,
}: CatalogScopeDetailPageProps) {
  const hasLanguageEditions = catalogScopeHasLanguageEditionsToReview(scope);
  const languageEditionsReadModel = hasLanguageEditions
    ? buildCatalogScopeLanguageEditionReviewReadModel({ scope, aliasReview: languageEditionAliasReview })
    : null;

  const journeyOverview = buildCatalogScopeJourneyOverviewReadModel({
    scope,
    languageEditionReview: languageEditionsReadModel,
    languageEditionReviewFailed: languageEditionAliasReviewFailed,
    generatedAt: now ?? new Date().toISOString(),
  });

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

      <PageSection>
        <CatalogScopeJourneyOverviewPanel readModel={journeyOverview} loading={loading} />
      </PageSection>

      <PageSection>
        <CatalogScopeCoverageMatrixPanel
          key={scope.scopeRecordId}
          scopeRecordId={scope.scopeRecordId}
          matrix={coverageMatrix}
          loading={loading}
          failed={coverageMatrixFailed}
        />
      </PageSection>

      {journey ? (
        <PageSection>
          {commandFeedback ? <CatalogCommandFeedbackBanner feedback={commandFeedback} /> : null}
          <CatalogIntegrationImportToPromotionWorkspace
            readModel={journey.readModel}
            commandFeedback={commandFeedback ?? journey.commandFeedback}
            deferredImportPreview={journey.deferredImportPreview ?? null}
            deferredCatalogSyncRun={journey.deferredCatalogSyncRun ?? null}
            deferredScopeSyncState={journey.deferredScopeSyncState ?? null}
            commandActionPath={actionHref}
            showSourceScopeWorkset={false}
          />
        </PageSection>
      ) : null}

      {hasLanguageEditions && languageEditionsReadModel ? (
        <PageSection>
          <CatalogIntegrationLanguageEditionsPanel
            readModel={languageEditionsReadModel}
            actionHref={actionHref}
            canManageAliases={canManageAliases}
          />
        </PageSection>
      ) : null}
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
