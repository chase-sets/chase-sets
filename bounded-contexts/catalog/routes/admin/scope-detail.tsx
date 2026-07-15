import { t } from "@chase-sets/localization";
import { useEffect } from "react";
import type { MetaFunction } from "react-router";
import { useActionData, useLoaderData, useNavigate, useNavigation } from "react-router";
import { CatalogScopeDetailPage } from "../../features/source-observations/ui/admin-control-plane/scope-detail/scope-detail-page";
import { loader } from "../../support/route-support/admin-scope-detail/scope-detail-loader";
import type { action as scopeDetailAction } from "../../support/route-support/admin-scope-detail/scope-detail-action";
import { commandResultNeedsRoutableHandoff } from "../../support/route-support/admin-integrations/integrations-command-result";
import { scopeDetailCommandHref } from "../../support/route-support/admin-scope-detail/scope-detail-route-context";

export { loader } from "../../support/route-support/admin-scope-detail/scope-detail-loader";
export { action } from "../../support/route-support/admin-scope-detail/scope-detail-action";

export const meta: MetaFunction<typeof loader> = ({ data }) => [
  { title: data ? `${data.scope.name} | Catalog Admin` : t("catalog.routes.admin.scopeDetail.scope.catalog.admin") },
];

// Scope Detail page (`/catalog/scopes/:id`, v2 control-plane IA). Thin
// composition root: it re-exports the loader/action and renders the scope
// page. The language-editions section's accept/reject/defer/revoke forms
// POST here and stay on this page, so the operator sees the result in place.
export default function ScopeDetailRoute() {
  const {
    scope,
    languageEditionAliasReview,
    languageEditionAliasReviewFailed,
    canManageAliases,
    coverageMatrix,
    coverageMatrixFailed,
    journey,
  } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof scopeDetailAction>();
  const navigation = useNavigation();
  const navigate = useNavigate();
  const commandFeedback = actionData && "feedback" in actionData ? actionData.feedback : null;

  useEffect(() => {
    if (actionData && "feedback" in actionData && commandResultNeedsRoutableHandoff(actionData)) {
      navigate(scopeDetailCommandHref(scope.scopeRecordId, actionData.context), { replace: true });
    }
  }, [actionData, navigate, scope.scopeRecordId]);

  return (
    <CatalogScopeDetailPage
      scope={scope}
      languageEditionAliasReview={languageEditionAliasReview}
      languageEditionAliasReviewFailed={languageEditionAliasReviewFailed}
      actionHref={`/catalog/scopes/${scope.scopeRecordId}`}
      canManageAliases={canManageAliases}
      loading={navigation.state !== "idle"}
      coverageMatrix={coverageMatrix}
      coverageMatrixFailed={coverageMatrixFailed}
      journey={journey}
      commandFeedback={commandFeedback}
    />
  );
}
