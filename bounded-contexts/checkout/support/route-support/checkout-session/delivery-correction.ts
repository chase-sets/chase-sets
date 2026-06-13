import { t } from "@chase-sets/localization";
import {
  checkoutDeliveryServiceabilityIssue,
  type CheckoutDeliveryServiceabilityIssue,
  type CheckoutDeliveryServiceabilityIssueCode,
} from "../../../features/sessions/domain/delivery-serviceability";
import { CheckoutApiError } from "../../request-support/api-client";

type CheckoutDeliveryAddress = Readonly<{
  name: string;
  line1: string;
  line2?: string | null;
  city: string;
  state: string;
  postalCode: string;
  country: string;
}>;

export class CheckoutDeliveryCorrectionError extends Error {
  public constructor(public readonly issue: CheckoutDeliveryServiceabilityIssue) {
    super(issue.message);
  }
}

export function assertCheckoutDeliveryServiceableForAction(address: CheckoutDeliveryAddress) {
  const issue = checkoutDeliveryServiceabilityIssue(address);
  if (issue) {
    throw new CheckoutDeliveryCorrectionError(issue);
  }
}

function deliveryCorrectionMessage(code: CheckoutDeliveryServiceabilityIssueCode) {
  if (code === "shipping_address_required") {
    return t("checkout.routes.checkoutSession.delivery.address.required");
  }

  if (code === "shipping_address_unsupported") {
    return t("checkout.routes.checkoutSession.delivery.address.unsupported");
  }

  return t("checkout.routes.checkoutSession.delivery.address.restricted");
}

function checkoutApiDeliveryServiceabilityIssue(error: unknown): CheckoutDeliveryServiceabilityIssue | null {
  if (!(error instanceof CheckoutApiError) || !error.body || typeof error.body !== "object") {
    return null;
  }

  const apiError = (error.body as { error?: { code?: unknown; message?: unknown } }).error;
  const code = apiError?.code;
  if (
    code !== "shipping_address_required" &&
    code !== "shipping_address_unsupported" &&
    code !== "shipping_address_restricted"
  ) {
    return null;
  }

  return {
    code,
    message: typeof apiError?.message === "string" ? apiError.message : code,
  };
}

export function deliveryCorrectionActionData(error: unknown) {
  const issue =
    error instanceof CheckoutDeliveryCorrectionError ? error.issue : checkoutApiDeliveryServiceabilityIssue(error);

  if (!issue) {
    return null;
  }

  return {
    error: deliveryCorrectionMessage(issue.code),
    editSection: "delivery" as const,
  };
}
