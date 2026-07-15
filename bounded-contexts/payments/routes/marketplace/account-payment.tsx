import { t } from "@chase-sets/localization";
import { useRef, useState, type FormEvent } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs, MetaFunction } from "react-router";
import { redirect, useActionData, useLoaderData } from "react-router";
import { RouterForm } from "@chase-sets/design-system/react-router";
import {
  Badge,
  Banner,
  Button,
  Divider,
  HiddenInput,
  Inset,
  PageSection,
  ProgressiveDisclosure,
  Stack,
  Surface,
  Text,
  TextInput,
} from "@chase-sets/design-system";
import { requireActorFromAuthApi, resolveActorFromAuthApi } from "@chase-sets/platform-runtime/auth";
import { defineFormAction, defineResourceRoute, type FormActionContext } from "@chase-sets/platform-runtime/http";
import {
  navigateAfterWriteWithPlatformPostWriteToken,
  resolvePlatformPostWriteRequest,
} from "@chase-sets/platform-runtime/post-write-tokens";
import {
  completeBrowserAuthentication,
  createInternalAuthRequestApiClient,
  clearGuestCheckoutCookie,
  AuthApiError,
  type InteractiveAuthResult,
} from "@chase-sets/auth/server";
import { createPasskeyCredential, type PasskeyCredentialPayload } from "@chase-sets/auth/web";
import { buildOpenGraphMeta } from "@chase-sets/platform-runtime/meta";
import { createPaymentsRequestApiClient, PaymentsApiError } from "../../support/request-support/api-client";
import type { PaymentsAccountOrderInput } from "../../support/request-support/api-client";
import type {
  AccountPaymentOrderView,
  GuestCheckoutClaimContext,
  GuestClaimActionData,
  PaymentElementDefaultValues,
} from "../../features/payments/ui/account-payment/account-payment-contracts";
import { isClaimablePayment } from "../../features/payments/ui/account-payment/account-payment-display";
import { AccountPaymentErrorBoundary } from "../../features/payments/ui/account-payment/account-payment-error-boundary";
import { AccountPaymentPage } from "../../features/payments/ui/account-payment/account-payment-page";
import contextManifest from "../../context.json";
import { paymentsApiErrorAdapter } from "../../support/request-support/route-api-error";

export { AccountPaymentErrorBoundary as ErrorBoundary };

function isAuthOrAuthorizationStatus(error: unknown, status: number) {
  return (
    (error instanceof AuthApiError && error.status === status) ||
    (error instanceof PaymentsApiError && error.status === status) ||
    (error instanceof Error && "status" in error && error.status === status)
  );
}

function guestPaymentAccessExpiredResponse() {
  return new Response("This guest checkout payment link is invalid or expired.", {
    status: 401,
    statusText: "Guest checkout link expired",
  });
}

function paymentPreparingResponse() {
  return new Response(t("payments.routes.marketplace.accountPayment.payment.preparing.description"), {
    status: 503,
    statusText: t("payments.routes.marketplace.accountPayment.payment.preparing"),
  });
}

function isPaymentNotFound(error: unknown) {
  return (
    (error instanceof PaymentsApiError && error.status === 404) ||
    (error instanceof Error && "status" in error && error.status === 404)
  );
}

function isInternalPaymentSupportActor(
  actor: Readonly<{ roleKey?: string | null; permissions: readonly string[] }> | null | undefined,
) {
  return actor?.roleKey === "platform-admin" && actor.permissions.includes("support.manage");
}

function orderView(order: PaymentsAccountOrderInput): AccountPaymentOrderView {
  return {
    order_id: order.order_id,
    status: order.status,
    total_amount: order.total_amount,
    seller_payout_amount: order.seller_payout_amount,
    payment_deadline_at: order.payment_deadline_at,
  };
}

function resolvePaymentElementDefaultValues(
  orders: readonly PaymentsAccountOrderInput[],
): PaymentElementDefaultValues | null {
  for (const order of orders) {
    const destination = order.shipping_destination_snapshot;
    const email = order.buyer_email?.trim() || destination?.email?.trim();
    if (email) {
      return {
        billingDetails: {
          email,
          ...(destination?.name?.trim() ? { name: destination.name.trim() } : {}),
          ...(destination
            ? {
                address: {
                  line1: destination.line1,
                  ...(destination.line2 ? { line2: destination.line2 } : {}),
                  city: destination.city,
                  state: destination.state,
                  postal_code: destination.postalCode,
                  country: destination.country,
                },
              }
            : {}),
        },
      };
    }
  }

  return null;
}

function needsPaymentElementDefaultValues(
  payment: Readonly<{ status: string; processor_payment_kind?: string | null }>,
) {
  return payment.status === "pending-confirmation";
}

const GUEST_PAYMENT_CLAIM_LOCAL_RECOVERY_TOKEN_ENV = "GUEST_PAYMENT_CLAIM_LOCAL_RECOVERY_TOKEN_ENABLED";
const truthyEnvValues = new Set(["1", "true", "yes", "on"]);

function canExposeGuestPaymentClaimLocalRecoveryToken() {
  if (process.env.NODE_ENV === "production" || process.env.DEPLOYMENT_ENVIRONMENT === "production") {
    return false;
  }

  return truthyEnvValues.has((process.env[GUEST_PAYMENT_CLAIM_LOCAL_RECOVERY_TOKEN_ENV] ?? "").trim().toLowerCase());
}

export const loader = defineResourceRoute({
  manifest: contextManifest,
  routeId: "account-payment",
  prepare: async (args) => {
    const resolvedRequest = await resolvePlatformPostWriteRequest(args.request);
    const url = new URL(resolvedRequest.url);
    const isGuestCheckoutPayment = url.pathname.startsWith("/checkout/payments/");
    const claimContinuation = url.searchParams.get("claimContinuation")?.trim();
    if (isGuestCheckoutPayment && claimContinuation) {
      const result = await createInternalAuthRequestApiClient(
        resolvedRequest,
      ).claimGuestCheckoutWithClaimContinuation<InteractiveAuthResult>({
        continuation: claimContinuation,
        paymentId: args.params.paymentId,
      });
      const response = completeBrowserAuthentication(resolvedRequest, result, {
        defaultSuccessPath: `/account/payments/${args.params.paymentId}`,
        accountSelectionPath: "/account/select",
      });
      clearGuestCheckoutCookie(response.headers, resolvedRequest);
      throw response;
    }
    return { ...args, request: resolvedRequest };
  },
  authorization: async ({ request, params }) => {
    const isGuestCheckoutPayment = new URL(request.url).pathname.startsWith("/checkout/payments/");
    const actor = isGuestCheckoutPayment
      ? await resolveActorFromAuthApi({ request })
      : await requireActorFromAuthApi({ request, permission: "orders.view" });
    if (isGuestCheckoutPayment && actor && actor.roleKey !== "guest-buyer") {
      throw redirect(`/account/payments/${params.paymentId}`);
    }
    return actor;
  },
  errorAdapter: paymentsApiErrorAdapter,
  load: ({ request, params }) => createPaymentsRequestApiClient(request).getAccountPayment(params.paymentId!),
  map: async (payment, { request, params, actor }) => {
    const isGuestCheckoutPayment = new URL(request.url).pathname.startsWith("/checkout/payments/");
    try {
      const paymentsApi = createPaymentsRequestApiClient(request);
      const { orders } = await paymentsApi.listAccountOrderInputs({ orderIds: payment.order_ids });
      const guestClaimContext =
        isGuestCheckoutPayment && isClaimablePayment(payment)
          ? await createInternalAuthRequestApiClient(request).getGuestCheckoutClaimContext<GuestCheckoutClaimContext>({
              paymentId: params.paymentId,
            })
          : null;
      return {
        payment,
        orders: orders.map(orderView),
        isGuestCheckoutPayment,
        guestClaimContext,
        showSupportDetails: isInternalPaymentSupportActor(actor),
        paymentElementDefaultValues: needsPaymentElementDefaultValues(payment)
          ? resolvePaymentElementDefaultValues(orders)
          : null,
      };
    } catch (error) {
      if (
        isGuestCheckoutPayment &&
        (isAuthOrAuthorizationStatus(error, 401) || isAuthOrAuthorizationStatus(error, 403))
      ) {
        throw guestPaymentAccessExpiredResponse();
      }
      throw error;
    }
  },
  onPending: () => {
    throw paymentPreparingResponse();
  },
  onPermanentFailure: (result, { request }) => {
    const error = "error" in result ? result.error : null;
    const isGuestCheckoutPayment = new URL(request.url).pathname.startsWith("/checkout/payments/");
    if (
      isGuestCheckoutPayment &&
      (isAuthOrAuthorizationStatus(error, 401) || isAuthOrAuthorizationStatus(error, 403))
    ) {
      throw guestPaymentAccessExpiredResponse();
    }
    if (isPaymentNotFound(error)) {
      throw new Response(t("payments.routes.marketplace.accountPayment.payment.not.found"), { status: 404 });
    }
    if (error) throw error;
    throw new Response("Payment handoff is no longer valid.", { status: 410 });
  },
});

async function handleAction(
  intent: string,
  { request, params, formData }: FormActionContext,
): Promise<Response | GuestClaimActionData | null> {
  const pathname = new URL(request.url).pathname;
  if (!pathname.startsWith("/checkout/payments/")) {
    throw new Response("Not found.", { status: 404 });
  }

  const displayName = String(formData.get("displayName") ?? "").trim();
  const email = String(formData.get("email") ?? "").trim();
  const paymentsApi = createPaymentsRequestApiClient(request);
  const successPath = `/account/payments/${params.paymentId}`;

  try {
    const payment = await paymentsApi.getAccountPayment(params.paymentId!);
    if (intent === "retry-payment") {
      if (payment.status !== "failed" && payment.status !== "cancelled") {
        return {
          scope: "retry",
          error: t("payments.routes.marketplace.accountPayment.this.payment.cannot.be.retried"),
        };
      }

      const requestedBalanceCreditAmount = payment.balance_credit_amount;
      const paymentMethodCategory = payment.payment_method_category ?? "card";
      const checkoutStatus = await paymentsApi.getCheckoutStatus({
        orderIds: payment.order_ids,
        currencyCode: payment.currency_code,
        requestedBalanceCreditAmount,
        paymentMethodCategory,
      });
      const retryPayment = await paymentsApi.recoverCheckoutPayment({
        orderIds: payment.order_ids,
        currencyCode: payment.currency_code,
        requestedBalanceCreditAmount,
        paymentMethodCategory,
        marketplaceCheckoutFeeQuoteFingerprint: checkoutStatus.marketplace_checkout_fee.quote_fingerprint,
        returnUrlPath: "/checkout/payments/:paymentId",
      });
      return redirect(
        await navigateAfterWriteWithPlatformPostWriteToken(
          retryPayment,
          `/checkout/payments/${retryPayment.payment_id}`,
        ),
      );
    }

    if (!isClaimablePayment(payment)) {
      return {
        scope: "claim",
        error: t("payments.routes.marketplace.accountPayment.you.can.save.this.order.after.payment"),
      };
    }

    if (intent === "claim-link-request") {
      const result = await createInternalAuthRequestApiClient(request).requestGuestCheckoutClaimLink<{
        token: string;
        expiresAt: string;
      }>({
        paymentId: params.paymentId,
        origin: new URL(request.url).origin,
      });

      return {
        status: "claim-link-sent",
        token: canExposeGuestPaymentClaimLocalRecoveryToken() ? result.token : null,
        expiresAt: result.expiresAt,
        displayName,
      };
    }

    if (intent === "claim-link-consume") {
      if (!canExposeGuestPaymentClaimLocalRecoveryToken()) {
        return {
          scope: "claim",
          error: t("payments.routes.marketplace.accountPayment.claim.token.entry.is.not.available"),
        };
      }

      const result = await createInternalAuthRequestApiClient(
        request,
      ).claimGuestCheckoutWithMagicLink<InteractiveAuthResult>({
        token: formData.get("token"),
        paymentId: params.paymentId,
        displayName,
      });

      const response = completeBrowserAuthentication(request, result, {
        defaultSuccessPath: successPath,
        accountSelectionPath: "/account/select",
      });
      clearGuestCheckoutCookie(response.headers, request);
      return response;
    }

    if (intent === "claim-passkey") {
      const result = await createInternalAuthRequestApiClient(
        request,
      ).claimGuestCheckoutWithPasskey<InteractiveAuthResult>({
        displayName,
        email,
        paymentId: params.paymentId,
        challengeId: formData.get("challengeId"),
        challenge: formData.get("challenge"),
        externalCredentialId: formData.get("externalCredentialId"),
        label: formData.get("label"),
        webauthnResponse: formData.get("webauthnResponse"),
      });

      const response = completeBrowserAuthentication(request, result, {
        defaultSuccessPath: successPath,
        accountSelectionPath: "/account/select",
      });
      clearGuestCheckoutCookie(response.headers, request);
      return response;
    }

    return null;
  } catch (error) {
    if (
      intent === "retry-payment" &&
      (isAuthOrAuthorizationStatus(error, 401) || isAuthOrAuthorizationStatus(error, 403))
    ) {
      throw guestPaymentAccessExpiredResponse();
    }

    return {
      scope: intent === "retry-payment" ? "retry" : "claim",
      error:
        error instanceof Error
          ? error.message
          : intent === "retry-payment"
            ? t("payments.routes.marketplace.accountPayment.could.not.retry.this.payment")
            : t("payments.routes.marketplace.accountPayment.could.not.save.this.order"),
    };
  }
}

export const action = defineFormAction({
  intents: {
    "retry-payment": (context) => handleAction("retry-payment", context),
    "claim-link-request": (context) => handleAction("claim-link-request", context),
    "claim-link-consume": (context) => handleAction("claim-link-consume", context),
    "claim-passkey": (context) => handleAction("claim-passkey", context),
  },
  onUnknownIntent: (context) => handleAction("", context),
});

export const meta: MetaFunction = () =>
  buildOpenGraphMeta({ title: t("payments.routes.marketplace.accountPayment.payment.marketplace") });

function PasskeyHiddenFields({ payload }: { payload: PasskeyCredentialPayload | null }) {
  return (
    <>
      <HiddenInput type="hidden" name="challengeId" value={payload?.challengeId ?? ""} readOnly />
      <HiddenInput type="hidden" name="challenge" value={payload?.challenge ?? ""} readOnly />
      <HiddenInput type="hidden" name="externalCredentialId" value={payload?.externalCredentialId ?? ""} readOnly />
      <HiddenInput type="hidden" name="label" value={payload?.label ?? ""} readOnly />
      <HiddenInput type="hidden" name="webauthnResponse" value={payload?.webauthnResponse ?? ""} readOnly />
    </>
  );
}

function GuestClaimPrompt({
  actionData,
  claimContext,
}: {
  actionData: GuestClaimActionData | undefined;
  claimContext: GuestCheckoutClaimContext;
}) {
  const [displayName, setDisplayName] = useState(claimContext.contactName);
  const [passkeyPayload, setPasskeyPayload] = useState<PasskeyCredentialPayload | null>(null);
  const [passkeyError, setPasskeyError] = useState<string | null>(null);
  const [isCreatingPasskey, setIsCreatingPasskey] = useState(false);
  const passkeyFormRef = useRef<HTMLFormElement | null>(null);

  async function handlePasskeySubmit(event: FormEvent<HTMLFormElement>) {
    if (passkeyPayload) {
      return;
    }

    event.preventDefault();
    setPasskeyError(null);
    setIsCreatingPasskey(true);

    try {
      const payload = await createPasskeyCredential({
        displayName,
        email: claimContext.contactEmail,
      });
      setPasskeyPayload(payload);
      window.setTimeout(() => passkeyFormRef.current?.requestSubmit(), 0);
    } catch (error) {
      setPasskeyError(
        error instanceof Error
          ? error.message
          : t("payments.routes.marketplace.accountPayment.passkey.registration.failed"),
      );
    } finally {
      setIsCreatingPasskey(false);
    }
  }

  return (
    <PageSection title={t("payments.routes.marketplace.accountPayment.save.this.order")}>
      <Surface elevated glow>
        <Stack gap={3}>
          <Badge tone="accent">{t("payments.routes.marketplace.accountPayment.recommended")}</Badge>
          <Text tone="secondary">
            {t("payments.routes.marketplace.accountPayment.save.this.order.after.payment.with.a.passkey")}
          </Text>
          {actionData && "error" in actionData && actionData.scope === "claim" ? (
            <Banner
              title={t("payments.routes.marketplace.accountPayment.could.not.save.order")}
              description={actionData.error}
              tone="danger"
            />
          ) : null}
          {passkeyError ? (
            <Banner
              title={t("payments.routes.marketplace.accountPayment.passkey.unavailable")}
              description={passkeyError}
              tone="warning"
            />
          ) : null}
          <RouterForm ref={passkeyFormRef} method="post" onSubmit={handlePasskeySubmit} spacing="none">
            <Stack gap={3}>
              <HiddenInput type="hidden" name="intent" value="claim-passkey" readOnly />
              <HiddenInput type="hidden" name="email" value={claimContext.contactEmail} readOnly />
              <PasskeyHiddenFields payload={passkeyPayload} />
              <TextInput
                label={t("payments.routes.marketplace.accountPayment.contact.name")}
                name="displayName"
                required
                value={displayName}
                onChange={(event) => setDisplayName(event.currentTarget.value)}
              />
              <Inset>
                <Text size="sm" tone="secondary">
                  {t("payments.routes.marketplace.accountPayment.we.will.save.this.order.to", {
                    email: claimContext.contactEmail,
                  })}
                </Text>
              </Inset>
              <Button type="submit" leadingIcon="shield" loading={isCreatingPasskey}>
                {t("payments.routes.marketplace.accountPayment.save.with.passkey")}
              </Button>
            </Stack>
          </RouterForm>
          <Divider />
          <RouterForm method="post" spacing="none">
            <Stack gap={3}>
              <HiddenInput type="hidden" name="intent" value="claim-link-request" readOnly />
              <HiddenInput type="hidden" name="displayName" value={displayName} readOnly />
              <Text size="sm" tone="secondary">
                {t("payments.routes.marketplace.accountPayment.send.a.claim.link.to", {
                  email: claimContext.contactEmail,
                })}
              </Text>
              <Button type="submit" tone="secondary" leadingIcon="message">
                {t("payments.routes.marketplace.accountPayment.email.me.a.claim.link")}
              </Button>
            </Stack>
          </RouterForm>
          {actionData && "status" in actionData && actionData.token ? (
            <Inset>
              <RouterForm method="post" spacing="none">
                <Stack gap={2}>
                  <Text size="sm" tone="secondary">
                    {t("payments.routes.marketplace.accountPayment.local.recovery.token.in.production")}
                  </Text>
                  <HiddenInput type="hidden" name="intent" value="claim-link-consume" readOnly />
                  <HiddenInput type="hidden" name="displayName" value={actionData.displayName} readOnly />
                  <TextInput
                    label={t("payments.routes.marketplace.accountPayment.claim.token")}
                    name="token"
                    defaultValue={actionData.token}
                    required
                  />
                  <Button type="submit" leadingIcon="message">
                    {t("payments.routes.marketplace.accountPayment.verify.email.and.save.order")}
                  </Button>
                </Stack>
              </RouterForm>
            </Inset>
          ) : null}
          <ProgressiveDisclosure
            title={t("payments.routes.marketplace.accountPayment.other.options")}
            summary={t("payments.routes.marketplace.accountPayment.password.setup.is.available.only.after")}
            tone="info"
          >
            <Text size="sm" tone="secondary">
              {t("payments.routes.marketplace.accountPayment.password.setup.is.available.only.after")}
            </Text>
          </ProgressiveDisclosure>
        </Stack>
      </Surface>
    </PageSection>
  );
}

export default function MarketplaceAccountPaymentRoute() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const retryActionError =
    actionData && "error" in actionData && actionData.scope === "retry" ? actionData.error : null;
  const guestClaimSection =
    data.isGuestCheckoutPayment && data.guestClaimContext ? (
      <GuestClaimPrompt actionData={actionData ?? undefined} claimContext={data.guestClaimContext} />
    ) : null;
  return (
    <AccountPaymentPage
      payment={data.payment}
      orders={data.orders}
      isGuestCheckoutPayment={data.isGuestCheckoutPayment}
      showSupportDetails={data.showSupportDetails}
      paymentElementDefaultValues={data.paymentElementDefaultValues}
      retryActionError={retryActionError}
      guestClaimSection={guestClaimSection}
    />
  );
}
