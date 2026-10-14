import { t } from "@chase-sets/localization";
import type { NormalizedFormErrors } from "@chase-sets/design-system";
import { IdentityApiError } from "../../../client";
import { SHIPPING_ADDRESS_REQUIRED_MESSAGES, type ShippingAddressField } from "../domain/errors";

type ShippingAddressErrors = NormalizedFormErrors<Record<ShippingAddressField, string>>;

export function shippingAddressActionErrors(
  error: IdentityApiError,
  intent: string,
  fallback: string,
): Readonly<{
  classification: "FIELD" | "FORM" | "INDETERMINATE";
  errors: ShippingAddressErrors;
}> {
  const generic = () =>
    ({ classification: "INDETERMINATE", errors: { fieldErrors: {}, formErrors: [fallback] } }) as const;
  const body: unknown = error.body;
  if (!record(body) || !record(body.error)) return generic();
  const rejection = body.error;
  if (
    rejection.details === undefined &&
    rejection.code !== "validation_failed" &&
    rejection.code !== "validation_error"
  ) {
    return { classification: "FORM", errors: { fieldErrors: {}, formErrors: [fallback] } };
  }
  if (intent !== "create" && intent !== "update") return generic();
  if (
    error.status !== 400 ||
    rejection.code !== "validation_failed" ||
    Object.keys(body).some((key) => key !== "error") ||
    Object.keys(rejection).some((key) => !["code", "message", "details"].includes(key)) ||
    typeof rejection.message !== "string" ||
    rejection.message.length > 1024 ||
    !Array.isArray(rejection.details) ||
    rejection.details.length !== 1
  )
    return generic();
  const detail: unknown = rejection.details[0];
  if (
    !record(detail) ||
    Object.keys(detail).some((key) => !["field", "code", "message"].includes(key)) ||
    typeof detail.field !== "string" ||
    !Object.hasOwn(SHIPPING_ADDRESS_REQUIRED_MESSAGES, detail.field) ||
    detail.code !== "required" ||
    typeof detail.message !== "string" ||
    detail.message.length > 1024
  )
    return generic();
  const field = detail.field as ShippingAddressField;
  return {
    classification: "FIELD",
    errors: { fieldErrors: { [field]: [t(SHIPPING_ADDRESS_REQUIRED_MESSAGES[field])] }, formErrors: [] },
  };
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
