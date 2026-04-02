import { useEffect, useRef, useState } from "react";
import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import {
  useLoaderData,
  useRevalidator,
} from "react-router";
import {
  Badge,
  Button,
  Card,
  LinkButton,
  Page,
  PageHeader,
  PageSection,
  Stack,
  Text,
} from "@chase-sets/design-system";
import {
  PaymentsApiError,
  type PaymentsPaymentDetail,
} from "@chase-sets/payments/web";
import {
  ApiError as OrderingApiError,
  type OrderingOrderDetail,
} from "@chase-sets/ordering/web";
import { createMarketplaceOrderingApiClient, createMarketplacePaymentsApiClient } from "../api.server";
import { requireMarketplaceActor } from "../auth.server";
import { buildMarketplaceMeta } from "../seo";

type StripePaymentElement = {
  mount(target: HTMLElement | string): void;
  destroy(): void;
};

type StripeElements = {
  create(type: "payment"): StripePaymentElement;
};

type StripeClient = {
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

export async function loader({ request, params }: LoaderFunctionArgs) {
  await requireMarketplaceActor(request, "orders.view");
  const paymentsApi = createMarketplacePaymentsApiClient(request);
  const orderingApi = createMarketplaceOrderingApiClient(request);

  try {
    const payment = await paymentsApi.getBuyerPayment(params.paymentId!);
    const orders = await Promise.all(
      payment.order_ids.map((orderId) => orderingApi.getBuyerOrder(orderId)),
    );

    return {
      payment,
      orders,
    };
  } catch (error) {
    if (
      (error instanceof PaymentsApiError && error.status === 404) ||
      (error instanceof OrderingApiError && error.status === 404)
    ) {
      throw new Response("Payment not found.", { status: 404 });
    }

    throw error;
  }
}

export const meta: MetaFunction = () =>
  buildMarketplaceMeta({ title: "Payment | Marketplace" });

function StripeConfirmationCard({ payment }: { payment: PaymentsPaymentDetail }) {
  const revalidator = useRevalidator();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const stripeRef = useRef<StripeClient | null>(null);
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
      .then((factory) => {
        if (cancelled) {
          return;
        }

        const stripe = factory(payment.processor_publishable_key!);
        const elements = stripe.elements({
          clientSecret: payment.processor_client_secret!,
        });
        const paymentElement = elements.create("payment");
        paymentElement.mount(containerRef.current!);

        stripeRef.current = stripe;
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
    if (!stripeRef.current || !elementsRef.current) {
      setErrorMessage("Stripe is still loading.");
      return;
    }

    setIsSubmitting(true);
    setErrorMessage(null);
    try {
      const result = await stripeRef.current.confirmPayment({
        elements: elementsRef.current,
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
    <Card>
      <Stack gap={3}>
        <Text>
          Payment is ready. Enter your payment details and confirm to let Stripe capture the charge.
        </Text>
        <div ref={containerRef} />
        {errorMessage ? <Text>{errorMessage}</Text> : null}
        <Button type="button" onClick={handleConfirm} disabled={!isReady || isSubmitting}>
          {isSubmitting ? "Confirming payment..." : "Confirm payment"}
        </Button>
      </Stack>
    </Card>
  );
}

export default function MarketplaceAccountPaymentRoute() {
  const data = useLoaderData<typeof loader>();

  return (
    <Page>
      <PageHeader
        eyebrow="Buyer"
        title={`Payment ${data.payment.payment_id}`}
        description="Payments owns external money movement while ordering owns the order state."
        actions={
          <LinkButton href="/account/orders" tone="secondary">
            Back to orders
          </LinkButton>
        }
      />

      <PageSection title="Summary">
        <Card>
          <Stack gap={2}>
            <Badge tone={statusTone(data.payment.status)}>{data.payment.status}</Badge>
            <Text>Total: {formatMoney(data.payment.amount)}</Text>
            <Text>Processor: {data.payment.processor_name}</Text>
            <Text>Orders: {data.payment.order_ids.join(", ")}</Text>
            {data.payment.failure_message ? <Text>{data.payment.failure_message}</Text> : null}
            {data.payment.status === "failed" ? (
              <LinkButton
                href={`/account/payments/new?orderIds=${encodeURIComponent(data.payment.order_ids.join(","))}`}
              >
                Retry payment
              </LinkButton>
            ) : null}
          </Stack>
        </Card>
      </PageSection>

      {data.payment.status === "pending-confirmation" ? (
        <PageSection title="Stripe confirmation">
          {data.payment.processor_client_secret && data.payment.processor_publishable_key ? (
            <StripeConfirmationCard payment={data.payment} />
          ) : (
            <Card>
              <Text>Stripe payment confirmation is not configured for this environment.</Text>
            </Card>
          )}
        </PageSection>
      ) : null}

      <PageSection title="Orders">
        <Stack gap={3}>
          {data.orders.map((order: OrderingOrderDetail) => (
            <Card key={order.order_id}>
              <Stack gap={1}>
                <Text weight="semibold">Order {order.order_id}</Text>
                <Text size="sm" tone="secondary">
                  Status: {order.status}
                </Text>
                <Text>Total: {formatMoney(order.total_amount)}</Text>
                <LinkButton href={`/account/orders/${order.order_id}`} tone="secondary">
                  Open order
                </LinkButton>
              </Stack>
            </Card>
          ))}
        </Stack>
      </PageSection>
    </Page>
  );
}
