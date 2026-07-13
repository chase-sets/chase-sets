import { t } from "@chase-sets/localization";
import type { MetaFunction } from "react-router";
import { useLoaderData, useNavigation } from "react-router";
import { CatalogScopeLandingPage } from "../../features/source-observations/ui/admin-control-plane/scope-landing/scope-landing-page";
import { loader } from "../../support/route-support/admin-scope-landing/scope-landing-loader";

export { loader } from "../../support/route-support/admin-scope-landing/scope-landing-loader";

export const meta: MetaFunction = () => [{ title: t("catalog.routes.admin.scopeLanding.scopes.catalog.admin") }];

// Scope-first landing (`/catalog/scopes`, v2 control-plane `catalog-home`). Thin
// composition root: re-exports the loader and renders the canonical Scope Record
// list. Each row opens that scope's own Scope Detail journey.
export default function ScopeLandingRoute() {
  const { readModel, query, productDomain, error } = useLoaderData<typeof loader>();
  const navigation = useNavigation();

  return (
    <CatalogScopeLandingPage
      readModel={readModel}
      query={query}
      productDomain={productDomain}
      loading={navigation.state !== "idle"}
      error={error}
    />
  );
}
