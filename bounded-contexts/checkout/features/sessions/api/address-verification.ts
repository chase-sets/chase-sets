import { PostageLabelProviderError, type PostageAddress, type PostageLabelProvider } from "@chase-sets/postage-labels";
import type { AddressVerificationSnapshot } from "@chase-sets/primitives/address-snapshot";
import type { CheckoutShippingAddress } from "../domain/domain";
import { CheckoutDomainError } from "../../../support/runtime-support/common";

export type AddressVerificationDecision = "accept-suggested" | "keep-original" | null;

export type AddressVerificationChoiceRequired = Readonly<{
  status: "choice-required";
  suggestedAddress: CheckoutShippingAddress;
  verification: AddressVerificationSnapshot;
  messages: readonly string[];
}>;

export type VerifiedCheckoutShippingAddress = Readonly<{
  status: "accepted";
  shippingAddress: CheckoutShippingAddress;
}>;

export type CheckoutAddressVerificationOutcome = VerifiedCheckoutShippingAddress | AddressVerificationChoiceRequired;

export async function verifyCheckoutShippingAddress(
  provider: PostageLabelProvider | null | undefined,
  address: CheckoutShippingAddress,
  decision: AddressVerificationDecision = null,
): Promise<CheckoutAddressVerificationOutcome> {
  const verifyAddress = provider?.verifyAddress;
  if (!verifyAddress) {
    return {
      status: "accepted",
      shippingAddress: withVerification(address, {
        status: "unverified",
        source: "postage-provider-unavailable",
        checkedAt: new Date().toISOString(),
        buyerDecision: "provider-unavailable",
        messages: ["Address verification was unavailable; accepted without provider confirmation."],
      }),
    };
  }

  let result: Awaited<ReturnType<NonNullable<PostageLabelProvider["verifyAddress"]>>>;
  try {
    result = await verifyAddress({ address: toPostageAddress(address) });
  } catch (error) {
    if (error instanceof PostageLabelProviderError || error instanceof Error) {
      return {
        status: "accepted",
        shippingAddress: withVerification(address, {
          status: "unverified",
          source: provider.providerName,
          checkedAt: new Date().toISOString(),
          buyerDecision: "provider-unavailable",
          messages: ["Address verification was unavailable; accepted without provider confirmation."],
        }),
      };
    }
    throw error;
  }

  if (result.status === "undeliverable") {
    throw new CheckoutDomainError(
      "We could not verify this as a deliverable address. Use a deliverable shipping address before continuing.",
      "shipping_address_undeliverable",
    );
  }

  const suggestedAddress = result.suggestedAddress ? fromPostageAddress(address, result.suggestedAddress) : null;
  const source = `${result.providerName}:${result.providerMode}`;
  if (
    result.status === "corrected" &&
    suggestedAddress &&
    decision !== "accept-suggested" &&
    decision !== "keep-original"
  ) {
    return {
      status: "choice-required",
      suggestedAddress: withVerification(suggestedAddress, {
        status: "corrected",
        source,
        checkedAt: result.checkedAt,
        suggestedAddress: snapshotFromCheckoutAddress(suggestedAddress),
        messages: result.messages,
      }),
      verification: {
        status: "corrected",
        source,
        checkedAt: result.checkedAt,
        suggestedAddress: snapshotFromCheckoutAddress(suggestedAddress),
        messages: result.messages,
      },
      messages: result.messages,
    };
  }

  if (decision === "accept-suggested" && suggestedAddress) {
    return {
      status: "accepted",
      shippingAddress: withVerification(suggestedAddress, {
        status: result.status === "unverified" ? "unverified" : "corrected",
        source,
        checkedAt: result.checkedAt,
        buyerDecision: "accepted-suggested",
        suggestedAddress: snapshotFromCheckoutAddress(suggestedAddress),
        messages: result.messages,
      }),
    };
  }

  if (decision === "keep-original" && suggestedAddress) {
    return {
      status: "accepted",
      shippingAddress: withVerification(address, {
        status: "unverified",
        source,
        checkedAt: result.checkedAt,
        buyerDecision: "kept-original",
        suggestedAddress: snapshotFromCheckoutAddress(suggestedAddress),
        messages: result.messages,
      }),
    };
  }

  return {
    status: "accepted",
    shippingAddress: withVerification(address, {
      status: result.status,
      source,
      checkedAt: result.checkedAt,
      ...(suggestedAddress ? { suggestedAddress: snapshotFromCheckoutAddress(suggestedAddress) } : {}),
      messages: result.messages,
    }),
  };
}

function toPostageAddress(address: CheckoutShippingAddress): PostageAddress {
  return {
    name: address.name,
    company: address.company ?? null,
    street1: address.line1,
    street2: address.line2 ?? null,
    city: address.city,
    state: address.state,
    postalCode: address.postalCode,
    country: address.country,
    phone: address.phone ?? null,
    email: address.email ?? null,
  };
}

function fromPostageAddress(original: CheckoutShippingAddress, address: PostageAddress): CheckoutShippingAddress {
  return {
    shippingAddressId: original.shippingAddressId ?? null,
    name: address.name,
    company: address.company ?? null,
    line1: address.street1,
    line2: address.street2 ?? null,
    city: address.city,
    state: address.state,
    postalCode: address.postalCode,
    country: address.country,
    phone: address.phone ?? null,
    email: address.email ?? null,
  };
}

function snapshotFromCheckoutAddress(
  address: CheckoutShippingAddress,
): NonNullable<AddressVerificationSnapshot["suggestedAddress"]> {
  return {
    name: address.name,
    company: address.company ?? null,
    line1: address.line1,
    line2: address.line2 ?? null,
    city: address.city,
    state: address.state,
    postalCode: address.postalCode,
    country: address.country,
    phone: address.phone ?? null,
    email: address.email ?? null,
  };
}

function withVerification(
  address: CheckoutShippingAddress,
  verification: AddressVerificationSnapshot,
): CheckoutShippingAddress {
  return {
    ...address,
    verification,
  };
}
