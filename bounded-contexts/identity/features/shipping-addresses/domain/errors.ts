import { t } from "@chase-sets/localization";
import { IdentityDomainError } from "../../../support/runtime-support/common";

export const SHIPPING_ADDRESS_REQUIRED_MESSAGES = {
  name: "identity.features.shippingAddresses.errors.name.required",
  line1: "identity.features.shippingAddresses.errors.line1.required",
  city: "identity.features.shippingAddresses.errors.city.required",
  state: "identity.features.shippingAddresses.errors.state.required",
  postalCode: "identity.features.shippingAddresses.errors.postalCode.required",
  country: "identity.features.shippingAddresses.errors.country.required",
} as const;

export type ShippingAddressField = keyof typeof SHIPPING_ADDRESS_REQUIRED_MESSAGES;

export class ShippingAddressFieldError extends IdentityDomainError {
  readonly code = "required";

  constructor(readonly field: ShippingAddressField) {
    super(t(SHIPPING_ADDRESS_REQUIRED_MESSAGES[field]));
    this.name = "ShippingAddressFieldError";
  }
}

export class ShippingAddressUndeliverableError extends IdentityDomainError {
  constructor() {
    super(t("identity.features.shippingAddresses.errors.undeliverable"));
    this.name = "ShippingAddressUndeliverableError";
  }
}
