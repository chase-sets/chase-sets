export type CheckoutDeliveryServiceabilityIssueCode =
  | "shipping_address_required"
  | "shipping_address_unsupported"
  | "shipping_address_restricted";

export type CheckoutDeliveryServiceabilityIssue = Readonly<{
  code: CheckoutDeliveryServiceabilityIssueCode;
  message: string;
}>;

type CheckoutDeliveryAddress = Readonly<{
  line1: string;
  line2?: string | null;
  state: string;
  country: string;
}>;

const unsupportedDeliveryRegions = new Set(["AA", "AE", "AP", "AS", "FM", "GU", "MH", "MP", "PR", "PW", "VI"]);

export function checkoutDeliveryServiceabilityIssue(
  address: CheckoutDeliveryAddress | null | undefined,
): CheckoutDeliveryServiceabilityIssue | null {
  if (!address) {
    return {
      code: "shipping_address_required",
      message: "Confirm the shipping address before creating orders.",
    };
  }

  if (address.country.trim().toUpperCase() !== "US") {
    return {
      code: "shipping_address_unsupported",
      message: "This delivery region is not supported for checkout yet. Use a supported US delivery address.",
    };
  }

  if (unsupportedDeliveryRegions.has(address.state.trim().toUpperCase())) {
    return {
      code: "shipping_address_unsupported",
      message: "This delivery region is not supported for checkout yet. Use a supported US delivery address.",
    };
  }

  const streetLines = [address.line1, address.line2 ?? ""].join(" ");
  if (/\bP(?:OST)?\.?\s*O(?:FFICE)?\.?\s*BOX\b/i.test(streetLines) || /\bP\.?\s*O\.?\s*BOX\b/i.test(streetLines)) {
    return {
      code: "shipping_address_restricted",
      message:
        "This delivery address is not supported for the selected shipping service. Use a street address before paying.",
    };
  }

  return null;
}
