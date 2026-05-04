import { t } from "@chase-sets/localization";
import { useEffect, useRef, useState, type FormEvent } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs, MetaFunction } from "react-router";
import {
  Form,
  isRouteErrorResponse,
  redirect,
  useActionData,
  useLoaderData,
  useRevalidator,
  useRouteError,
} from "react-router";
import {
  requireActorFromAuthApi,
  resolveActorFromAuthApi,
} from "@chase-sets/platform-runtime/auth";
import {
  completeBrowserAuthentication,
  createInternalAuthRequestApiClient,
  AuthApiError,
  type InteractiveAuthResult,
} from "@chase-sets/auth/server";
import {
  createPasskeyCredential,
  type PasskeyCredentialPayload,
} from "@chase-sets/auth/web";
import { appendClearedGuestCheckoutCookie } from "@chase-sets/checkout/server";
import {
  Badge,
  Banner,
  Button,
  CheckoutLayout,
  CheckoutTrustPanel,
  Divider,
  Grid,
  LinkButton,
  OrderSummary,
  Page,
  PageHeader,
  PageSection,
  Stack,
  Surface,
  Text,
  TextInput,
  type Tone,
} from "@chase-sets/design-system";
import { buildOpenGraphMeta } from "@chase-sets/platform-runtime/meta";
import {
  createPaymentsRequestApiClient,
  PaymentsApiError,
  type PaymentsPaymentDetail,
} from "../../support/request-support/api-client";
import {
  createOrderingRequestApiClient,
  type PurchaseDetail,
} from "@chase-sets/ordering/server";

type StripePaymentElement = {
  mount(target: HTMLElement | string): void;
  destroy(): void;
};

type StripeCheckoutController = {
  createPaymentElement(): StripePaymentElement;
  confirm(options?: { redirect: "if_required" }): Promise<{ error?: { message?: string } }>;
};

type StripeElements = {
  create(type: "payment"): StripePaymentElement;
};

type StripeClient = {
  initCheckout?: (options: {
    clientSecret: string;
  }) => StripeCheckoutController | Promise<StripeCheckoutController>;
  elements(options: { clientSecret: string }): StripeElements;
  confirmPayment(options: {
    elements: StripeElements;
    redirect: "if_required";
  }): Promise<{ error?: { message?: string } }>;
};

type StripeFactory = (publishableKey: string) => StripeClient;

type GuestCheckoutClaimContext = Readonly<{
  accountId: string;
  paymentId: string;
  contactEmail: string;
  contactName: string;
}>;

declare global {
  interface Window {
    Stripe?: StripeFactory;
  }
}

let stripeFactoryPromise: Promise<StripeFactory> | null = null;

function loadStripeFactory(): Promise<StripeFactory> {
  if (typeof window === "undefined") {
    return Promise.reject(new Error(t("payments.routes.marketplace.accountPayment.stripe.can.only.load.in.the")));
  }

  if (window.Stripe) {
    return Promise.resolve(window.Stripe);
  }

  if (!stripeFactoryPromise) {
    stripeFactoryPromise = new Promise((resolve, reject) => {
      const existingScript = document.querySelector<HTMLScriptElement>(
        'script[data-stripe-js="true"]',
      );

      if (existingScript) {
        existingScript.addEventListener("load", () => {
          if (window.Stripe) {
            resolve(window.Stripe);
            return;
          }

          reject(new Error(t("payments.routes.marketplace.accountPayment.stripe.js.loaded.without.exposing.stripe")));
        });
        existingScript.addEventListener("error", () => {
          reject(new Error(t("payments.routes.marketplace.accountPayment.stripe.js.failed.to.load")));
        });
        return;
      }

      const script = document.createElement("script");
      script.async = true;
      script.src = "https://js.stripe.com/v3/";
      script.dataset.stripeJs = "true";
      script.onload = () => {
        if (window.Stripe) {
          resolve(window.Stripe);
          return;
        }

        reject(new Error(t("payments.routes.marketplace.accountPayment.stripe.js.loaded.without.exposing.stripe.2")));
      };
      script.onerror = () => {
        reject(new Error(t("payments.routes.marketplace.accountPayment.stripe.js.failed.to.load.2")));
      };
      document.head.appendChild(script);
    });
  }

  return stripeFactoryPromise;
}

function formatMoney(amount: string) {
  return `$${amount}`;
}

function statusTone(status: string): Tone {
  switch (status) {
    case "captured":
      return "success";
    case "failed":
      return "danger";
    case "cancelled":
      return "danger";
    default:
      return "accent";
  }
}

function paymentStatusCopy(status: string) {
  switch (status) {
    case "pending-confirmation":
      return {
        label: t("payments.routes.marketplace.accountPayment.ready.for.payment"),
        description: t("payments.routes.marketplace.accountPayment.your.checkout.is.ready.confirm.payment"),
      };
    case "captured":
      return {
        label: t("payments.routes.marketplace.accountPayment.paid"),
        description: t("payments.routes.marketplace.accountPayment.payment.is.complete.and.the.covered"),
      };
    case "failed":
      return {
        label: t("payments.routes.marketplace.accountPayment.payment.needs.attention"),
        description: t("payments.routes.marketplace.accountPayment.the.secure.processor.could.not.complete"),
      };
    case "cancelled":
      return {
        label: t("payments.routes.marketplace.accountPayment.payment.cancelled"),
        description: t("payments.routes.marketplace.accountPayment.this.payment.session.is.closed.start"),
      };
    default:
      return {
        label: t("payments.routes.marketplace.accountPayment.payment.in.progress"),
        description: t("payments.routes.marketplace.accountPayment.the.payment.is.being.updated.by"),
      };
  }
}

function isClaimablePayment(payment: PaymentsPaymentDetail) {
  return payment.status === "captured";
}

function isAuthOrAuthorizationStatus(error: unknown, status: number) {
  return (
    (error instanceof AuthApiError && error.status === status) ||
    (error instanceof PaymentsApiError && error.status === status) ||
    (error instanceof Error && "status" in error && error.status === status)
  );
}

function guestPaymentAccessExpiredResponse() {
  return new Response(
    "This guest checkout payment link is invalid or expired.",
    { status: 401, statusText: "Guest checkout link expired" },
  );
}

function isGuestPaymentAccessExpiredError(error: unknown) {
  return (
    isRouteErrorResponse(error) &&
    (error.status === 401 || error.status === 403) &&
    error.statusText === "Guest checkout link expired"
  );
}

function providerEventLabel(eventKind: string) {
  switch (eventKind) {
    case "payment-authorized":
      return t("payments.routes.marketplace.accountPayment.provider.authorized.payment");
    case "payment-captured":
      return t("payments.routes.marketplace.accountPayment.provider.captured.payment");
    case "payment-failed":
      return t("payments.routes.marketplace.accountPayment.provider.reported.failure");
    case "payment-cancelled":
      return t("payments.routes.marketplace.accountPayment.provider.closed.payment.session");
    default:
      return eventKind.replaceAll("-", " ");
  }
}

export async function loader({ request, params }: LoaderFunctionArgs) {
  const pathname = new URL(request.url).pathname;
  const isGuestCheckoutPayment = pathname.startsWith("/checkout/payments/");
  const actor = isGuestCheckoutPayment
    ? await resolveActorFromAuthApi({ request })
    : await requireActorFromAuthApi({
        request,
        permission: "orders.view",
      });
  if (isGuestCheckoutPayment && actor && actor.roleKey !== "guest-buyer") {
    throw redirect(`/account/payments/${params.paymentId}`);
  }
  const paymentsApi = createPaymentsRequestApiClient(request);
  const orderingApi = createOrderingRequestApiClient(request);

  try {
    const payment = await paymentsApi.getAccountPayment(params.paymentId!);
    const orders = await Promise.all(
      payment.order_ids.map((orderId) => orderingApi.getPurchase(orderId)),
    );
    const guestClaimContext = isGuestCheckoutPayment && isClaimablePayment(payment)
      ? await createInternalAuthRequestApiClient(request)
          .getGuestCheckoutClaimContext<GuestCheckoutClaimContext>({
          paymentId: params.paymentId,
        })
      : null;

    return {
      payment,
      orders,
      isGuestCheckoutPayment,
      guestClaimContext,
      showSupportDetails: Boolean(actor?.permissions.includes("orders.manage")),
    };
  } catch (error) {
    if (
      isGuestCheckoutPayment &&
      (isAuthOrAuthorizationStatus(error, 401) || isAuthOrAuthorizationStatus(error, 403))
    ) {
      throw guestPaymentAccessExpiredResponse();
    }

    if (
      (error instanceof PaymentsApiError && error.status === 404) ||
      (error instanceof Error && "status" in error && error.status === 404)
    ) {
      throw new Response(t("payments.routes.marketplace.accountPayment.payment.not.found"), { status: 404 });
    }

    throw error;
  }
}

type GuestClaimActionData =
  | Readonly<{
      status: "claim-link-sent";
      token: string;
      expiresAt: string;
      displayName: string;
    }>
  | Readonly<{
      scope: "claim" | "retry";
      error: string;
    }>;

export async function action({
  request,
  params,
}: ActionFunctionArgs): Promise<Response | GuestClaimActionData | null> {
  const pathname = new URL(request.url).pathname;
  if (!pathname.startsWith("/checkout/payments/")) {
    throw new Response("Not found.", { status: 404 });
  }

  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");
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
          error: "This payment cannot be retried.",
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
        marketplaceCheckoutFeeQuoteFingerprint:
          checkoutStatus.marketplace_checkout_fee.quote_fingerprint,
        returnUrlPath: "/checkout/payments/:paymentId",
      });
      return redirect(`/checkout/payments/${retryPayment.payment_id}`);
    }

    if (!isClaimablePayment(payment)) {
      return {
        scope: "claim",
        error: "You can save this order after payment is complete.",
      };
    }

    if (intent === "claim-link-request") {
      const result = await createInternalAuthRequestApiClient(request)
        .requestGuestCheckoutClaimLink<{
        token: string;
        expiresAt: string;
      }>({ paymentId: params.paymentId });

      return {
        status: "claim-link-sent",
        token: result.token,
        expiresAt: result.expiresAt,
        displayName,
      };
    }

    if (intent === "claim-link-consume") {
      const result = await createInternalAuthRequestApiClient(request)
        .claimGuestCheckoutWithMagicLink<InteractiveAuthResult>({
        token: formData.get("token"),
        paymentId: params.paymentId,
        displayName,
      });

      const response = completeBrowserAuthentication(request, result, {
        defaultSuccessPath: successPath,
        accountSelectionPath: "/account/select",
      });
      appendClearedGuestCheckoutCookie(response.headers);
      return response;
    }

    if (intent === "claim-passkey") {
      const result = await createInternalAuthRequestApiClient(request)
        .claimGuestCheckoutWithPasskey<InteractiveAuthResult>({
        displayName,
        email,
        paymentId: params.paymentId,
        challengeId: formData.get("challengeId"),
        challenge: formData.get("challenge"),
        externalCredentialId: formData.get("externalCredentialId"),
        label: formData.get("label"),
        publicKey: formData.get("publicKey"),
      });

      const response = completeBrowserAuthentication(request, result, {
        defaultSuccessPath: successPath,
        accountSelectionPath: "/account/select",
      });
      appendClearedGuestCheckoutCookie(response.headers);
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
      error: error instanceof Error
        ? error.message
        : intent === "retry-payment"
          ? "Could not retry this payment."
          : "Could not save this order.",
    };
  }
}

export const meta: MetaFunction = () =>
  buildOpenGraphMeta({ title: t("payments.routes.marketplace.accountPayment.payment.marketplace") });

function StripeConfirmationCard({ payment }: { payment: PaymentsPaymentDetail }) {
  const revalidator = useRevalidator();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const stripeRef = useRef<StripeClient | null>(null);
  const checkoutRef = useRef<StripeCheckoutController | null>(null);
  const elementsRef = useRef<StripeElements | null>(null);
  const elementRef = useRef<StripePaymentElement | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isReady, setIsReady] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    if (
      payment.status !== "pending-confirmation" ||
      !payment.processor_client_secret ||
      !payment.processor_publishable_key ||
      !containerRef.current
    ) {
      return;
    }

    let cancelled = false;
    setErrorMessage(null);
    setIsReady(false);

    void loadStripeFactory()
      .then(async (factory) => {
        if (cancelled) {
          return;
        }

        const stripe = factory(payment.processor_publishable_key!);
        const clientSecret = payment.processor_client_secret!;
        const checkout = clientSecret.startsWith("cs_") && stripe.initCheckout
          ? await stripe.initCheckout({ clientSecret })
          : null;
        if (cancelled) {
          return;
        }

        const elements = checkout
          ? null
          : stripe.elements({
              clientSecret,
            });
        const paymentElement = checkout
          ? checkout.createPaymentElement()
          : elements!.create("payment");
        paymentElement.mount(containerRef.current!);

        stripeRef.current = stripe;
        checkoutRef.current = checkout;
        elementsRef.current = elements;
        elementRef.current = paymentElement;
        setIsReady(true);
      })
      .catch((error) => {
        if (!cancelled) {
          setErrorMessage(error instanceof Error ? error.message : t("payments.routes.marketplace.accountPayment.stripe.could.not.load"));
        }
      });

    return () => {
      cancelled = true;
      elementRef.current?.destroy();
      elementRef.current = null;
      checkoutRef.current = null;
      elementsRef.current = null;
      stripeRef.current = null;
      setIsReady(false);
    };
  }, [
    payment.payment_id,
    payment.processor_client_secret,
    payment.processor_publishable_key,
    payment.status,
  ]);

  useEffect(() => {
    if (payment.status !== "pending-confirmation") {
      return;
    }

    const interval = window.setInterval(() => {
      void revalidator.revalidate();
    }, 2_000);

    return () => window.clearInterval(interval);
  }, [payment.status, revalidator]);

  async function handleConfirm() {
    if (!stripeRef.current || (!checkoutRef.current && !elementsRef.current)) {
      setErrorMessage(t("payments.routes.marketplace.accountPayment.stripe.is.still.loading"));
      return;
    }

    setIsSubmitting(true);
    setErrorMessage(null);
    try {
      const result = checkoutRef.current
        ? await checkoutRef.current.confirm({ redirect: "if_required" })
        : await stripeRef.current.confirmPayment({
            elements: elementsRef.current!,
            redirect: "if_required",
          });

      if (result.error?.message) {
        setErrorMessage(result.error.message);
        return;
      }

      window.setTimeout(() => {
        void revalidator.revalidate();
      }, 500);
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <Surface elevated glow>
      <Stack gap={3}>
        <Badge tone="accent">{t("payments.routes.marketplace.accountPayment.secure.payment")}</Badge>
        <Text>
          {t("payments.routes.marketplace.accountPayment.payment.is.ready.enter.your.payment")}</Text>
        <div ref={containerRef} />
        {errorMessage ? (
          <Surface tone="subtle">
            <Text>{errorMessage}</Text>
          </Surface>
        ) : null}
        <Button
          type="button"
          onClick={handleConfirm}
          disabled={!isReady || isSubmitting}
          size="lg"
          leadingIcon="lock"
        >
          {isSubmitting ? t("payments.routes.marketplace.accountPayment.confirming.payment") : t("payments.routes.marketplace.accountPayment.confirm.payment")}
        </Button>
      </Stack>
    </Surface>
  );
}

function PasskeyHiddenFields({ payload }: { payload: PasskeyCredentialPayload | null }) {
  return (
    <>
      <input type="hidden" name="challengeId" value={payload?.challengeId ?? ""} readOnly />
      <input type="hidden" name="challenge" value={payload?.challenge ?? ""} readOnly />
      <input type="hidden" name="externalCredentialId" value={payload?.externalCredentialId ?? ""} readOnly />
      <input type="hidden" name="label" value={payload?.label ?? ""} readOnly />
      <input type="hidden" name="publicKey" value={payload?.publicKey ?? ""} readOnly />
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
  const [passkeyPayload, setPasskeyPayload] =
    useState<PasskeyCredentialPayload | null>(null);
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
        error instanceof Error ? error.message : "Passkey registration failed.",
      );
    } finally {
      setIsCreatingPasskey(false);
    }
  }

  return (
    <PageSection title="Save this order">
      <Surface elevated glow>
        <Stack gap={3}>
          <Badge tone="accent">Recommended</Badge>
          <Text tone="secondary">
            Save this order after payment with a passkey. You can use an email link if this device cannot create one.
          </Text>
          {actionData && "error" in actionData && actionData.scope === "claim" ? (
            <Banner title="Could not save order" description={actionData.error} tone="danger" />
          ) : null}
          {passkeyError ? (
            <Banner title="Passkey unavailable" description={passkeyError} tone="warning" />
          ) : null}
          <Form ref={passkeyFormRef} method="post" onSubmit={handlePasskeySubmit}>
            <Stack gap={3}>
              <input type="hidden" name="intent" value="claim-passkey" readOnly />
              <input type="hidden" name="email" value={claimContext.contactEmail} readOnly />
              <PasskeyHiddenFields payload={passkeyPayload} />
              <TextInput
                label="Contact name"
                name="displayName"
                required
                value={displayName}
                onChange={(event) => setDisplayName(event.currentTarget.value)}
              />
              <Surface tone="subtle">
                <Text size="sm" tone="secondary">
                  We will save this order to {claimContext.contactEmail}.
                </Text>
              </Surface>
              <Button type="submit" leadingIcon="shield" loading={isCreatingPasskey}>
                Save with passkey
              </Button>
            </Stack>
          </Form>
          <Divider />
          <Form method="post">
            <Stack gap={3}>
              <input type="hidden" name="intent" value="claim-link-request" readOnly />
              <input type="hidden" name="displayName" value={displayName} readOnly />
              <Text size="sm" tone="secondary">
                Send a claim link to {claimContext.contactEmail}.
              </Text>
              <Button type="submit" tone="secondary" leadingIcon="message">
                Email me a claim link
              </Button>
            </Stack>
          </Form>
          {actionData && "status" in actionData ? (
            <Surface tone="subtle">
              <Form method="post">
                <Stack gap={2}>
                  <Text size="sm" tone="secondary">
                    Local recovery token. In production this arrives by email.
                  </Text>
                  <input type="hidden" name="intent" value="claim-link-consume" readOnly />
                  <input type="hidden" name="displayName" value={actionData.displayName} readOnly />
                  <TextInput label="Claim token" name="token" defaultValue={actionData.token} required />
                  <Button type="submit" leadingIcon="message">
                    Verify email and save order
                  </Button>
                </Stack>
              </Form>
            </Surface>
          ) : null}
          <details>
            <summary>Other options</summary>
            <Text size="sm" tone="secondary">
              Password setup is available only after email verification or an authenticated session.
            </Text>
          </details>
        </Stack>
      </Surface>
    </PageSection>
  );
}

export default function MarketplaceAccountPaymentRoute() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const statusCopy = paymentStatusCopy(data.payment.status);
  const retryActionError =
    actionData && "error" in actionData && actionData.scope === "retry"
      ? actionData.error
      : null;

  return (
    <Page>
      <PageHeader
        eyebrow={t("payments.routes.marketplace.accountPayment.secure.checkout")}
        title={t("payments.routes.marketplace.accountPayment.payment.title", {
          paymentId: data.payment.payment_id,
        })}
        description={t("payments.routes.marketplace.accountPayment.track.payment.state.purchase.coverage.marketplace")}
        actions={
          data.isGuestCheckoutPayment ? null : (
            <LinkButton href="/account/purchases" tone="secondary">
              {t("payments.routes.marketplace.accountPayment.back.to.purchases")}</LinkButton>
          )
        }
      />

      <CheckoutLayout
        summary={
          <Stack gap={4}>
            <OrderSummary
              title={t("payments.routes.marketplace.accountPayment.payment.summary")}
              lines={[
                { label: t("payments.routes.marketplace.accountPayment.status"), value: <Badge tone={statusTone(data.payment.status)}>{statusCopy.label}</Badge> },
                { label: t("payments.routes.marketplace.accountPayment.wallet.balance.used"), value: formatMoney(data.payment.balance_credit_amount) },
                { label: t("payments.routes.marketplace.accountPayment.external.payment"), value: formatMoney(data.payment.processor_amount) },
                { label: t("payments.routes.marketplace.accountPayment.marketplace.sales.fee"), value: formatMoney(data.payment.marketplace_sales_fee_amount) },
                { label: t("payments.routes.marketplace.accountPayment.marketplace.checkout.fee"), value: formatMoney(data.payment.marketplace_checkout_fee_amount) },
                { label: t("payments.routes.marketplace.accountPayment.payment.method"), value: data.payment.payment_method_category ?? "card" },
                { label: t("payments.routes.marketplace.accountPayment.seller.payout"), value: formatMoney(data.payment.seller_payout_amount) },
                { label: t("payments.routes.marketplace.accountPayment.processor"), value: data.payment.processor_name },
              ]}
              total={formatMoney(data.payment.amount)}
            />
            <CheckoutTrustPanel
              items={[
                {
                  icon: "lock",
                  title: t("payments.routes.marketplace.accountPayment.secure.payment.flow"),
                  description: t("payments.routes.marketplace.accountPayment.payment.details.stay.inside.the.secure"),
                },
                {
                  icon: "shield",
                  title: t("payments.routes.marketplace.accountPayment.purchase.coverage"),
                  description: t("payments.routes.marketplace.accountPayment.covers.purchases", {
                    count: data.payment.order_ids.length,
                    purchaseLabel: t(
                      data.payment.order_ids.length === 1
                        ? "payments.routes.marketplace.accountPayment.purchase.singular"
                        : "payments.routes.marketplace.accountPayment.purchase.plural",
                    ),
                  }),
                },
                {
                  icon: "creditCard",
                  title: t("payments.routes.marketplace.accountPayment.fee.transparency"),
                  description: t("payments.routes.marketplace.accountPayment.marketplace.and.processor.fees.stay.visible"),
                },
              ]}
            />
          </Stack>
        }
      >
        <Stack gap={4}>
          {data.payment.status === "failed" || data.payment.status === "cancelled" ? (
            <Surface tone="subtle" elevated>
              <Stack gap={2}>
                <Badge tone="danger">
                  {data.payment.status === "cancelled" ? t("payments.routes.marketplace.accountPayment.payment.session.closed") : t("payments.routes.marketplace.accountPayment.payment.issue")}
                </Badge>
                <Text>
                  {data.payment.failure_message ??
                    t(
                      data.payment.status === "cancelled"
                        ? "payments.routes.marketplace.accountPayment.this.secure.payment.session.is.no"
                        : "payments.routes.marketplace.accountPayment.the.secure.processor.could.not.complete",
                    )}
                </Text>
                {data.payment.status === "failed" || data.payment.status === "cancelled" ? (
                  data.isGuestCheckoutPayment ? (
                    <Stack gap={2}>
                      {retryActionError ? (
                        <Banner title="Could not retry payment" description={retryActionError} tone="danger" />
                      ) : null}
                      <Form method="post">
                        <input type="hidden" name="intent" value="retry-payment" readOnly />
                        <Button type="submit" leadingIcon="creditCard">
                          {t("payments.routes.marketplace.accountPayment.retry.payment")}</Button>
                      </Form>
                    </Stack>
                  ) : (
                    <LinkButton
                      href={`/account/payments/new?orderIds=${encodeURIComponent(data.payment.order_ids.join(","))}`}
                    >
                      {t("payments.routes.marketplace.accountPayment.retry.payment")}</LinkButton>
                  )
                ) : null}
              </Stack>
            </Surface>
          ) : null}

          <PageSection title={t("payments.routes.marketplace.accountPayment.payment.status")}>
            <Surface elevated>
              <Stack gap={2}>
                <Badge tone={statusTone(data.payment.status)}>{statusCopy.label}</Badge>
                <Text>{statusCopy.description}</Text>
              </Stack>
            </Surface>
          </PageSection>

          {data.isGuestCheckoutPayment && data.guestClaimContext ? (
            <GuestClaimPrompt
              actionData={actionData ?? undefined}
              claimContext={data.guestClaimContext}
            />
          ) : null}

          <PageSection title={t("payments.routes.marketplace.accountPayment.event.timeline")}>
            <Surface elevated>
              <Stack gap={2}>
                <Stack gap={1}>
                  <Badge tone="success">{t("payments.routes.marketplace.accountPayment.payment.created")}</Badge>
                  <Text size="sm" tone="secondary">
                    {new Date(data.payment.created_at).toLocaleString()}
                  </Text>
                </Stack>
                {data.payment.provider_events.map((event) => (
                  <Stack key={event.provider_event_id} gap={1}>
                    <Badge tone="accent">{providerEventLabel(event.event_kind)}</Badge>
                    <Text size="sm" tone="secondary">
                      {new Date(event.received_at).toLocaleString()}
                    </Text>
                  </Stack>
                ))}
                <Stack gap={1}>
                  <Badge tone={data.payment.captured_at ? "success" : statusTone(data.payment.status)}>
                    {data.payment.captured_at
                      ? t("payments.routes.marketplace.accountPayment.payment.captured")
                      : data.payment.failed_at
                        ? t("payments.routes.marketplace.accountPayment.payment.failed")
                        : data.payment.cancelled_at
                          ? t("payments.routes.marketplace.accountPayment.payment.cancelled.2")
                          : t("payments.routes.marketplace.accountPayment.waiting.for.provider.event")}
                  </Badge>
                  <Text size="sm" tone="secondary">
                    {data.payment.captured_at
                      ? new Date(data.payment.captured_at).toLocaleString()
                      : data.payment.failed_at
                        ? new Date(data.payment.failed_at).toLocaleString()
                        : data.payment.cancelled_at
                          ? new Date(data.payment.cancelled_at).toLocaleString()
                          : data.payment.processor_status}
                  </Text>
                </Stack>
              </Stack>
            </Surface>
          </PageSection>

          {data.showSupportDetails ? (
            <PageSection title={t("payments.routes.marketplace.accountPayment.support.details")}>
              <Surface elevated>
                <Stack gap={2}>
                  <Text size="sm" tone="secondary">{t("payments.routes.marketplace.accountPayment.internal.payment")}{data.payment.payment_id}</Text>
                  <Text size="sm" tone="secondary">{t("payments.routes.marketplace.accountPayment.account")}{data.payment.buyer_account_id}</Text>
                  <Text size="sm" tone="secondary">
                    {t("payments.routes.marketplace.accountPayment.processor.reference")}{data.payment.processor_payment_reference}
                  </Text>
                  <Text size="sm" tone="secondary">
                    {t("payments.routes.marketplace.accountPayment.processor.status")}{data.payment.processor_status}
                  </Text>
                  <Text size="sm" tone="secondary">
                    {t("payments.routes.marketplace.accountPayment.source")}{data.payment.source_context ?? "direct"} / {data.payment.source_reference_id ?? "none"}
                  </Text>
                  <Text size="sm" tone="secondary">
                    {t("payments.routes.marketplace.accountPayment.updated")}{new Date(data.payment.updated_at).toLocaleString()}
                  </Text>
                  <Text size="sm" tone="secondary">
                    {t("payments.routes.marketplace.accountPayment.provider.events")}{data.payment.provider_events.length}
                  </Text>
                  {data.payment.provider_events.map((event) => (
                    <Text key={event.provider_event_id} size="sm" tone="secondary">
                      {t("payments.routes.marketplace.accountPayment.provider.event")}{event.provider_event_id}: {providerEventLabel(event.event_kind)}
                    </Text>
                  ))}
                  {data.payment.failure_code ? (
                    <Text size="sm" tone="secondary">
                      {t("payments.routes.marketplace.accountPayment.failure.code")}{data.payment.failure_code}
                    </Text>
                  ) : null}
                </Stack>
              </Surface>
            </PageSection>
          ) : null}

          {data.payment.status === "pending-confirmation" ? (
            <PageSection title={t("payments.routes.marketplace.accountPayment.secure.payment.2")}>
              {data.payment.processor_client_secret && data.payment.processor_publishable_key ? (
                <StripeConfirmationCard payment={data.payment} />
              ) : data.payment.processor_redirect_url ? (
                <Surface elevated glow>
                  <Stack gap={3}>
                    <Badge tone="accent">{t("payments.routes.marketplace.accountPayment.secure.payment.3")}</Badge>
                    <Text>
                      {t("payments.routes.marketplace.accountPayment.payment.is.ready.continue.to.the")}</Text>
                    <LinkButton
                      href={data.payment.processor_redirect_url}
                      size="lg"
                      leadingIcon="lock"
                    >
                      {t("payments.routes.marketplace.accountPayment.continue.to.secure.checkout")}</LinkButton>
                  </Stack>
                </Surface>
              ) : (
                <Surface tone="subtle" elevated>
                  <Text>{t("payments.routes.marketplace.accountPayment.secure.payment.confirmation.is.not.configured")}</Text>
                </Surface>
              )}
            </PageSection>
          ) : data.payment.processor_amount === "0.00" ? (
            <PageSection title={t("payments.routes.marketplace.accountPayment.wallet.balance")}>
              <Surface elevated glow>
                <Stack gap={2}>
                  <Badge tone="success">{t("payments.routes.marketplace.accountPayment.paid.with.balance")}</Badge>
                  <Text>
                    {t("payments.routes.marketplace.accountPayment.this.purchase.was.covered.by.available")}</Text>
                </Stack>
              </Surface>
            </PageSection>
          ) : null}

          <PageSection title={t("payments.routes.marketplace.accountPayment.purchases")}>
            <Stack gap={3}>
              {data.orders.map((order: PurchaseDetail) => (
                <Surface key={order.order_id} elevated>
                  <Stack gap={3}>
                    <Grid columns={{ base: 1, md: 3 }} gap={3}>
                      <Stack gap={1}>
                        <Text weight="semibold">{t("payments.routes.marketplace.accountPayment.purchase")}{order.order_id}</Text>
                        <Badge tone="accent">{order.status}</Badge>
                      </Stack>
                      <Stack gap={1}>
                        <Text size="sm" tone="secondary">{t("payments.routes.marketplace.accountPayment.total")}</Text>
                        <Text weight="semibold">{formatMoney(order.total_amount)}</Text>
                      </Stack>
                      <Stack gap={1}>
                        <Text size="sm" tone="secondary">{t("payments.routes.marketplace.accountPayment.seller.payout")}</Text>
                        <Text>{formatMoney(order.seller_payout_amount)}</Text>
                      </Stack>
                    </Grid>
                    <Divider />
                    {data.isGuestCheckoutPayment ? null : (
                      <LinkButton href={`/account/purchases/${order.order_id}`} tone="secondary">
                        {t("payments.routes.marketplace.accountPayment.open.purchase")}</LinkButton>
                    )}
                  </Stack>
                </Surface>
              ))}
            </Stack>
          </PageSection>
        </Stack>
      </CheckoutLayout>
    </Page>
  );
}

export function ErrorBoundary() {
  const error = useRouteError();

  if (!isGuestPaymentAccessExpiredError(error)) {
    throw error;
  }

  return (
    <Page>
      <PageHeader
        eyebrow="Secure checkout"
        title="Payment link expired"
        description="This checkout payment link is no longer valid. Your payment was not changed from this link."
      />
      <PageSection title="Recover checkout">
        <Surface elevated>
          <Stack gap={3}>
            <Badge tone="warning">Link unavailable</Badge>
            <Text>
              Return to your cart to review your items and start checkout again. If you already completed payment, contact support with the email address you used at checkout.
            </Text>
            <Stack direction={{ base: "column", sm: "row" }} gap={3}>
              <LinkButton href="/account/cart" leadingIcon="cart">
                Return to cart
              </LinkButton>
              <LinkButton href="/" tone="secondary" leadingIcon="search">
                Continue shopping
              </LinkButton>
            </Stack>
          </Stack>
        </Surface>
      </PageSection>
    </Page>
  );
}
