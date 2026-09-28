import { t } from "@chase-sets/localization";
import type { ActionFunctionArgs, LoaderFunctionArgs, MetaFunction } from "react-router";
import { useLoaderData, useRouteLoaderData } from "react-router";
import { buildOpenGraphMeta } from "@chase-sets/platform-runtime/meta";
import { useRealtimePatchedSnapshot } from "@chase-sets/platform-runtime/realtime-react";
import { appendFreshWriteToken, type ListResponse } from "@chase-sets/http/responses";
import { requireActorFromAuthApi } from "@chase-sets/platform-runtime/auth";
import { type SubmittedOfferListItem } from "../support/request-support/api-client";
import { createMarketplaceRequestApiClient } from "../support/request-support/api-client";
import { MarketplaceSubmittedOfferListPage } from "../features/offers/ui/submitted-offer-list-page";
import { applyMarketplaceListPatch } from "../support/realtime-support/patches";
import { marketplaceRealtimeRouteTopics } from "../support/realtime-support/topics";
import { MarketplaceApiError, type BuyerOfferPolicySnapshot } from "../client";
import { buyerOfferPolicyIdSchema, buyerOfferPolicyRequestSchema } from "../features/offer-policy/domain/contracts";
import { ZodError } from "zod";

const DEFAULT_OFFER_QUERY = "limit=100&offset=0";
const MARKETPLACE_DESCRIPTION = t("marketplace.routes.accountOffersSubmitted.track.offers.you.have.submitted.against");

export async function loader({ request }: LoaderFunctionArgs) {
  await requireActorFromAuthApi({ request, permission: "offers.view" });
  const api = createMarketplaceRequestApiClient(request);

  const submittedOffers = await api.listSubmittedOffers(DEFAULT_OFFER_QUERY);
  const policies = submittedOffers.items.length
    ? await api.listBuyerOfferPolicies(submittedOffers.items.map((offer) => offer.offer_id))
    : { items: [] };
  return { submittedOffers, policies: policies.items };
}

export async function action({ request }: ActionFunctionArgs) {
  await requireActorFromAuthApi({ request, permission: "offers.manage" });
  const api = createMarketplaceRequestApiClient(request);
  let currentPolicyId: string | null = null;
  const afterCommand = async (write: Promise<BuyerOfferPolicySnapshot>) => {
    const policy = await write;
    return { policy, error: null, refreshHref: appendFreshWriteToken(new URL(request.url).pathname, policy) };
  };
  try {
    const form = await request.formData();
    const policyId = buyerOfferPolicyIdSchema.parse(form.get("policyId"));
    currentPolicyId = policyId;
    if (form.get("intent") === "load-policy") return { policy: await api.getBuyerOfferPolicy(policyId), error: null };
    const command = buyerOfferPolicyRequestSchema.parse(JSON.parse(String(form.get("command"))));
    if (command.type === "StopBuyerOfferPolicy" && form.get("confirmStop") !== "true")
      return { policy: null, error: "invalid_authority" };
    if (command.type === "PreviewBuyerOfferPolicy" && command.expectedVersion === 0) {
      const draft = await api.commandBuyerOfferPolicy(policyId, {
        type: "CreateBuyerOfferPolicy",
        expectedVersion: 0,
        operationId: `create_${policyId}`,
      });
      return await afterCommand(api.commandBuyerOfferPolicy(policyId, { ...command, expectedVersion: draft.version }));
    }
    return await afterCommand(api.commandBuyerOfferPolicy(policyId, command));
  } catch (error) {
    if (error instanceof ZodError || error instanceof SyntaxError) return { policy: null, error: "invalid_authority" };
    if (error instanceof MarketplaceApiError) {
      const body = error.body as { error?: { code?: string } } | null;
      const stale = body?.error?.code === "stale_preview";
      return {
        policy: stale && currentPolicyId ? await api.getBuyerOfferPolicy(currentPolicyId) : null,
        error: stale ? "stale_preview" : "invalid_authority",
      };
    }
    throw error;
  }
}

export const meta: MetaFunction = () =>
  buildOpenGraphMeta({
    title: t("marketplace.routes.accountOffersSubmitted.submitted.offers.marketplace"),
    description: MARKETPLACE_DESCRIPTION,
  });

export default function MarketplaceAccountSubmittedOffersRoute() {
  const data = useLoaderData<typeof loader>();
  const rootData = useRouteLoaderData("root") as { actor?: { accountId?: string } | null } | undefined;
  const accountId = rootData?.actor?.accountId ?? null;

  return (
    <MarketplaceAccountSubmittedOffersRealtimeView
      key={[
        accountId ?? "anonymous",
        data.submittedOffers.total,
        data.submittedOffers.items.map((item) => item.offer_id).join("|"),
      ].join("\n")}
      data={data}
      accountId={accountId}
    />
  );
}

function MarketplaceAccountSubmittedOffersRealtimeView({
  data,
  accountId,
}: {
  data: Awaited<ReturnType<typeof loader>>;
  accountId: string | null;
}) {
  const submittedOffers = useRealtimePatchedSnapshot<ListResponse<SubmittedOfferListItem>>({
    initialSnapshot: data.submittedOffers as ListResponse<SubmittedOfferListItem>,
    snapshotKey: JSON.stringify(data.submittedOffers),
    topics: accountId ? marketplaceRealtimeRouteTopics.accountOffers(accountId).topics : [],
    applyPatch: (current, patch) =>
      applyMarketplaceListPatch(current, patch, {
        entity: "marketplace.offer",
        idField: "offer_id",
      }),
    onSyncRequired: reloadForRealtimeSync,
  });

  return <MarketplaceSubmittedOfferListPage data={submittedOffers} policies={data.policies} />;
}

function reloadForRealtimeSync() {
  if (typeof window !== "undefined") {
    window.location.reload();
  }
}
