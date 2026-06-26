import { t } from "@chase-sets/localization";
import { useEffect, useRef, useState } from "react";
import { useRevalidator } from "react-router";
import {
  Badge,
  Button,
  Inset,
  Stack,
  Surface,
  Text,
  createStripeElementsAppearance,
  observeStripeAppearance,
  stripeAppearanceSnapshot,
} from "@chase-sets/design-system";
import { createPaymentsApiClient } from "../../../../client";
import type { PaymentsPaymentDetail } from "../../api/contracts";

type StripeElementsAppearance = ReturnType<typeof createStripeElementsAppearance>;

type StripePaymentElement = {
  mount(target: HTMLElement | string): void;
  destroy(): void;
};

type StripeCheckoutController = {
  createPaymentElement(): StripePaymentElement;
  loadActions(): Promise<StripeCheckoutActionsLoadResult>;
};

type StripeCheckoutActionsLoadResult = {
  type?: "success" | "error";
  actions?: StripeCheckoutActions;
  error?: { message?: string };
};

type StripeCheckoutActions = {
  confirm(options?: { redirect: "if_required"; email?: string }): Promise<{ error?: { message?: string } }>;
};

type StripeElementsOptions = {
  clientSecret: string;
  appearance: StripeElementsAppearance;
};

type StripeCheckoutOptions = {
  clientSecret: string;
  elementsOptions: {
    appearance: StripeElementsAppearance;
  };
};

type StripeElements = {
  create(type: "payment"): StripePaymentElement;
};

type StripeClient = {
  initCheckoutElementsSdk?: (
    options: StripeCheckoutOptions,
  ) => StripeCheckoutController | Promise<StripeCheckoutController>;
  initCheckout?: (options: StripeCheckoutOptions) => StripeCheckoutController | Promise<StripeCheckoutController>;
  elements(options: StripeElementsOptions): StripeElements;
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
      const existingScript = document.querySelector<HTMLScriptElement>('script[data-stripe-js="true"]');

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
      script.src = "https://js.stripe.com/dahlia/stripe.js";
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

function createBrowserPaymentsApiClient() {
  return createPaymentsApiClient({
    fetch: (input, init) => globalThis.fetch(input, init),
  });
}

export function StripeConfirmationCard({
  payment,
  buyerEmail,
}: {
  payment: PaymentsPaymentDetail;
  buyerEmail: string | null;
}) {
  const revalidator = useRevalidator();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const stripeRef = useRef<StripeClient | null>(null);
  const checkoutRef = useRef<StripeCheckoutController | null>(null);
  const checkoutActionsRef = useRef<StripeCheckoutActions | null>(null);
  const elementsRef = useRef<StripeElements | null>(null);
  const elementRef = useRef<StripePaymentElement | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [appearanceVersion, setAppearanceVersion] = useState(0);
  const [isReady, setIsReady] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }

    let currentSnapshot = stripeAppearanceSnapshot({ scope: container });

    return observeStripeAppearance({ scope: container }, () => {
      const nextSnapshot = stripeAppearanceSnapshot({ scope: container });
      if (nextSnapshot === currentSnapshot) {
        return;
      }

      currentSnapshot = nextSnapshot;
      setAppearanceVersion((version) => version + 1);
    });
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (
      payment.status !== "pending-confirmation" ||
      !payment.processor_client_secret ||
      !payment.processor_publishable_key ||
      !container
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
        const stripeElementsAppearance = createStripeElementsAppearance({ scope: container });
        const checkoutElementsAppearance = createStripeElementsAppearance({ includeRules: false, scope: container });
        const initCheckoutElements = stripe.initCheckoutElementsSdk ?? stripe.initCheckout;
        const checkout =
          clientSecret.startsWith("cs_") && initCheckoutElements
            ? await initCheckoutElements({
                clientSecret,
                elementsOptions: {
                  appearance: checkoutElementsAppearance,
                },
              })
            : null;
        if (cancelled) {
          return;
        }

        const elements = checkout
          ? null
          : stripe.elements({
              clientSecret,
              appearance: stripeElementsAppearance,
            });
        const paymentElement = checkout ? checkout.createPaymentElement() : elements!.create("payment");
        paymentElement.mount(container);

        const checkoutActionsResult = checkout ? await checkout.loadActions() : null;
        if (cancelled) {
          paymentElement.destroy();
          return;
        }

        if (checkoutActionsResult?.type === "error" || checkoutActionsResult?.error?.message) {
          paymentElement.destroy();
          throw new Error(
            checkoutActionsResult.error?.message ??
              t("payments.routes.marketplace.accountPayment.stripe.could.not.load"),
          );
        }

        if (checkout && !checkoutActionsResult?.actions) {
          paymentElement.destroy();
          throw new Error(t("payments.routes.marketplace.accountPayment.stripe.could.not.load"));
        }

        stripeRef.current = stripe;
        checkoutRef.current = checkout;
        checkoutActionsRef.current = checkoutActionsResult?.actions ?? null;
        elementsRef.current = elements;
        elementRef.current = paymentElement;
        setIsReady(true);
      })
      .catch((error) => {
        if (!cancelled) {
          setErrorMessage(
            error instanceof Error
              ? error.message
              : t("payments.routes.marketplace.accountPayment.stripe.could.not.load"),
          );
        }
      });

    return () => {
      cancelled = true;
      elementRef.current?.destroy();
      elementRef.current = null;
      checkoutRef.current = null;
      checkoutActionsRef.current = null;
      elementsRef.current = null;
      stripeRef.current = null;
      setIsReady(false);
    };
  }, [
    appearanceVersion,
    payment.payment_id,
    payment.processor_client_secret,
    payment.processor_publishable_key,
    payment.status,
  ]);

  useEffect(() => {
    if (payment.status !== "pending-confirmation") {
      return;
    }

    let cancelled = false;
    let pollInFlight = false;
    const paymentsApi = createBrowserPaymentsApiClient();
    const interval = window.setInterval(() => {
      if (pollInFlight) {
        return;
      }

      pollInFlight = true;
      void paymentsApi
        .getAccountPayment(payment.payment_id)
        .then((latestPayment) => {
          if (cancelled || latestPayment.status === "pending-confirmation") {
            return;
          }

          window.clearInterval(interval);
          void revalidator.revalidate();
        })
        .catch(() => {
          if (!cancelled) {
            void revalidator.revalidate();
          }
        })
        .finally(() => {
          pollInFlight = false;
        });
    }, 2_000);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [payment.payment_id, payment.status, revalidator]);

  async function handleConfirm() {
    if (!stripeRef.current || (checkoutRef.current ? !checkoutActionsRef.current : !elementsRef.current)) {
      setErrorMessage(t("payments.routes.marketplace.accountPayment.stripe.is.still.loading"));
      return;
    }

    setIsSubmitting(true);
    setErrorMessage(null);
    try {
      if (checkoutRef.current && !buyerEmail) {
        setErrorMessage(t("payments.routes.marketplace.accountPayment.stripe.buyer.email.is.required"));
        return;
      }

      const result = checkoutRef.current
        ? await checkoutActionsRef.current!.confirm({ redirect: "if_required", email: buyerEmail ?? undefined })
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
        <Text>{t("payments.routes.marketplace.accountPayment.payment.is.ready.enter.your.payment")}</Text>
        <div ref={containerRef} />
        {errorMessage ? (
          <Inset>
            <Text>{errorMessage}</Text>
          </Inset>
        ) : null}
        <Button type="button" onClick={handleConfirm} disabled={!isReady || isSubmitting} size="lg" leadingIcon="lock">
          {isSubmitting
            ? t("payments.routes.marketplace.accountPayment.confirming.payment")
            : t("payments.routes.marketplace.accountPayment.confirm.payment")}
        </Button>
      </Stack>
    </Surface>
  );
}
