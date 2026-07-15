import { t } from "@chase-sets/localization";
import { useLoaderData, type LoaderFunctionArgs, type MetaFunction } from "react-router";
import { requireActorFromAuthApi } from "@chase-sets/platform-runtime/auth";
import { buildOpenGraphMeta } from "@chase-sets/platform-runtime/meta";
import { SellerDeskSettingsPage } from "../features/seller-desk/ui/seller-desk-settings-page";

export async function loader({ request }: LoaderFunctionArgs) {
  const actor = await requireActorFromAuthApi({ request });
  return { permissions: actor.permissions };
}

export const meta: MetaFunction = () =>
  buildOpenGraphMeta({ title: t("marketplace.features.sellerDesk.ui.settings.meta.title") });

export default function MarketplaceAccountDeskSettingsRoute() {
  const { permissions } = useLoaderData<typeof loader>();
  return <SellerDeskSettingsPage permissions={permissions} />;
}
