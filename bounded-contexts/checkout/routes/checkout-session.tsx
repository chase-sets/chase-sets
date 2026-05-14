import { t } from "@chase-sets/localization";
import type {
  ActionFunctionArgs,
  LoaderFunctionArgs,
  MetaFunction,
} from "react-router";
import { useEffect } from "react";
import { redirect, useActionData, useLoaderData, useNavigation } from "react-router";
import {
  appendFreshWriteToken,
  loadFreshlyWrittenResource,
} from "@chase-sets/http/responses";
import { buildOpenGraphMeta } from "@chase-sets/platform-runtime/meta";
import { resolveActorFromAuthApi } from "@chase-sets/platform-runtime/auth";
import { subscribeRealtimePatches } from "@chase-sets/platform-runtime/realtime-web";
import {
  createForwardedAuthFetch,
  resolveRequestApiBaseUrl,
} from "@chase-sets/platform-runtime/http";
import {
  CheckoutApiError,
  createCheckoutRequestApiClient,
} from "../support/request-support/api-client";
import {
  createIdentityRequestApiClient,
  type ShippingAddress,
} from "@chase-sets/identity/server";
import { createOrderingRequestApiClient } from "@chase-sets/ordering/server";
import { normalizeRequestedBalanceCreditAmount } from "../support/request-support/balance-credit";
import { CheckoutSessionPage } from "../features/sessions/ui/checkout-page";

const MARKETPLACE_DESCRIPTION =
  t("checkout.routes.checkoutSession.choose.shipping.and.create.purchases.grouped");
const FULFILLMENT_PREVIEW_UNAVAILABLE =
  t("checkout.routes.checkoutSession.fulfillment.preview.temporarily.unavailable");

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
    shippingAddressId: normalizeText(formData.get("shippingAddressId")),
    name: String(formData.get("shippingName") ?? "").trim(),
    company: normalizeText(formData.get("shippingCompany")),
    line1: String(formData.get("shippingLine1") ?? "").trim(),
    line2: normalizeText(formData.get("shippingLine2")),
    city: String(formData.get("shippingCity") ?? "").trim(),
    state: String(formData.get("shippingState") ?? "").trim().toUpperCase(),
    postalCode: String(formData.get("shippingPostalCode") ?? "").trim(),
    country: String(formData.get("shippingCountry") ?? "US").trim().toUpperCase(),
    phone: normalizeText(formData.get("shippingPhone")),
    email: normalizeText(formData.get("shippingEmail")),
  };
}

function shippingAddressFromSavedAddress(address: ShippingAddress) {
  return {
    shippingAddressId: address.shipping_address_id,
    name: address.recipient_name,
    company: address.company,
    line1: address.line1,
    line2: address.line2,
    city: address.city,
    state: address.state,
    postalCode: address.postal_code,
    country: address.country,
    phone: address.phone,
    email: address.email,
  };
}

async function loadSavedShippingAddresses(request: Request, actor: Awaited<ReturnType<typeof resolveActorFromAuthApi>>) {
  if (
    !actor ||
    actor.roleKey === "guest-buyer" ||
    !Array.isArray(actor.permissions) ||
    !actor.permissions.includes("accounts.view")
  ) {
    return [];
  }
  const identityApi = createIdentityRequestApiClient(request);
  const response = await identityApi.listShippingAddresses<{
    items: readonly ShippingAddress[];
  }>(actor.accountId);
  return response.items;
}

async function resolveCheckoutShippingAddress(
  request: Request,
  actor: Awaited<ReturnType<typeof resolveActorFromAuthApi>>,
  formData: FormData,
) {
  const selectedShippingAddressId = normalizeText(formData.get("shippingAddressId"));
  const addressBookAction = String(formData.get("addressBookAction") ?? "checkout-only");
  const makeDefault = String(formData.get("makeDefaultShippingAddress") ?? "") === "true";
  const formAddress = shippingAddressFromForm(formData);

  const canReadAddressBook = Boolean(
    actor &&
    actor.roleKey !== "guest-buyer" &&
    Array.isArray(actor.permissions) &&
    actor.permissions.includes("accounts.view"),
  );
  const canManageAddressBook = Boolean(
    actor &&
    actor.roleKey !== "guest-buyer" &&
    Array.isArray(actor.permissions) &&
    actor.permissions.includes("accounts.manage"),
  );
  const actorAccountId = canManageAddressBook && actor ? actor.accountId : null;

  if (!canReadAddressBook) {
    return {
      ...formAddress,
      shippingAddressId: null,
    };
  }

  const identityApi = createIdentityRequestApiClient(request);
  const savedAddresses = selectedShippingAddressId && selectedShippingAddressId !== "__manual"
    ? await loadSavedShippingAddresses(request, actor)
    : [];
  const selectedSavedAddress = savedAddresses.find(
    (address) => address.shipping_address_id === selectedShippingAddressId,
  );

  if (
    selectedSavedAddress &&
    addressBookAction !== "save-new" &&
    addressBookAction !== "update-selected"
  ) {
    return shippingAddressFromSavedAddress(selectedSavedAddress);
  }

  if (addressBookAction === "update-selected" && selectedSavedAddress && canManageAddressBook) {
    await identityApi.updateShippingAddress(actorAccountId!, selectedSavedAddress.shipping_address_id, {
      label: selectedSavedAddress.label,
      ...formAddress,
      makeDefault,
    });
    return {
      ...formAddress,
      shippingAddressId: selectedSavedAddress.shipping_address_id,
    };
  }

  if (addressBookAction === "save-new" && canManageAddressBook) {
    const result = await identityApi.createShippingAddress<{ id: string }>(actorAccountId!, {
      ...formAddress,
      makeDefault,
    });
    return {
      ...formAddress,
      shippingAddressId: result.id,
    };
  }

  return {
    ...formAddress,
    shippingAddressId: selectedSavedAddress?.shipping_address_id ?? null,
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

function isOfferIntentSession(session: Readonly<{ source_type: string }>) {
  return session.source_type === "offer-intent";
}

async function loadFulfillmentPreview(
  request: Request,
  session: Awaited<
    ReturnType<ReturnType<typeof createCheckoutRequestApiClient>["getCheckoutSession"]>
  >,
) {
  if (isOfferIntentSession(session)) {
    return { fulfillmentPreview: null, previewError: null };
  }

  const orderingApi = createOrderingRequestApiClient(request);
  try {
    return {
      fulfillmentPreview: await orderingApi.previewCheckoutFulfillment({
        checkoutSessionId: session.session_id,
        sourceType: session.source_type === "buy-now" ? "buy-now" : "cart-checkout",
        shippingOption: session.shipping_option,
        optimizationGoal: session.optimization_goal,
        lines: session.lines,
      }),
      previewError: null,
    };
  } catch {
    return {
      fulfillmentPreview: null,
      previewError: FULFILLMENT_PREVIEW_UNAVAILABLE,
    };
  }
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
  const session = await loadFreshlyWrittenResource({
    request,
    isNotFound: (error) =>
      error instanceof CheckoutApiError && error.status === 404,
    load: () => api.getCheckoutSession(params.sessionId!),
  });
  if (session.payment_id) {
    throw redirect(paymentPathForActor(actor, session.payment_id));
  }
  if (session.submitted_offer_id) {
    throw redirect(`/account/offers/submitted/${session.submitted_offer_id}?feedbackWorkflow=offer-submit`);
  }

  const wallet = actor && actor.roleKey !== "guest-buyer"
    ? await loadWalletBalance(request)
    : null;
  const savedShippingAddresses = await loadSavedShippingAddresses(request, actor);
  const { fulfillmentPreview, previewError } = await loadFulfillmentPreview(
    request,
    session,
  );

  return {
    session,
    wallet,
    savedShippingAddresses,
    canManageShippingAddresses: Boolean(
      actor &&
      actor.roleKey !== "guest-buyer" &&
      Array.isArray(actor.permissions) &&
      actor.permissions.includes("accounts.manage"),
    ),
    fulfillmentPreview,
    previewError,
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
        shippingAddress: await resolveCheckoutShippingAddress(request, actor, formData),
      });
      if (result.offer_id) {
        return redirect(
          appendFreshWriteToken(
            `/account/offers/submitted/${result.offer_id}?feedbackWorkflow=offer-submit`,
            result,
          ),
        );
      }
      if (!result.payment_id) {
        throw new Error("Checkout confirmation did not return a payment.");
      }
      return redirect(
        appendFreshWriteToken(paymentPathForActor(actor, result.payment_id), result),
      );
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
      savedShippingAddresses={data.savedShippingAddresses}
      canManageShippingAddresses={data.canManageShippingAddresses}
      errorMessage={actionData?.error ?? data.previewError ?? null}
      isSubmitting={navigation.state === "submitting"}
    />
  );
}
