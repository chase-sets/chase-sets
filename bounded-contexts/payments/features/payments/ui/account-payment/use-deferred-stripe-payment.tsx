import { useEffect, useRef, useState } from "react";
import { loadStripe, type Stripe, type StripeElements, type StripePaymentElement } from "@stripe/stripe-js";
import { t } from "@chase-sets/localization";
import { Banner, EmbeddedProviderSurface, MountPoint, Skeleton } from "@chase-sets/design-system";
import type { PaymentElementDefaultValues } from "./account-payment-contracts";

export function useDeferredStripePayment(
  config: Readonly<{
    publishableKey: string;
    amount: number;
    currency: string;
    quote: string;
    defaultValues?: PaymentElementDefaultValues | null;
  }> | null,
) {
  const mount = useRef<HTMLDivElement | null>(null);
  const provider = useRef<{ stripe: Stripe; elements: StripeElements; save: boolean; quote: string } | null>(null);
  const [readyQuote, setReadyQuote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const key = config?.publishableKey;
  const amount = config?.amount;
  const currency = config?.currency;
  const quote = config?.quote;
  const ready = Boolean(quote && readyQuote === quote);
  const defaults = JSON.stringify(config?.defaultValues ?? null);
  const providerError = t("payments.routes.marketplace.accountPayment.the.secure.processor.could.not.complete");

  useEffect(() => {
    const target = mount.current;
    if (!key || !amount || !currency || !target || !quote) return;
    let active = true;
    let element: StripePaymentElement | undefined;
    const fail = () => {
      if (!active) return;
      active = false;
      window.clearTimeout(deadline);
      provider.current = null;
      element?.destroy();
      element = undefined;
      setReadyQuote(null);
      setError(providerError);
    };
    const deadline = window.setTimeout(fail, 15_000);
    setError(null);
    setReadyQuote(null);
    void loadStripe(key)
      .then((stripe) => {
        if (!active) return;
        if (!stripe) return fail();
        const elements = stripe.elements({ mode: "payment", amount, currency, captureMethod: "automatic" });
        const defaultValues = JSON.parse(defaults) as PaymentElementDefaultValues | null;
        element = elements.create("payment", {
          ...(defaultValues ? { defaultValues } : {}),
          wallets: { applePay: "auto", googlePay: "auto" },
        });
        element.on("ready", () => {
          if (!active) return;
          window.clearTimeout(deadline);
          provider.current = { stripe, elements, save: false, quote };
          setReadyQuote(quote);
        });
        element.on("loaderror", fail);
        element.mount(target);
      })
      .catch(() => {
        if (active) fail();
      });
    return () => {
      active = false;
      window.clearTimeout(deadline);
      provider.current = null;
      element?.destroy();
    };
  }, [key, amount, currency, quote, defaults, providerError]);

  async function createConfirmationToken(save: boolean) {
    const current = provider.current;
    if (!current || current.quote !== quote) return null;
    setError(null);
    try {
      if (current.save !== save) {
        await current.elements.update({ setupFutureUsage: save ? "off_session" : null });
        current.save = save;
      }
      const submitted = await current.elements.submit();
      if (provider.current !== current) return null;
      if (submitted.error) {
        setError(submitted.error.message ?? providerError);
        return null;
      }
      const result = await current.stripe.createConfirmationToken({ elements: current.elements });
      if (provider.current !== current) return null;
      if (result.error) {
        setError(result.error.message ?? providerError);
        return null;
      }
      return result.confirmationToken.id;
    } catch {
      if (provider.current === current) setError(providerError);
      return null;
    }
  }

  const entry = config ? (
    <>
      <EmbeddedProviderSurface minHeight="md" aria-busy={(!ready && !error) || undefined}>
        {!ready && !error ? <Skeleton height="lg" /> : null}
        <MountPoint ref={mount} purpose="provider" />
      </EmbeddedProviderSurface>
      {error ? (
        <Banner
          tone="danger"
          title={t("payments.routes.marketplace.accountPayment.payment.issue")}
          description={error}
        />
      ) : null}
    </>
  ) : null;
  return { entry, ready, createConfirmationToken };
}
