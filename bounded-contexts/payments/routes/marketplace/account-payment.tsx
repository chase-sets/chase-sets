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
    return Promise.reject(new Error("Stripe can only load in the browser."));
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

          reject(new Error("Stripe.js loaded without exposing Stripe."));
        });
        existingScript.addEventListener("error", () => {
          reject(new Error("Stripe.js failed to load."));
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

        reject(new Error("Stripe.js loaded without exposing Stripe."));
      };
      script.onerror = () => {
        reject(new Error("Stripe.js failed to load."));
      };
      document.head.appendChild(script);
    });
  }

  return stripeFactoryPromise;
}

function formatMoney(amount: string) {
  return `$${amount}`;
}

function statusTone(status: string) {
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
        label: "Ready for payment",
        description: "Your checkout is ready. Confirm payment in the secure form.",
      };
    case "authorized":
      return {
        label: "Payment authorized",
        description: "The payment was accepted and is waiting for final capture.",
      };
    case "captured":
      return {
        label: "Paid",
        description: "Payment is complete and the covered purchases can move forward.",
      };
    case "failed":
      return {
        label: "Payment needs attention",
        description: "The secure processor could not complete this payment.",
      };
    case "cancelled":
      return {
        label: "Payment cancelled",
        description: "This payment session is closed. Start a new payment to continue.",
      };
    default:
      return {
        label: "Payment in progress",
        description: "The payment is being updated by the secure processor.",
      };
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
      throw new Response("Payment not found.", { status: 404 });
    }

    throw error;
  }
}

export const meta: MetaFunction = () =>
  buildOpenGraphMeta({ title: "Payment | Marketplace" });

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
          setErrorMessage(error instanceof Error ? error.message : "Stripe could not load.");
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
      setErrorMessage("Stripe is still loading.");
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
        <Badge tone="accent">Secure payment</Badge>
        <Text>
          Payment is ready. Enter your payment details in the secure managed form and confirm the charge.
        </Text>
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
          {isSubmitting ? "Confirming payment..." : "Confirm payment"}
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
        eyebrow="Secure Checkout"
        title={`Payment ${data.payment.payment_id}`}
        description="Track payment state, purchase coverage, marketplace fees, and seller net from one protected payment surface."
        actions={
          <LinkButton href="/account/purchases" tone="secondary">
            Back to purchases
          </LinkButton>
        }
      />

      <CheckoutLayout
        summary={
          <Stack gap={4}>
            <OrderSummary
              title="Payment Summary"
              lines={[
                { label: "Status", value: <Badge tone={statusTone(data.payment.status)}>{statusCopy.label}</Badge> },
                { label: "Wallet balance used", value: formatMoney(data.payment.balance_credit_amount) },
                { label: "External payment", value: formatMoney(data.payment.processor_amount) },
                { label: "Marketplace fees", value: formatMoney(data.payment.marketplace_fee_amount) },
                { label: "Payment fees", value: formatMoney(data.payment.payment_fee_amount) },
                { label: "Seller net", value: formatMoney(data.payment.seller_net_amount) },
                { label: "Processor", value: data.payment.processor_name },
              ]}
              total={formatMoney(data.payment.amount)}
            />
            <CheckoutTrustPanel
              items={[
                {
                  icon: "lock",
                  title: "Secure Payment Flow",
                  description: "Payment details stay inside the secure managed form.",
                },
                {
                  icon: "shield",
                  title: "Purchase Coverage",
                  description: `Covers ${data.payment.order_ids.length} purchase${data.payment.order_ids.length === 1 ? "" : "s"}.`,
                },
                {
                  icon: "creditCard",
                  title: "Fee Transparency",
                  description: "Marketplace and processor fees stay visible before and after capture.",
                },
              ]}
            />
          </Stack>
        }
      >
        <Stack gap={4}>
          {data.payment.failure_message ? (
            <Surface tone="subtle" elevated>
              <Stack gap={2}>
                <Badge tone="danger">Payment issue</Badge>
                <Text>{data.payment.failure_message}</Text>
                {data.payment.status === "failed" ? (
                  <LinkButton
                    href={`/account/payments/new?orderIds=${encodeURIComponent(data.payment.order_ids.join(","))}`}
                  >
                    Retry payment
                  </LinkButton>
                ) : null}
              </Stack>
            </Surface>
          ) : null}

          <PageSection title="Payment Status">
            <Surface elevated>
              <Stack gap={2}>
                <Badge tone={statusTone(data.payment.status) as any}>{statusCopy.label}</Badge>
                <Text>{statusCopy.description}</Text>
              </Stack>
            </Surface>
          </PageSection>

          <PageSection title="Event Timeline">
            <Surface elevated>
              <Stack gap={2}>
                <Stack gap={1}>
                  <Badge tone="success">Payment created</Badge>
                  <Text size="sm" tone="secondary">
                    {new Date(data.payment.created_at).toLocaleString()}
                  </Text>
                </Stack>
                <Stack gap={1}>
                  <Badge tone={data.payment.captured_at ? "success" : statusTone(data.payment.status) as any}>
                    {data.payment.captured_at
                      ? "Payment captured"
                      : data.payment.failed_at
                        ? "Payment failed"
                        : data.payment.cancelled_at
                          ? "Payment cancelled"
                          : "Waiting for provider event"}
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
            <PageSection title="Support Details">
              <Surface elevated>
                <Stack gap={2}>
                  <Text size="sm" tone="secondary">Internal payment: {data.payment.payment_id}</Text>
                  <Text size="sm" tone="secondary">Account: {data.payment.buyer_account_id}</Text>
                  <Text size="sm" tone="secondary">
                    Processor reference: {data.payment.processor_payment_reference}
                  </Text>
                  <Text size="sm" tone="secondary">
                    Processor status: {data.payment.processor_status}
                  </Text>
                  <Text size="sm" tone="secondary">
                    Source: {data.payment.source_context ?? "direct"} / {data.payment.source_reference_id ?? "none"}
                  </Text>
                  <Text size="sm" tone="secondary">
                    Updated: {new Date(data.payment.updated_at).toLocaleString()}
                  </Text>
                  {data.payment.failure_code ? (
                    <Text size="sm" tone="secondary">
                      Failure code: {data.payment.failure_code}
                    </Text>
                  ) : null}
                </Stack>
              </Surface>
            </PageSection>
          ) : null}

          {data.payment.status === "pending-confirmation" ? (
            <PageSection title="Secure Payment">
              {data.payment.processor_client_secret && data.payment.processor_publishable_key ? (
                <StripeConfirmationCard payment={data.payment} />
              ) : (
                <Surface tone="subtle" elevated>
                  <Text>Secure payment confirmation is not configured for this environment.</Text>
                </Surface>
              )}
            </PageSection>
          ) : data.payment.processor_amount === "0.00" ? (
            <PageSection title="Wallet Balance">
              <Surface elevated glow>
                <Stack gap={2}>
                  <Badge tone="success">Paid with balance</Badge>
                  <Text>
                    This purchase was covered by available wallet balance and did not need an external charge.
                  </Text>
                </Stack>
              </Surface>
            </PageSection>
          ) : null}

          <PageSection title="Purchases">
            <Stack gap={3}>
              {data.orders.map((order: PurchaseDetail) => (
                <Surface key={order.order_id} elevated>
                  <Stack gap={3}>
                    <Grid columns={{ base: 1, md: 3 }} gap={3}>
                      <Stack gap={1}>
                        <Text weight="semibold">Purchase {order.order_id}</Text>
                        <Badge tone="accent">{order.status}</Badge>
                      </Stack>
                      <Stack gap={1}>
                        <Text size="sm" tone="secondary">Total</Text>
                        <Text weight="semibold">{formatMoney(order.total_amount)}</Text>
                      </Stack>
                      <Stack gap={1}>
                        <Text size="sm" tone="secondary">Seller net</Text>
                        <Text>{formatMoney(order.seller_net_amount)}</Text>
                      </Stack>
                    </Grid>
                    <Divider />
                    <LinkButton href={`/account/purchases/${order.order_id}`} tone="secondary">
                      Open purchase
                    </LinkButton>
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
