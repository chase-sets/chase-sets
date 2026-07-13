import { t } from "@chase-sets/localization";
import type { MetaFunction } from "react-router";
import { useLoaderData } from "react-router";
import { CatalogProviderDetailPage } from "../../features/source-observations/ui/admin-control-plane/provider-detail/provider-detail-page";
import { loadProviderDetail } from "../../support/route-support/admin-integrations/provider-detail-loader";

export { providerDetailAction as action } from "../../support/route-support/admin-integrations/provider-detail-action";

export async function loader(args: Parameters<typeof loadProviderDetail>[0]) {
  return loadProviderDetail(args);
}

export const meta: MetaFunction = () => [
  { title: t("catalog.routes.admin.catalogProviderDetail.provider.catalog.admin") },
];

// Provider detail (/catalog/providers/:providerKey). Thin composition
// root for the v2 control-plane blueprint's provider-detail page: profile
// authoring, validation readiness, the profile lifecycle, credential/transport
// health, participating units, and recent jobs for one provider, on one page —
// replacing the deprecated /admin/integrations/providers profile-authoring and
// validation-readiness workspaces and the /admin/integrations/governance
// lifecycle-recovery workspace.
export default function CatalogProviderDetailRoute() {
  const routeData = useLoaderData<typeof loader>();
  return <CatalogProviderDetailPage readModel={routeData.readModel} commandFeedback={routeData.commandFeedback} />;
}
