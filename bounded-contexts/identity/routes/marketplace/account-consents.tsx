import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useLoaderData } from "react-router";
import type { ListResponse } from "@chase-sets/http/responses";
import { buildOpenGraphMeta } from "@chase-sets/platform-runtime/meta";
import type { Consent } from "../../support/request-support/api-client";
import { ConsentHistoryPage } from "../../features/consents/ui/consent-history-page";
import {
  createIdentityRequestApiClient,
  requireActorFromIdentityApi,
} from "../../support/route-support/identity-request";

export async function loader({ request }: LoaderFunctionArgs) {
  const actor = await requireActorFromIdentityApi({ request });
  const api = createIdentityRequestApiClient(request);
  const response = await api.listConsents<ListResponse<Consent>>(
    `limit=50&offset=0&userId=${encodeURIComponent(actor.userId)}&accountId=${encodeURIComponent(actor.accountId)}`,
  );

  return { consents: response.items };
}

export const meta: MetaFunction = () =>
  buildOpenGraphMeta({ title: "Consents | Marketplace" });

export default function MarketplaceAccountConsentsRoute() {
  const data = useLoaderData<typeof loader>();
  return <ConsentHistoryPage consents={data.consents} />;
}
