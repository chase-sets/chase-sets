import { t } from "@chase-sets/localization";
import { useEffect, useRef, useState } from "react";
import { useRevalidator } from "react-router";
import {
  Badge,
  Banner,
  Button,
  MountPoint,
  Stack,
  Surface,
  Text,
  createStripeElementsAppearance,
  observeStripeAppearance,
  stripeAppearanceSnapshot,
} from "@chase-sets/design-system";
import { createPaymentsApiClient, type PaymentsSavedCheckoutSetupSession } from "../../../../client";

type StripeElementsAppearance = ReturnType<typeof createStripeElementsAppearance>;

type StripePaymentElement = {
  mount(target: HTMLElement | string): void;
  destroy(): void;
};

type StripeElements = {
  create(type: "payment"): StripePaymentElement;
  update?(options: { appearance: StripeElementsAppearance }): void;
};

type StripeSetupClient = {
  elements(options: { clientSecret: string; appearance: StripeElementsAppearance }): StripeElements;
  confirmSetup(options: {
    elements: StripeElements;
    redirect: "if_required";
  }): Promise<{ error?: { message?: string } }>;
};

type StripeSetupFactory = (publishableKey: string) => StripeSetupClient;

let stripeFactoryPromise: Promise<StripeSetupFactory> | null = null;

function loadStripeFactory(): Promise<StripeSetupFactory> {
  if (typeof window === "undefined") {
    return Promise.reject(new Error(t("payments.routes.marketplace.accountPayment.stripe.can.only.load.in.the")));
  }

  const existingFactory = (window as Window & { Stripe?: StripeSetupFactory }).Stripe;
  if (existingFactory) {
    return Promise.resolve(existingFactory);
  }

  if (!stripeFactoryPromise) {
    stripeFactoryPromise = new Promise((resolve, reject) => {
      const existingScript = document.querySelector<HTMLScriptElement>('script[data-stripe-js="true"]');

      if (existingScript) {
        existingScript.addEventListener("load", () => {
          const factory = (window as Window & { Stripe?: StripeSetupFactory }).Stripe;
          if (factory) {
            resolve(factory);
            return;
          }
          reject(new Error(t("payments.routes.marketplace.accountPayment.stripe.js.loaded.without.exposing.stripe")));
        });
        existingScript.addEventListener("error", () =>
          reject(new Error(t("payments.routes.marketplace.accountPayment.stripe.js.failed.to.load"))),
        );
        return;
      }

      const script = document.createElement("script");
      script.async = true;
      script.src = "https://js.stripe.com/dahlia/stripe.js";
      script.dataset.stripeJs = "true";
      script.onload = () => {
        const factory = (window as Window & { Stripe?: StripeSetupFactory }).Stripe;
        if (factory) {
          resolve(factory);
          return;
        }
        reject(new Error(t("payments.routes.marketplace.accountPayment.stripe.js.loaded.without.exposing.stripe.2")));
      };
      script.onerror = () =>
        reject(new Error(t("payments.routes.marketplace.accountPayment.stripe.js.failed.to.load.2")));
      document.head.appendChild(script);
    });
  }

  return stripeFactoryPromise;
}

const POLL_INTERVAL_MS = 2_000;
const POLL_MAX_INTERVAL_MS = 30_000;
const POLL_MAX_DURATION_MS = 5 * 60_000;

type SetupPhase = "idle" | "confirming" | "processing";

export function StripeSetupCard({ setup, onSaved }: { setup: PaymentsSavedCheckoutSetupSession; onSaved: () => void }) {
  const revalidator = useRevalidator();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const stripeRef = useRef<StripeSetupClient | null>(null);
  const elementsRef = useRef<StripeElements | null>(null);
  const elementRef = useRef<StripePaymentElement | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [appearanceVersion, setAppearanceVersion] = useState(0);
  const [isReady, setIsReady] = useState(false);
  const [setupPhase, setSetupPhase] = useState<SetupPhase>("idle");

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
    const clientSecret = setup.processor_client_secret;
    const publishableKey = setup.processor_publishable_key;
    if (!container || !clientSecret || !publishableKey) {
      setErrorMessage(t("payments.routes.marketplace.accountPayment.stripe.could.not.load"));
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

        const stripe = factory(publishableKey);
        const elements = stripe.elements({
          clientSecret,
          appearance: createStripeElementsAppearance({ scope: container }),
        });
        const paymentElement = elements.create("payment");
        paymentElement.mount(container);
        if (cancelled) {
          paymentElement.destroy();
          return;
        }

        stripeRef.current = stripe;
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
      elementsRef.current = null;
      stripeRef.current = null;
      setIsReady(false);
    };
  }, [setup.processor_client_secret, setup.processor_publishable_key, setup.setup_reference_id]);

  // Update the mounted element instead of remounting it so a theme change
  // never clears partially entered payment details.
  useEffect(() => {
    if (appearanceVersion === 0 || !isReady) {
      return;
    }
    const container = containerRef.current;
    if (!container) {
      return;
    }
    elementsRef.current?.update?.({ appearance: createStripeElementsAppearance({ scope: container }) });
  }, [appearanceVersion, isReady]);

  async function reconcileUntilSaved() {
    const paymentsApi = createPaymentsApiClient({ fetch: (input, init) => globalThis.fetch(input, init) });
    let consecutiveFailures = 0;
    const startedAt = Date.now();

    while (Date.now() - startedAt < POLL_MAX_DURATION_MS) {
      try {
        const result = await paymentsApi.reconcileSavedPaymentSetupSession(setup.setup_reference_id);
        if (result.instrument) {
          onSaved();
          void revalidator.revalidate();
          return;
        }
        consecutiveFailures = 0;
      } catch {
        consecutiveFailures += 1;
      }

      const delay = Math.min(POLL_INTERVAL_MS * 2 ** consecutiveFailures, POLL_MAX_INTERVAL_MS);
      await new Promise<void>((resolve) => window.setTimeout(resolve, delay));
    }
  }

  async function handleConfirm() {
    if (setupPhase !== "idle") {
      return;
    }
    if (!stripeRef.current || !elementsRef.current) {
      setErrorMessage(t("payments.routes.marketplace.accountPayment.stripe.is.still.loading"));
      return;
    }

    setSetupPhase("confirming");
    setErrorMessage(null);
    try {
      const result = await stripeRef.current.confirmSetup({
        elements: elementsRef.current,
        redirect: "if_required",
      });
      if (result.error?.message) {
        setErrorMessage(result.error.message);
        setSetupPhase("idle");
        return;
      }

      setSetupPhase("processing");
      await reconcileUntilSaved();
    } catch (error) {
      setErrorMessage(
        error instanceof Error && error.message
          ? error.message
          : t("payments.routes.marketplace.accountPayment.the.secure.processor.could.not.complete"),
      );
      setSetupPhase("idle");
    }
  }

  return (
    <Surface elevated glow>
      <Stack gap={3}>
        <Badge tone="accent">{t("payments.routes.marketplace.accountPayment.secure.payment")}</Badge>
        <Text>{t("payments.routes.marketplace.accountPaymentMethods.manage.payment.methods")}</Text>
        <MountPoint ref={containerRef} purpose="provider" />
        {errorMessage ? (
          <Banner
            tone="danger"
            title={t("payments.routes.marketplace.accountPayment.payment.issue")}
            description={errorMessage}
          />
        ) : null}
        {setupPhase === "processing" ? (
          <Banner
            tone="info"
            title={t("payments.routes.marketplace.accountPayment.payment.in.progress")}
            description={t("payments.routes.marketplace.accountPayment.the.payment.is.being.updated.by")}
          />
        ) : null}
        <Button
          type="button"
          onClick={handleConfirm}
          disabled={!isReady || setupPhase !== "idle"}
          size="lg"
          leadingIcon="lock"
        >
          {setupPhase === "processing"
            ? t("payments.routes.marketplace.accountPayment.processing.payment")
            : setupPhase === "confirming"
              ? t("payments.routes.marketplace.accountPayment.confirming.payment")
              : t("payments.routes.marketplace.accountPaymentMethods.save")}
        </Button>
      </Stack>
    </Surface>
  );
}
