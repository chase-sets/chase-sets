import { formatMoney, t } from "@chase-sets/localization";
import { loadStripe } from "@stripe/stripe-js";
import type {
  Stripe,
  StripeCheckoutElementsSdk,
  StripeCheckoutLoadActionsResult,
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

// Once a buyer's first captured payment attaches an email-bearing processor
// customer to their account, every later Checkout Session already owns that
// email and Stripe refuses a defaultValues email at load time with this exact
// sentence. The load-actions error carries no code (`code` is always null in
// @stripe/stripe-js), so the byte-exact observed sentence is the only contract
// available to match; any reworded, partial, or near-match message fails
// closed and surfaces unchanged instead of retrying.
const SESSION_OWNED_EMAIL_REFUSAL =
  "You cannot update the email because a `customer_email` or `customer` with an email is already set on the Checkout Session.";

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
  // True when the mount fell back to the session-owned email because Stripe
  // refused the defaultValues email; the confirm must then not resend it.
  const sessionOwnsEmailRef = useRef(false);
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
    // Effect-owned record of whichever element this run currently has mounted,
    // assigned immediately at mount so every exit path — load-result errors,
    // load rejections, cancellation, and effect cleanup — destroys it through
    // this one idempotent routine. Ownership clears before destroy so a stale
    // async continuation can never destroy a newer run's mount.
    let mountedElement: StripePaymentElement | null = null;
    const destroyMountedElement = () => {
      const element = mountedElement;
      mountedElement = null;
      element?.destroy();
    };
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
        let checkout = clientSecret.startsWith("cs_")
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
        let paymentElement = checkout
          ? checkout.createPaymentElement({ wallets })
          : elements!.create("payment", {
              wallets,
              defaultValues: JSON.parse(defaultValuesKey) as PaymentElementDefaultValues,
            });
        paymentElement.mount(container);
        mountedElement = paymentElement;

        // The live provider delivers the session-owned-email refusal by
        // REJECTING this promise (an IntegrationError alongside an unhandled
        // `loaderror` event), not by resolving the typed { type: "error" }
        // result. Normalize exactly that rejection — byte-exact sentence, and
        // only when this mount actually sent a defaultValues email — into the
        // result shape the single retry below pins against. Every other
        // rejection propagates unchanged into the fail-closed catch.
        let checkoutActionsResult: StripeCheckoutLoadActionsResult | null = null;
        if (checkout) {
          try {
            checkoutActionsResult = await checkout.loadActions();
          } catch (error) {
            if (!(buyerEmail && error instanceof Error && error.message === SESSION_OWNED_EMAIL_REFUSAL)) {
              throw error;
            }
            checkoutActionsResult = { type: "error", error: { message: error.message, code: null } };
          }
        }
        if (cancelled) {
          destroyMountedElement();
          return;
        }

        // The session already owns the buyer email (repeat buyer): retry the
        // same mount exactly once without the defaultValues email and let the
        // session-owned email stay authoritative. Every other load error —
        // including this refusal persisting on the retry — still surfaces
        // unchanged through the fail-closed branch below.
        if (
          checkout &&
          buyerEmail &&
          checkoutActionsResult?.type === "error" &&
          checkoutActionsResult.error.message === SESSION_OWNED_EMAIL_REFUSAL
        ) {
          destroyMountedElement();
          checkout = stripe.initCheckoutElementsSdk({
            clientSecret,
            elementsOptions: {
              appearance: checkoutElementsAppearance,
            },
          });
          paymentElement = checkout.createPaymentElement({ wallets });
          paymentElement.mount(container);
          mountedElement = paymentElement;
          checkoutActionsResult = await checkout.loadActions();
          if (cancelled) {
            destroyMountedElement();
            return;
          }
          sessionOwnsEmailRef.current = true;
        }

        if (checkoutActionsResult?.type === "error") {
          destroyMountedElement();
          throw new Error(
            checkoutActionsResult.error.message ||
              t("payments.routes.marketplace.accountPayment.stripe.could.not.load"),
          );
        }

        const checkoutActions = checkoutActionsResult?.type === "success" ? checkoutActionsResult.actions : null;
        if (checkout && !checkoutActions) {
          destroyMountedElement();
          throw new Error(t("payments.routes.marketplace.accountPayment.stripe.could.not.load"));
        }

        stripeRef.current = stripe;
        checkoutRef.current = checkout;
        checkoutActionsRef.current = checkoutActions;
        elementsRef.current = elements;
        setIsReady(true);
      })
      .catch((error) => {
        // A loadActions rejection lands here with the element still mounted;
        // destroy whatever this run still owns before surfacing the error.
        destroyMountedElement();
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
      destroyMountedElement();
      checkoutRef.current = null;
      checkoutActionsRef.current = null;
      elementsRef.current = null;
      stripeRef.current = null;
      sessionOwnsEmailRef.current = false;
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
          // After the session-owned-email fallback the session is the email
          // authority; resending the buyer email would hit the same refusal.
          email: sessionOwnsEmailRef.current ? undefined : (buyerEmail ?? undefined),
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
