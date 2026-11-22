import { t } from "@chase-sets/localization";
import type { MetaFunction } from "react-router";
import { useActionData, useLoaderData, useNavigation } from "react-router";
import { CatalogScopeDetailPage } from "../../features/source-observations/ui/admin-control-plane/scope-detail/scope-detail-page";
import { loader } from "../../support/route-support/admin-scope-detail/scope-detail-loader";
import type { action as scopeDetailAction } from "../../support/route-support/admin-scope-detail/scope-detail-action";
import { useOriginalPromotionReceipt } from "../../features/source-observations/ui/integrations-surface-route-view";

export { loader } from "../../support/route-support/admin-scope-detail/scope-detail-loader";
export { action } from "../../support/route-support/admin-scope-detail/scope-detail-action";
export { catalogPrimaryWorkbenchSourceOptionShouldRevalidate as shouldRevalidate } from "../../features/source-observations/ui/primary-workbench-source-option-refresh";

export const meta: MetaFunction<typeof loader> = ({ data }) => [
  { title: data ? `${data.scope.name} | Catalog Admin` : t("catalog.routes.admin.scopeDetail.scope.catalog.admin") },
];

// Scope Detail page (`/catalog/scopes/:id`, v2 control-plane IA). Thin
// composition root: it re-exports the loader/action and renders the scope
// page. Every Scope form POSTs here: a queued job redirects back to this page
// with its checkpoints, and every other result renders in place as action data.
export default function ScopeDetailRoute() {
  const {
    scope,
    languageEditions,
    journeyOverview,
    canManageAliases,
    coverageMatrix,
    coverageMatrixFailed,
    journey,
    candidateReviewJobs,
    candidateReviewJobsCursor,
  } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof scopeDetailAction>();
  const navigation = useNavigation();
  const commandResult = actionData && "feedback" in actionData ? actionData : null;
  const journeyReadModel = useOriginalPromotionReceipt(journey, commandResult, navigation.state !== "idle");

  return (
    <CatalogScopeDetailPage
      scope={scope}
      languageEditions={languageEditions}
      journeyOverview={journeyOverview}
      actionHref={`/catalog/scopes/${scope.scopeRecordId}`}
      canManageAliases={canManageAliases}
      loading={navigation.state !== "idle"}
      coverageMatrix={coverageMatrix}
      coverageMatrixFailed={coverageMatrixFailed}
      journey={{ ...journey, readModel: journeyReadModel }}
      commandFeedback={commandResult?.feedback ?? null}
      candidateReviewJobs={candidateReviewJobs}
      candidateReviewJobsCursor={candidateReviewJobsCursor}
    />
  );
}
