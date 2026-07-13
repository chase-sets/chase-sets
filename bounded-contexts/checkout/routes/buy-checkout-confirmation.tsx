import { t } from "@chase-sets/localization";
import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { isRouteErrorResponse, redirect, useLoaderData, useLocation, useRouteError } from "react-router";
import { loadFreshlyWrittenResource, readCompactPostWriteToken } from "@chase-sets/http/responses";
import { buildOpenGraphMeta } from "@chase-sets/platform-runtime/meta";
import { resolveActorFromAuthApi } from "@chase-sets/platform-runtime/auth";
import { resolvePlatformPostWriteRequest } from "@chase-sets/platform-runtime/post-write-tokens";
import { CheckoutApiError, createCheckoutRequestApiClient } from "../support/request-support/api-client";
import {
  checkoutRecoveryForFreshWriteError,
  createCheckoutRecoveryResponse,
  isCheckoutRecovery,
} from "../features/sessions/api/checkout-recovery";
import { BuyCheckoutConfirmationPage } from "../features/sessions/ui/buy-checkout-confirmation-page";
import { CheckoutSessionRecoveryPage } from "../features/sessions/ui/checkout-recovery-page";

const CHECKOUT_SESSION_FRESH_READ_TIMEOUT_MS = 2_000;

function paymentPathForActor(actor: Awaited<ReturnType<typeof resolveActorFromAuthApi>>, paymentId: string) {
  return actor && actor.roleKey !== "guest-buyer"
    ? `/account/payments/${paymentId}`
    : `/checkout/payments/${paymentId}`;
}

function currentPathWithSearch(request: Request) {
  const url = new URL(request.url);
  return `${url.pathname}${url.search}`;
}

function paymentPathWithFreshWrite(request: Request, paymentPath: string) {
  const postWriteToken = readCompactPostWriteToken(request);
  if (postWriteToken) {
    return `${paymentPath}?postWriteToken=${encodeURIComponent(postWriteToken)}`;
  }

  const afterWrite = new URL(request.url).searchParams.get("afterWrite");
  return afterWrite ? `${paymentPath}?afterWrite=${encodeURIComponent(afterWrite)}` : paymentPath;
}

async function loadPaymentSummary(api: ReturnType<typeof createCheckoutRequestApiClient>, paymentId: string) {
  try {
    const payment = await api.getCheckoutPaymentSummary(paymentId);
    return {
      amount: payment.amount,
      status: payment.status,
      currencyCode: payment.currency_code,
    };
  } catch {
    return null;
  }
}

export async function loader({ request, params }: LoaderFunctionArgs) {
  const resolvedRequest = await resolvePlatformPostWriteRequest(request);
  const actor = await resolveActorFromAuthApi({ request: resolvedRequest });
  if (!params.sessionId) {
    throw new Response(t("checkout.routes.checkoutSession.checkout.session.not.found"), { status: 404 });
  }

  const api = createCheckoutRequestApiClient(resolvedRequest, {
    requestTimeoutMs: CHECKOUT_SESSION_FRESH_READ_TIMEOUT_MS,
    recoverTransportErrorsAsGatewayTimeout: true,
  });
  const session = await loadFreshlyWrittenResource({
    request: resolvedRequest,
    isNotFound: (error) => error instanceof CheckoutApiError && error.status === 404,
    load: () => api.getCheckoutSession(params.sessionId!),
  }).catch((error) => {
    const recovery = checkoutRecoveryForFreshWriteError(error, actor, resolvedRequest, currentPathWithSearch(request));
    if (recovery) {
      throw createCheckoutRecoveryResponse(recovery);
    }

    throw error;
  });

  if (session.submitted_offer_id) {
    throw redirect(`/account/offers/submitted/${session.submitted_offer_id}`);
  }

  if (!session.payment_id) {
    throw redirect(`/checkout/buy/session/${params.sessionId}`);
  }

  return {
    session,
    paymentPath: paymentPathWithFreshWrite(request, paymentPathForActor(actor, session.payment_id)),
    paymentSummary: await loadPaymentSummary(api, session.payment_id),
  };
}

export const meta: MetaFunction = () =>
  buildOpenGraphMeta({
    title: t("checkout.routes.buyCheckoutConfirmation.title"),
    description: t("checkout.routes.buyCheckoutConfirmation.description"),
  });

export default function BuyCheckoutConfirmationRoute() {
  const data = useLoaderData<typeof loader>();

  return (
    <BuyCheckoutConfirmationPage
      session={data.session}
      paymentPath={data.paymentPath}
      paymentSummary={data.paymentSummary}
    />
  );
}

export function ErrorBoundary() {
  const error = useRouteError();
  const location = useLocation();

  if (!isRouteErrorResponse(error) || ![202, 400, 401, 403, 404, 410, 503].includes(error.status)) {
    throw error;
  }

  const currentPath = `${location.pathname}${location.search}`;
  const signInPath = `/sign-in?returnTo=${encodeURIComponent(currentPath)}`;
  const recovery = isCheckoutRecovery(error.data) ? error.data : null;
  const title = recovery?.title ?? error.statusText ?? t("checkout.routes.checkoutSession.checkout.unavailable");
  const description =
    recovery?.description ??
    (typeof error.data === "string" && error.data.trim()
      ? error.data
      : t("checkout.routes.checkoutSession.checkout.unavailable.description"));
  const trustCue = recovery?.trustCue ?? t("checkout.routes.checkoutSession.payment.has.not.started");
  const primaryAction = recovery?.primaryAction ?? {
    href: "/search",
    label: t("checkout.routes.checkoutRecovery.browse.marketplace"),
    leadingIcon: "search" as const,
  };
  const secondaryAction = recovery?.secondaryAction ?? {
    href: signInPath,
    label: t("checkout.routes.checkoutSession.sign.in.to.continue"),
    leadingIcon: "lock" as const,
    tone: "secondary" as const,
  };

  return (
    <CheckoutSessionRecoveryPage
      kind={recovery?.kind ?? null}
      title={title}
      description={description}
      trustCue={trustCue}
      primaryAction={primaryAction}
      secondaryAction={secondaryAction}
      currentPath={currentPath}
    />
  );
}
