import { t } from "@chase-sets/localization";
import type { PageStepperItem } from "@chase-sets/design-system";

/** Each step is `complete` once its data is collected and the section is
 * collapsed, `current` for the first step still presented as a form, and
 * `upcoming` for later forms. The review step is `blocked` when unavailable
 * lines gate confirmation. Offer-intent has no payment step. */
function stepStatus(ready: boolean, showForm: boolean, reached: boolean): PageStepperItem["status"] {
  if (ready && !showForm) {
    return "complete";
  }
  if (reached) {
    return "current";
  }
  return "upcoming";
}

export type CheckoutStepperInput = Readonly<{
  contactReady: boolean;
  showContactForm: boolean;
  deliveryReady: boolean;
  showDeliveryForm: boolean;
  shippingMethodReady: boolean;
  showShippingMethodForm: boolean;
  paymentMethodReady: boolean;
  showPaymentForm: boolean;
  isOfferIntent: boolean;
  hasPayment: boolean;
  hasUnavailableCheckoutLines: boolean;
}>;

export function buildCheckoutStepperItems(input: CheckoutStepperInput): PageStepperItem[] {
  const contactStep = stepStatus(input.contactReady, input.showContactForm, true);
  const contactComplete = contactStep === "complete";
  const deliveryStep = stepStatus(input.deliveryReady, input.showDeliveryForm, contactComplete);
  const deliveryComplete = deliveryStep === "complete";
  const shippingStep = stepStatus(input.shippingMethodReady, input.showShippingMethodForm, deliveryComplete);
  const shippingComplete = shippingStep === "complete";
  const paymentStep = input.isOfferIntent
    ? "complete"
    : stepStatus(input.paymentMethodReady, input.showPaymentForm, shippingComplete);
  const paymentComplete = paymentStep === "complete";
  const allCollected = contactComplete && deliveryComplete && shippingComplete && paymentComplete;
  const reviewStep: PageStepperItem["status"] = input.hasPayment
    ? "complete"
    : input.hasUnavailableCheckoutLines
      ? "blocked"
      : allCollected
        ? "current"
        : "upcoming";

  return [
    {
      label: t("checkout.features.sessions.ui.checkoutPage.step.contact"),
      description: t("checkout.features.sessions.ui.checkoutPage.step.contact.description"),
      status: contactStep,
    },
    {
      label: t("checkout.features.sessions.ui.checkoutPage.step.delivery"),
      description: t("checkout.features.sessions.ui.checkoutPage.step.delivery.description"),
      status: deliveryStep,
    },
    {
      label: t("checkout.features.sessions.ui.checkoutPage.step.shipping"),
      description: t("checkout.features.sessions.ui.checkoutPage.step.shipping.description"),
      status: shippingStep,
    },
    ...(!input.isOfferIntent
      ? [
          {
            label: t("checkout.features.sessions.ui.checkoutPage.step.payment"),
            description: t("checkout.features.sessions.ui.checkoutPage.step.payment.description"),
            status: paymentStep,
          },
        ]
      : []),
    {
      label: t("checkout.features.sessions.ui.checkoutPage.step.review"),
      description: t("checkout.features.sessions.ui.checkoutPage.step.review.description"),
      status: reviewStep,
    },
  ];
}
