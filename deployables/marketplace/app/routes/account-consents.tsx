import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useLoaderData } from "react-router";
import {
  ConsentHistoryPage,
  type Consent,
} from "@chase-sets/identity/web";
import type { ListResponse } from "@chase-sets/http/responses";
import { createMarketplaceIdentityApiClient } from "../api.server";
import { requireMarketplaceActor } from "../auth.server";
import { buildMarketplaceMeta } from "../seo";

export async function loader({ request }: LoaderFunctionArgs) {
  const actor = await requireMarketplaceActor(request);
  const api = createMarketplaceIdentityApiClient(request);
  const response = await api.listConsents<ListResponse<Consent>>(
    `limit=50&offset=0&userId=${encodeURIComponent(actor.userId)}&accountId=${encodeURIComponent(actor.accountId)}`,
  );
  return { consents: response.items };
}

export const meta: MetaFunction = () =>
  buildMarketplaceMeta({ title: "Consents | Marketplace" });

export default function MarketplaceAccountConsentsRoute() {
  const data = useLoaderData<typeof loader>();
  return <ConsentHistoryPage consents={data.consents} />;
}
