import { t } from "@chase-sets/localization";
import type {
  ActionFunctionArgs,
  LoaderFunctionArgs,
  MetaFunction,
} from "react-router";
import { useEffect } from "react";
import { redirect, useActionData, useLoaderData, useNavigation } from "react-router";
import { buildOpenGraphMeta } from "@chase-sets/platform-runtime/meta";
import { resolveActorFromAuthApi } from "@chase-sets/platform-runtime/auth";
import { subscribeRealtimePatches } from "@chase-sets/platform-runtime/realtime-web";
import {
  createForwardedAuthFetch,
  resolveRequestApiBaseUrl,
} from "@chase-sets/platform-runtime/http";
import { createCheckoutRequestApiClient } from "../support/request-support/api-client";
import { createOrderingRequestApiClient } from "@chase-sets/ordering/server";
import { normalizeRequestedBalanceCreditAmount } from "../support/request-support/balance-credit";
import { CheckoutSessionPage } from "../features/sessions/ui/checkout-page";

const MARKETPLACE_DESCRIPTION =
  t("checkout.routes.checkoutSession.choose.shipping.and.create.purchases.grouped");

async function loadWalletBalance(request: Request) {
  const response = await createForwardedAuthFetch(request)(
    `${resolveRequestApiBaseUrl(request, "/api/settlement")}/wallet`,
  );

  if (!response.ok) {
    return null;
  }

  return response.json() as Promise<{
    available_balance_amount: string;
    currency_code: string;
  }>;
}

function normalizeText(value: FormDataEntryValue | null) {
  const text = String(value ?? "").trim();
  return text.length > 0 ? text : null;
}

function shippingAddressFromForm(formData: FormData) {
  return {
    name: normalizeText(formData.get("shippingName")),
    line1: String(formData.get("shippingLine1") ?? "").trim(),
    line2: normalizeText(formData.get("shippingLine2")),
    city: String(formData.get("shippingCity") ?? "").trim(),
    state: String(formData.get("shippingState") ?? "").trim().toUpperCase(),
    postalCode: String(formData.get("shippingPostalCode") ?? "").trim(),
    country: String(formData.get("shippingCountry") ?? "US").trim().toUpperCase(),
  };
}

function paymentPathForActor(
  actor: Awaited<ReturnType<typeof resolveActorFromAuthApi>>,
  paymentId: string,
) {
  return actor && actor.roleKey !== "guest-buyer"
    ? `/account/payments/${paymentId}`
    : `/checkout/payments/${paymentId}`;
}

function checkoutPreviewRealtimeTopics(
  lines: readonly Readonly<{
    catalogItemId: string;
    listingId?: string | null;
    lockedListingId?: string | null;
  }>[],
) {
  return [
    ...new Set(
      lines.flatMap((line) => [
        `item:${line.catalogItemId}`,
        ...(line.lockedListingId ? [`listing:${line.lockedListingId}`] : []),
        ...(line.listingId ? [`listing:${line.listingId}`] : []),
      ]),
    ),
  ];
}

function reloadForRealtimeSync() {
  if (typeof window !== "undefined") {
    window.location.reload();
  }
}

export async function loader({ request, params }: LoaderFunctionArgs) {
  const actor = await resolveActorFromAuthApi({ request });
  if (!params.sessionId) {
    throw new Response(t("checkout.routes.checkoutSession.checkout.session.not.found"), { status: 404 });
  }
  const api = createCheckoutRequestApiClient(request);
  const session = await api.getCheckoutSession(params.sessionId);
  if (session.payment_id) {
    throw redirect(paymentPathForActor(actor, session.payment_id));
  }

  const wallet = actor && actor.roleKey !== "guest-buyer"
    ? await loadWalletBalance(request)
    : null;
  const orderingApi = createOrderingRequestApiClient(request);
  const fulfillmentPreview = await orderingApi.previewCheckoutFulfillment({
    checkoutSessionId: session.session_id,
    sourceType: session.source_type === "buy-now" ? "buy-now" : "cart-checkout",
    shippingOption: session.shipping_option,
    optimizationGoal: session.optimization_goal,
    lines: session.lines,
  });

  return {
    session,
    wallet,
    fulfillmentPreview,
  };
}

export async function action({ request, params }: ActionFunctionArgs) {
  const actor = await resolveActorFromAuthApi({ request });
  if (!params.sessionId) {
    throw new Response(t("checkout.routes.checkoutSession.checkout.session.not.found.2"), { status: 404 });
  }
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");
  const api = createCheckoutRequestApiClient(request);

  try {
    if (intent === "select-optimization-goal") {
      await api.selectOptimizationGoal(params.sessionId, {
        optimizationGoal:
          formData.get("optimizationGoal") === "fewest-shipments"
            ? "fewest-shipments"
            : "lowest-total",
      });
      return redirect(`/checkout/${params.sessionId}`);
    }

    if (intent === "confirm-checkout") {
      await api.selectShippingOption(params.sessionId, {
        shippingOption: String(formData.get("shippingOption") ?? "standard"),
      });
      const result = await api.confirmCheckoutSession(params.sessionId, {
        requestedBalanceCreditAmount: normalizeRequestedBalanceCreditAmount(
          formData.get("requestedBalanceCreditAmount"),
        ),
        paymentMethodCategory: String(formData.get("paymentMethodCategory") ?? "card"),
        fulfillmentPreviewRevision:
          String(formData.get("fulfillmentPreviewRevision") ?? "") || null,
        acknowledgedMaterialChanges:
          String(formData.get("acknowledgedMaterialChanges") ?? "") === "true",
        shippingAddress: shippingAddressFromForm(formData),
      });
      return redirect(paymentPathForActor(actor, result.payment_id));
    }

    return null;
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : t("checkout.routes.checkoutSession.request.failed"),
    };
  }
}

export const meta: MetaFunction = () =>
  buildOpenGraphMeta({
    title: t("checkout.routes.checkoutSession.checkout.marketplace"),
    description: MARKETPLACE_DESCRIPTION,
  });

export default function CheckoutSessionRoute() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const realtimeTopics = checkoutPreviewRealtimeTopics(data.session.lines);
  const realtimeSubscriptionKey = realtimeTopics.join("\n");

  useEffect(() => {
    const subscription = subscribeRealtimePatches({
      topics: realtimeTopics,
      onPatch: reloadForRealtimeSync,
      onSyncRequired: reloadForRealtimeSync,
    });

    return () => subscription.close();
  }, [realtimeSubscriptionKey]);

  return (
    <CheckoutSessionPage
      session={data.session}
      wallet={data.wallet}
      fulfillmentPreview={data.fulfillmentPreview}
      errorMessage={actionData?.error ?? null}
      isSubmitting={navigation.state === "submitting"}
    />
  );
}
