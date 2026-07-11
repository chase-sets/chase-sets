import { t } from "@chase-sets/localization";
import { isRouteErrorResponse } from "react-router";
import type { Tone } from "@chase-sets/design-system";
import type { PaymentsPaymentDetail } from "../../api/contracts";

const paymentTimestampMonths = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function formatPaymentTimestamp(value: string | null | undefined) {
  if (!value) {
    return "Unknown";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  const hour = date.getUTCHours();
  const hour12 = hour % 12 || 12;
  const minute = String(date.getUTCMinutes()).padStart(2, "0");
  const period = hour >= 12 ? "PM" : "AM";

  return `${paymentTimestampMonths[date.getUTCMonth()]} ${date.getUTCDate()}, ${date.getUTCFullYear()}, ${hour12}:${minute} ${period} UTC`;
}

export function statusTone(status: string): Tone {
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

export function paymentStatusCopy(status: string) {
  switch (status) {
    case "pending-confirmation":
      return {
        label: t("payments.routes.marketplace.accountPayment.ready.for.payment"),
        description: t("payments.routes.marketplace.accountPayment.your.checkout.is.ready.confirm.payment"),
      };
    case "captured":
      return {
        label: t("payments.routes.marketplace.accountPayment.paid"),
        description: t("payments.routes.marketplace.accountPayment.payment.is.complete.and.the.covered"),
      };
    case "failed":
      return {
        label: t("payments.routes.marketplace.accountPayment.payment.needs.attention"),
        description: t("payments.routes.marketplace.accountPayment.the.secure.processor.could.not.complete"),
      };
    case "cancelled":
      return {
        label: t("payments.routes.marketplace.accountPayment.payment.cancelled"),
        description: t("payments.routes.marketplace.accountPayment.this.payment.session.is.closed.start"),
      };
    default:
      return {
        label: t("payments.routes.marketplace.accountPayment.payment.in.progress"),
        description: t("payments.routes.marketplace.accountPayment.the.payment.is.being.updated.by"),
      };
  }
}

export function isClaimablePayment(payment: PaymentsPaymentDetail) {
  return payment.status === "captured";
}

export function paymentPreparingTitle() {
  return t("payments.routes.marketplace.accountPayment.payment.preparing");
}

export function isGuestPaymentAccessExpiredError(error: unknown) {
  return (
    isRouteErrorResponse(error) &&
    (error.status === 401 || error.status === 403) &&
    error.statusText === "Guest checkout link expired"
  );
}

export function isPaymentRecoveryError(error: unknown): error is { status: 404 | 503 } {
  return (
    isRouteErrorResponse(error) &&
    (error.status === 404 || (error.status === 503 && error.statusText === paymentPreparingTitle()))
  );
}

export function providerEventLabel(eventKind: string) {
  switch (eventKind) {
    case "payment-authorized":
      return t("payments.routes.marketplace.accountPayment.provider.authorized.payment");
    case "payment-captured":
      return t("payments.routes.marketplace.accountPayment.provider.captured.payment");
    case "payment-failed":
      return t("payments.routes.marketplace.accountPayment.provider.reported.failure");
    case "payment-cancelled":
      return t("payments.routes.marketplace.accountPayment.provider.closed.payment.session");
    default:
      return eventKind.replaceAll("-", " ");
  }
}
