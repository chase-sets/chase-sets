import { t } from "@chase-sets/localization";
import type { MetaFunction } from "react-router";
import { useLoaderData } from "react-router";
import { CatalogScopeDetailPage } from "../../features/source-observations/ui/admin-control-plane/scope-detail/scope-detail-page";
import { loader } from "../../support/route-support/admin-scope-detail/scope-detail-loader";

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
  const { scope, languageEditionAliasReview, canManageAliases } = useLoaderData<typeof loader>();

  return (
    <CatalogScopeDetailPage
      scope={scope}
      languageEditionAliasReview={languageEditionAliasReview}
      actionHref={`/catalog/scopes/${scope.scopeRecordId}`}
      canManageAliases={canManageAliases}
    />
  );
}
