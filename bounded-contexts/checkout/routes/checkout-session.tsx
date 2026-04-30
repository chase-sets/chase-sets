import type {
  ActionFunctionArgs,
  LoaderFunctionArgs,
  MetaFunction,
} from "react-router";
import { redirect, useActionData, useLoaderData, useNavigation } from "react-router";
import { buildOpenGraphMeta } from "@chase-sets/platform-runtime/meta";
import { requireActorFromAuthApi } from "@chase-sets/platform-runtime/auth";
import {
  createForwardedAuthFetch,
  resolveRequestApiBaseUrl,
} from "@chase-sets/platform-runtime/http";
import { createCheckoutRequestApiClient } from "../support/request-support/api-client";
import { normalizeRequestedBalanceCreditAmount } from "../support/request-support/balance-credit";
import { CheckoutSessionPage } from "../features/sessions/ui/checkout-page";

const MARKETPLACE_DESCRIPTION =
  "Choose shipping and create seller-specific purchases before payment.";

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

export async function loader({ request, params }: LoaderFunctionArgs) {
  await requireActorFromAuthApi({ request, permission: "orders.view" });
  if (!params.sessionId) {
    throw new Response("Checkout session not found.", { status: 404 });
  }
  const api = createCheckoutRequestApiClient(request);
  const session = await api.getCheckoutSession(params.sessionId);
  if (session.payment_id) {
    throw redirect(`/account/payments/${session.payment_id}`);
  }

  const wallet = await loadWalletBalance(request);

  return {
    session,
    wallet,
  };
}

export async function action({ request, params }: ActionFunctionArgs) {
  await requireActorFromAuthApi({ request, permission: "orders.manage" });
  if (!params.sessionId) {
    throw new Response("Checkout session not found.", { status: 404 });
  }
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");
  const api = createCheckoutRequestApiClient(request);

  try {
    if (intent === "confirm-checkout") {
      await api.selectShippingOption(params.sessionId, {
        shippingOption: String(formData.get("shippingOption") ?? "standard"),
      });
      const result = await api.confirmCheckoutSession(params.sessionId, {
        requestedBalanceCreditAmount: normalizeRequestedBalanceCreditAmount(
          formData.get("requestedBalanceCreditAmount"),
        ),
      });
      return redirect(`/account/payments/${result.payment_id}`);
    }

    return null;
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "Request failed.",
    };
  }
}

export const meta: MetaFunction = () =>
  buildOpenGraphMeta({
    title: "Checkout | Marketplace",
    description: MARKETPLACE_DESCRIPTION,
  });

export default function CheckoutSessionRoute() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();

  return (
    <CheckoutSessionPage
      session={data.session}
      wallet={data.wallet}
      errorMessage={actionData?.error ?? null}
      isSubmitting={navigation.state === "submitting"}
    />
  );
}
