import { formatMoney, t } from "@chase-sets/localization";
import { loadStripe } from "@stripe/stripe-js";
import type {
  Stripe,
  StripeCheckoutElementsSdk,
  StripeCheckoutLoadActionsSuccess,
  StripeElements,
  StripePaymentElement,
  StripePaymentElementOptions,
} from "@stripe/stripe-js";
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
import type { PaymentElementDefaultValues } from "./account-payment-contracts";

type StripeConfirmablePayment = Readonly<{
  payment_id: string;
  amount: string;
  status: string;
  processor_client_secret: string | null;
  processor_publishable_key: string | null;
}>;

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
  defaultValues,
}: {
  payment: StripeConfirmablePayment;
  defaultValues: PaymentElementDefaultValues | null;
}) {
  const revalidator = useRevalidator();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const stripeRef = useRef<Stripe | null>(null);
  const checkoutRef = useRef<StripeCheckoutElementsSdk | null>(null);
  const checkoutActionsRef = useRef<StripeCheckoutLoadActionsSuccess | null>(null);
  const elementsRef = useRef<StripeElements | null>(null);
  const elementRef = useRef<StripePaymentElement | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [appearanceVersion, setAppearanceVersion] = useState(0);
  const [isReady, setIsReady] = useState(false);
  const [confirmPhase, setConfirmPhase] = useState<ConfirmPhase>("idle");
  const buyerEmail = defaultValues?.billingDetails.email.trim() || null;
  const defaultValuesKey = JSON.stringify(defaultValues);
  const missingBuyerEmail = payment.status === "pending-confirmation" && !buyerEmail;

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
      missingBuyerEmail ||
      !container
    ) {
      return;
    }

    let cancelled = false;
    setErrorMessage(null);
    setIsReady(false);

    void loadStripe(payment.processor_publishable_key!)
      .then(async (stripe) => {
        if (cancelled) {
          return;
        }

        if (!stripe) {
          throw new Error(t("payments.routes.marketplace.accountPayment.stripe.could.not.load"));
        }

        const clientSecret = payment.processor_client_secret!;
        const stripeElementsAppearance = createStripeElementsAppearance({ scope: container });
        const checkoutElementsAppearance = createStripeElementsAppearance({ includeRules: false, scope: container });
        // Custom Checkout (Checkout Session client secrets, prefixed `cs_`) carries buyer
        // defaultValues on the SDK itself; the Payment Element path carries them per-element.
        const checkout = clientSecret.startsWith("cs_")
          ? stripe.initCheckoutElementsSdk({
              clientSecret,
              elementsOptions: {
                appearance: checkoutElementsAppearance,
              },
              defaultValues: buyerEmail ? { email: buyerEmail } : undefined,
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
        const wallets: StripePaymentElementOptions["wallets"] = {
          applePay: "auto",
          googlePay: "auto",
        };
        const paymentElement = checkout
          ? checkout.createPaymentElement({ wallets })
          : elements!.create("payment", {
              wallets,
              defaultValues: JSON.parse(defaultValuesKey) as PaymentElementDefaultValues,
            });
        paymentElement.mount(container);

        const checkoutActionsResult = checkout ? await checkout.loadActions() : null;
        if (cancelled) {
          paymentElement.destroy();
          return;
        }

        if (checkoutActionsResult?.type === "error") {
          paymentElement.destroy();
          throw new Error(
            checkoutActionsResult.error.message ||
              t("payments.routes.marketplace.accountPayment.stripe.could.not.load"),
          );
        }

        const checkoutActions = checkoutActionsResult?.type === "success" ? checkoutActionsResult.actions : null;
        if (checkout && !checkoutActions) {
          paymentElement.destroy();
          throw new Error(t("payments.routes.marketplace.accountPayment.stripe.could.not.load"));
        }

        stripeRef.current = stripe;
        checkoutRef.current = checkout;
        checkoutActionsRef.current = checkoutActions;
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
    defaultValuesKey,
    missingBuyerEmail,
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
      checkoutRef.current.changeAppearance(createStripeElementsAppearance({ includeRules: false, scope: container }));
      return;
    }

    void elementsRef.current?.update({ appearance: createStripeElementsAppearance({ scope: container }) });
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

    setConfirmPhase("confirming");
    setErrorMessage(null);
    try {
      if (checkoutRef.current) {
        const confirmResult = await checkoutActionsRef.current!.confirm({
          redirect: "if_required",
          email: buyerEmail ?? undefined,
        });
        if (confirmResult.type === "error") {
          setErrorMessage(confirmResult.error.message);
          setConfirmPhase("idle");
          return;
        }
      } else {
        const paymentResult = await stripeRef.current.confirmPayment({
          elements: elementsRef.current!,
          redirect: "if_required",
        });
        if (paymentResult.error) {
          setErrorMessage(
            paymentResult.error.message ??
              t("payments.routes.marketplace.accountPayment.the.secure.processor.could.not.complete"),
          );
          setConfirmPhase("idle");
          return;
        }
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
          {missingBuyerEmail || errorMessage ? (
            <Banner
              tone="danger"
              title={t("payments.routes.marketplace.accountPayment.payment.issue")}
              description={
                missingBuyerEmail
                  ? t("payments.routes.marketplace.accountPayment.stripe.buyer.email.is.required")
                  : errorMessage!
              }
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
