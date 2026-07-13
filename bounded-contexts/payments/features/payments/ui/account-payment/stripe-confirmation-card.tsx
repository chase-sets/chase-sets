import { formatMoney, t } from "@chase-sets/localization";
import { useEffect, useRef, useState } from "react";
import { useRevalidator } from "react-router";
import {
  Badge,
  Banner,
  Button,
  CheckoutStickyActionBar,
  EmbeddedProviderSurface,
  MountPoint,
  SecurePaymentIndicator,
  Skeleton,
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

type StripePaymentElementOptions = {
  wallets: {
    applePay: "auto";
    googlePay: "auto";
  };
  defaultValues?: {
    billingDetails: {
      email: string;
    };
  };
};

type StripeCheckoutController = {
  createPaymentElement(options: StripePaymentElementOptions): StripePaymentElement;
  loadActions(): Promise<StripeCheckoutActionsLoadResult>;
  changeAppearance?(appearance: StripeElementsAppearance): void;
};

type StripeCheckoutActionsLoadResult = {
  type?: "success" | "error";
  actions?: StripeCheckoutActions;
  error?: { message?: string };
};

type StripeCheckoutActions = {
  confirm(options?: { redirect: "if_required"; email?: string }): Promise<{ error?: { message?: string } }>;
  changeAppearance?(appearance: StripeElementsAppearance): void;
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
  create(type: "payment", options: StripePaymentElementOptions): StripePaymentElement;
  update?(options: { appearance: StripeElementsAppearance }): void;
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

const POLL_INTERVAL_MS = 2_000;
const POLL_MAX_INTERVAL_MS = 30_000;
const POLL_MAX_DURATION_MS = 5 * 60_000;

type ConfirmPhase = "idle" | "confirming" | "processing";

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
  const [confirmPhase, setConfirmPhase] = useState<ConfirmPhase>("idle");

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
        const paymentElementOptions: StripePaymentElementOptions = {
          wallets: {
            applePay: "auto",
            googlePay: "auto",
          },
          ...(buyerEmail
            ? {
                defaultValues: {
                  billingDetails: {
                    email: buyerEmail,
                  },
                },
              }
            : {}),
        };
        const paymentElement = checkout
          ? checkout.createPaymentElement(paymentElementOptions)
          : elements!.create("payment", paymentElementOptions);
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
    buyerEmail,
    payment.payment_id,
    payment.processor_client_secret,
    payment.processor_publishable_key,
    payment.status,
  ]);

  // Theme changes restyle the mounted Payment Element in place. Remounting here
  // would destroy whatever the buyer has already typed.
  useEffect(() => {
    if (appearanceVersion === 0 || !isReady) {
      return;
    }

    const container = containerRef.current;
    if (!container) {
      return;
    }

    if (checkoutRef.current) {
      const appearance = createStripeElementsAppearance({ includeRules: false, scope: container });
      if (checkoutRef.current.changeAppearance) {
        checkoutRef.current.changeAppearance(appearance);
      } else {
        checkoutActionsRef.current?.changeAppearance?.(appearance);
      }
      return;
    }

    elementsRef.current?.update?.({ appearance: createStripeElementsAppearance({ scope: container }) });
  }, [appearanceVersion, isReady]);

  useEffect(() => {
    if (payment.status !== "pending-confirmation") {
      return;
    }

    let cancelled = false;
    let timeoutId: number | null = null;
    let consecutiveFailures = 0;
    const startedAt = Date.now();
    const paymentsApi = createBrowserPaymentsApiClient();

    const schedule = () => {
      if (cancelled || Date.now() - startedAt >= POLL_MAX_DURATION_MS) {
        // Webhook delivery and reconciliation cover the tail; the buyer can
        // also refresh. Stop burning requests on a stuck confirmation.
        return;
      }

      const delay = Math.min(POLL_INTERVAL_MS * 2 ** consecutiveFailures, POLL_MAX_INTERVAL_MS);
      timeoutId = window.setTimeout(poll, delay);
    };

    const poll = () => {
      void paymentsApi
        .getAccountPayment(payment.payment_id)
        .then((latestPayment) => {
          if (cancelled) {
            return;
          }

          consecutiveFailures = 0;
          if (latestPayment.status !== "pending-confirmation") {
            void revalidator.revalidate();
            return;
          }

          schedule();
        })
        .catch(() => {
          if (cancelled) {
            return;
          }

          consecutiveFailures += 1;
          schedule();
        });
    };

    schedule();

    return () => {
      cancelled = true;
      if (timeoutId !== null) {
        window.clearTimeout(timeoutId);
      }
    };
  }, [payment.payment_id, payment.status, revalidator]);

  async function handleConfirm() {
    if (confirmPhase !== "idle") {
      return;
    }

    if (!stripeRef.current || (checkoutRef.current ? !checkoutActionsRef.current : !elementsRef.current)) {
      setErrorMessage(t("payments.routes.marketplace.accountPayment.stripe.is.still.loading"));
      return;
    }

    if (checkoutRef.current && !buyerEmail) {
      setErrorMessage(t("payments.routes.marketplace.accountPayment.stripe.buyer.email.is.required"));
      return;
    }

    setConfirmPhase("confirming");
    setErrorMessage(null);
    try {
      const result = checkoutRef.current
        ? await checkoutActionsRef.current!.confirm({ redirect: "if_required", email: buyerEmail ?? undefined })
        : await stripeRef.current.confirmPayment({
            elements: elementsRef.current!,
            redirect: "if_required",
          });

      if (result.error?.message) {
        setErrorMessage(result.error.message);
        setConfirmPhase("idle");
        return;
      }

      // Confirm succeeded; the payment status only resolves once the webhook
      // lands. Keep the form locked until the route reflects that truth.
      setConfirmPhase("processing");
      window.setTimeout(() => {
        void revalidator.revalidate();
      }, 500);
    } catch (error) {
      setErrorMessage(
        error instanceof Error && error.message
          ? error.message
          : t("payments.routes.marketplace.accountPayment.the.secure.processor.could.not.complete"),
      );
      setConfirmPhase("idle");
    }
  }

  const confirmButtonLabel =
    confirmPhase === "processing"
      ? t("payments.routes.marketplace.accountPayment.processing.payment")
      : confirmPhase === "confirming"
        ? t("payments.routes.marketplace.accountPayment.confirming.payment")
        : t("payments.routes.marketplace.accountPayment.confirm.payment");

  const confirmButton = (sticky: boolean) => (
    <Button
      type="button"
      onClick={handleConfirm}
      disabled={!isReady || confirmPhase !== "idle"}
      size="lg"
      leadingIcon="lock"
      block={sticky}
      aria-label={
        sticky
          ? t("payments.routes.marketplace.accountPayment.payment.confirmation.sticky.label", {
              value: confirmButtonLabel,
            })
          : undefined
      }
    >
      {confirmButtonLabel}
    </Button>
  );

  return (
    <>
      <CheckoutStickyActionBar
        label={t("payments.routes.marketplace.accountPayment.payment.actions")}
        totalLabel={t("payments.routes.marketplace.accountPayment.total")}
        total={formatMoney(payment.amount, "USD")}
        context={t("payments.routes.marketplace.accountPayment.secure.payment")}
        reassurance={<SecurePaymentIndicator label={t("payments.routes.marketplace.accountPayment.secure.payment")} />}
        primaryAction={confirmButton(true)}
      />
      <Surface elevated glow>
        <Stack gap={3}>
          <Badge tone="accent">{t("payments.routes.marketplace.accountPayment.secure.payment")}</Badge>
          <Text>{t("payments.routes.marketplace.accountPayment.payment.is.ready.enter.your.payment")}</Text>
          <EmbeddedProviderSurface
            minHeight="md"
            aria-busy={!isReady || undefined}
            data-testid="payment-element-container"
          >
            {!isReady ? <Skeleton height="lg" data-testid="payment-element-skeleton" /> : null}
            <MountPoint ref={containerRef} purpose="provider" />
          </EmbeddedProviderSurface>
          {errorMessage ? (
            <Banner
              tone="danger"
              title={t("payments.routes.marketplace.accountPayment.payment.issue")}
              description={errorMessage}
            />
          ) : null}
          {confirmPhase === "processing" ? (
            <Banner
              tone="info"
              title={t("payments.routes.marketplace.accountPayment.payment.in.progress")}
              description={t("payments.routes.marketplace.accountPayment.the.payment.is.being.updated.by")}
            />
          ) : null}
          {confirmButton(false)}
        </Stack>
      </Surface>
    </>
  );
}
