import { t } from "@chase-sets/localization";
import { useEffect, useRef, useState } from "react";
import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import {
  useLoaderData,
  useRevalidator,
} from "react-router";
import { requireActorFromAuthApi } from "@chase-sets/platform-runtime/auth";
import {
  Badge,
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
    case "authorized":
      return {
        label: t("payments.routes.marketplace.accountPayment.payment.authorized"),
        description: t("payments.routes.marketplace.accountPayment.the.payment.was.accepted.and.is"),
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
  const actor = await requireActorFromAuthApi({
    request,
    permission: "orders.view",
  });
  const paymentsApi = createPaymentsRequestApiClient(request);
  const orderingApi = createOrderingRequestApiClient(request);

  try {
    const payment = await paymentsApi.getAccountPayment(params.paymentId!);
    const orders = await Promise.all(
      payment.order_ids.map((orderId) => orderingApi.getPurchase(orderId)),
    );

    return {
      payment,
      orders,
      showSupportDetails: actor.permissions.includes("orders.manage"),
    };
  } catch (error) {
    if (
      (error instanceof PaymentsApiError && error.status === 404) ||
      (error instanceof Error && "status" in error && error.status === 404)
    ) {
      throw new Response(t("payments.routes.marketplace.accountPayment.payment.not.found"), { status: 404 });
    }

    throw error;
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

export default function MarketplaceAccountPaymentRoute() {
  const data = useLoaderData<typeof loader>();
  const statusCopy = paymentStatusCopy(data.payment.status);

  return (
    <Page>
      <PageHeader
        eyebrow={t("payments.routes.marketplace.accountPayment.secure.checkout")}
        title={t("payments.routes.marketplace.accountPayment.payment.title", {
          paymentId: data.payment.payment_id,
        })}
        description={t("payments.routes.marketplace.accountPayment.track.payment.state.purchase.coverage.marketplace")}
        actions={
          <LinkButton href="/account/purchases" tone="secondary">
            {t("payments.routes.marketplace.accountPayment.back.to.purchases")}</LinkButton>
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
                { label: t("payments.routes.marketplace.accountPayment.marketplace.fees"), value: formatMoney(data.payment.marketplace_fee_amount) },
                { label: t("payments.routes.marketplace.accountPayment.buyer.processing.fee.placeholder"), value: formatMoney(data.payment.payment_fee_amount) },
                { label: t("payments.routes.marketplace.accountPayment.seller.net"), value: formatMoney(data.payment.seller_net_amount) },
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
          {data.payment.failure_message || data.payment.status === "cancelled" ? (
            <Surface tone="subtle" elevated>
              <Stack gap={2}>
                <Badge tone="danger">
                  {data.payment.status === "cancelled" ? t("payments.routes.marketplace.accountPayment.payment.session.closed") : t("payments.routes.marketplace.accountPayment.payment.issue")}
                </Badge>
                <Text>
                  {data.payment.failure_message ??
                    t("payments.routes.marketplace.accountPayment.this.secure.payment.session.is.no")}
                </Text>
                {data.payment.status === "failed" || data.payment.status === "cancelled" ? (
                  <LinkButton
                    href={`/account/payments/new?orderIds=${encodeURIComponent(data.payment.order_ids.join(","))}`}
                  >
                    {t("payments.routes.marketplace.accountPayment.retry.payment")}</LinkButton>
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
                        <Text size="sm" tone="secondary">{t("payments.routes.marketplace.accountPayment.seller.net.2")}</Text>
                        <Text>{formatMoney(order.seller_net_amount)}</Text>
                      </Stack>
                    </Grid>
                    <Divider />
                    <LinkButton href={`/account/purchases/${order.order_id}`} tone="secondary">
                      {t("payments.routes.marketplace.accountPayment.open.purchase")}</LinkButton>
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
