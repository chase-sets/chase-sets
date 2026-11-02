import { t } from "@chase-sets/localization";
import { CheckoutApiError } from "../../request-support/api-client";

type CheckoutShippingCorrectionIssue = Readonly<{
  code: "shipping_option_unavailable";
  message: string;
}>;

type CheckoutCorrectionIssueCode =
  | "shipping_address_required"
  | "shipping_address_unsupported"
  | "shipping_address_restricted"
  | CheckoutShippingCorrectionIssue["code"];
type CheckoutCorrectionIssue = Readonly<{
  code: CheckoutCorrectionIssueCode;
  message: string;
}>;

function checkoutCorrectionMessage(code: CheckoutCorrectionIssueCode) {
  if (code === "shipping_option_unavailable") {
    return t("checkout.routes.checkoutSession.shipping.option.unavailable");
  }

  if (code === "shipping_address_required") {
    return t("checkout.routes.checkoutSession.delivery.address.required");
  }

  if (code === "shipping_address_unsupported") {
    return t("checkout.routes.checkoutSession.delivery.address.unsupported");
  }

  return t("checkout.routes.checkoutSession.delivery.address.restricted");
}

function checkoutApiCorrectionIssue(error: unknown): CheckoutCorrectionIssue | null {
  if (!(error instanceof CheckoutApiError) || !error.body || typeof error.body !== "object") {
    return null;
  }

  const apiError = (error.body as { error?: { code?: unknown; message?: unknown } }).error;
  const code = apiError?.code;
  if (
    code !== "shipping_address_required" &&
    code !== "shipping_address_unsupported" &&
    code !== "shipping_address_restricted" &&
    code !== "shipping_option_unavailable"
  ) {
    return null;
  }

  return {
    code,
    message: typeof apiError?.message === "string" ? apiError.message : code,
  };
}

export function deliveryCorrectionActionData(error: unknown) {
  const issue = checkoutApiCorrectionIssue(error);

  if (!issue) {
    return null;
  }

  return {
    error: checkoutCorrectionMessage(issue.code),
    editSection: issue.code === "shipping_option_unavailable" ? ("shipping" as const) : ("delivery" as const),
  };
}
