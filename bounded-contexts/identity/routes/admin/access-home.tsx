import { t } from "@chase-sets/localization";
import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useLoaderData } from "react-router";
import type { AccessHome } from "../../features/access-hub/api/contracts";
import { AccessHomePage } from "../../features/access-hub/ui/access-home-page";
import { createIdentityRequestApiClient } from "../../support/route-support/identity-request";

export async function loader({ request }: LoaderFunctionArgs) {
  const search = new URL(request.url).searchParams.get("search")?.trim() ?? "";
  const query = new URLSearchParams();
  if (search) {
    query.set("search", search);
  }
  const data = await createIdentityRequestApiClient(request).getAccessHome<AccessHome>(query.toString());
  return { data, search };
}

export const meta: MetaFunction = () => [{ title: t("identity.routes.admin.accessHome.access.identity.admin") }];

export default function AccessHomeRoute() {
  const { data, search } = useLoaderData<typeof loader>();
  return <AccessHomePage data={data} search={search} />;
}
