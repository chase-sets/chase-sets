import { Badge, Page, PageHeader, PageSection, WorkbenchLinkList } from "@chase-sets/design-system";
import { CatalogControlPlaneEvidenceDrawer } from "../evidence/catalog-control-plane-evidence-drawer";
import { CatalogEntityEvidenceLink } from "../evidence/catalog-entity-evidence-link";
import { t } from "@chase-sets/localization";
import type { CatalogScopeRecordDetail } from "../../../../scope-registry/ui/contracts";
import { CatalogIntegrationLanguageEditionsPanel } from "./language-editions/language-editions-panel";
import {
  buildCatalogScopeLanguageEditionReviewReadModel,
  catalogScopeHasLanguageEditionsToReview,
} from "./language-editions/language-edition-review";
import { CatalogScopeJourneyOverviewPanel } from "./scope-journey-overview-panel";
import { ScopeHealth } from "./scope-health";
import { buildCatalogScopeJourneyOverviewReadModel } from "./scope-journey-overview";
import type { CatalogAliasReviewReadModel } from "../../../../alias-equivalence/api/alias-review-admin-contracts";
import type { ScopeCoverageMatrix } from "../../../../provider-scope-mapping/ui/contracts";
import { CatalogScopeCoverageMatrixPanel } from "../../../../provider-scope-mapping/ui/scope-coverage-matrix-panel";
import type { CatalogIntegrationsRouteData } from "../../integrations-surface-route-view";
import type { CatalogPrimaryWorkbenchCommandFeedback } from "../../primary-workbench-command-feedback";
import { CatalogCommandFeedbackBanner } from "../../workbench-shell";
import { CatalogIntegrationImportToPromotionWorkspace } from "../import-to-promotion/import-to-promotion-workspace";
import { CatalogIntegrationCommandActionProvider } from "../import-to-promotion/command-action-context";
import { CatalogImportContextBar } from "../import-to-promotion/import-context-bar";
import { CATALOG_SCOPE_RECORD_QUERY_KEYS } from "../../../api/admin/scope-detail-workbench-location";
import {
  CatalogScopeCandidateReviewJobsPanel,
  candidateReviewJobsPageHref,
  type CatalogScopeCandidateReviewJobs,
} from "./candidate-review-jobs-panel";

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
  coverageMatrix?: ScopeCoverageMatrix | null;
  coverageMatrixFailed?: boolean;
  journey?: CatalogIntegrationsRouteData | null;
  commandFeedback?: CatalogPrimaryWorkbenchCommandFeedback | null;
  candidateReviewJobs?: CatalogScopeCandidateReviewJobs | null;
  /** The completed candidate-review-jobs cursor this page shows; null on the newest page. */
  candidateReviewJobsCursor?: string | null;
}>;

export function CatalogScopeDetailPage({
  scope,
  languageEditionAliasReview,
  actionHref,
  canManageAliases = true,
  languageEditionAliasReviewFailed = false,
  loading = false,
  coverageMatrix = null,
  coverageMatrixFailed = false,
  journey = null,
  commandFeedback = null,
  candidateReviewJobs = null,
  candidateReviewJobsCursor = null,
}: CatalogScopeDetailPageProps) {
  const hasLanguageEditions = catalogScopeHasLanguageEditionsToReview(scope);
  const languageEditionsReadModel = hasLanguageEditions
    ? buildCatalogScopeLanguageEditionReviewReadModel({ scope, aliasReview: languageEditionAliasReview })
    : null;

  const journeyOverview = buildCatalogScopeJourneyOverviewReadModel({
    scope,
    languageEditionReview: languageEditionsReadModel,
    languageEditionReviewFailed: languageEditionAliasReviewFailed,
  });
  // A result kept as action data, else the feedback a queued-job redirect carried.
  const journeyFeedback = commandFeedback ?? journey?.commandFeedback ?? null;

  // Every command control on this page, the journey's and the language editions',
  // targets this Scope through one owner.
  return (
    <CatalogIntegrationCommandActionProvider actionPath={actionHref}>
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
            <ScopeHealth
              readModel={journey.readModel}
              scopeRecordId={scope.scopeRecordId}
              requestUrl={journey.requestUrl}
              actionHref={actionHref}
              loading={loading}
            />
            <WorkbenchLinkList>
              <CatalogEntityEvidenceLink
                location={journey.requestUrl}
                reference={{ kind: "scope", id: scope.scopeRecordId }}
              />
              {journey.readModel.mergeCandidateReview.rows.map((row) => (
                <CatalogEntityEvidenceLink
                  key={row.candidateId}
                  location={journey.requestUrl}
                  reference={{ kind: "candidate", id: row.candidateId }}
                />
              ))}
              {[
                ...new Set(
                  journey.readModel.mergeCandidateReview.rows.flatMap((row) =>
                    row.proposedMapping.catalogItemId ? [row.proposedMapping.catalogItemId] : [],
                  ),
                ),
              ].map((id) => (
                <CatalogEntityEvidenceLink
                  key={id}
                  location={journey.requestUrl}
                  reference={{ kind: "catalog-item", id }}
                />
              ))}
              {journey.readModel.sourceObservationReview.rows.map((row) => (
                <CatalogEntityEvidenceLink
                  key={row.observationId}
                  location={journey.requestUrl}
                  reference={{ kind: "source-observation", id: row.observationId }}
                />
              ))}
              {journey.readModel.importJobs.jobs.map((row) => (
                <CatalogEntityEvidenceLink
                  key={row.jobId}
                  location={journey.requestUrl}
                  reference={{ kind: "import-job", id: row.jobId }}
                />
              ))}
            </WorkbenchLinkList>
            {journey.readModel.routeContext.evidenceRef ? (
              <CatalogControlPlaneEvidenceDrawer
                key={journey.readModel.routeContext.evidenceRef}
                auditEvidence={journey.readModel.auditEvidence}
              />
            ) : null}
            {journeyFeedback ? <CatalogCommandFeedbackBanner feedback={journeyFeedback} /> : null}
            {/* The import context keeps the record's hierarchy fixed and carries
              the provider/unit/profile choice in the Scope's address. */}
            <CatalogImportContextBar
              readModel={journey.readModel}
              deferredSourceOptions={journey.deferredSourceOptions ?? null}
              recordOwnedFieldNames={CATALOG_SCOPE_RECORD_QUERY_KEYS}
            />
            <CatalogIntegrationImportToPromotionWorkspace
              readModel={journey.readModel}
              commandFeedback={journeyFeedback}
              deferredSourceOptions={journey.deferredSourceOptions ?? null}
              deferredImportPreview={journey.deferredImportPreview ?? null}
              deferredCatalogSyncRun={journey.deferredCatalogSyncRun ?? null}
              deferredScopeSyncState={journey.deferredScopeSyncState ?? null}
              showSourceScopeWorkset
            />
          </PageSection>
        ) : null}

        {candidateReviewJobs ? (
          <PageSection>
            <CatalogScopeCandidateReviewJobsPanel
              jobs={candidateReviewJobs}
              nextPageHref={
                candidateReviewJobs.completed.cursor
                  ? candidateReviewJobsPageHref(actionHref, candidateReviewJobs.completed.cursor)
                  : null
              }
              firstPageHref={candidateReviewJobsCursor ? actionHref : null}
            />
          </PageSection>
        ) : null}

        {hasLanguageEditions && languageEditionsReadModel ? (
          <PageSection>
            <CatalogIntegrationLanguageEditionsPanel
              readModel={languageEditionsReadModel}
              routeContext={journey?.readModel.routeContext ?? null}
              canManageAliases={canManageAliases}
            />
          </PageSection>
        ) : null}
      </Page>
    </CatalogIntegrationCommandActionProvider>
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
