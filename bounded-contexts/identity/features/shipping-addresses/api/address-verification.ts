import { PostageLabelProviderError, type PostageAddress, type PostageLabelProvider } from "@chase-sets/postage-labels";
import type { AddressVerificationSnapshot } from "@chase-sets/primitives/address-snapshot";
import { IdentityDomainError } from "../../../support/runtime-support/common";
import type { ShippingAddressSnapshot } from "../domain/domain";

export type AddressVerificationDecision = "accept-suggested" | "keep-original" | null;

export type AddressVerificationChoiceRequired = Readonly<{
  status: "choice-required";
  suggestedAddress: ShippingAddressSnapshot;
  verification: AddressVerificationSnapshot;
  messages: readonly string[];
}>;

export type VerifiedShippingAddress = Readonly<{
  status: "accepted";
  address: ShippingAddressSnapshot;
}>;

export type ShippingAddressVerificationOutcome = VerifiedShippingAddress | AddressVerificationChoiceRequired;

export async function verifyShippingAddressSnapshot(
  provider: PostageLabelProvider | null | undefined,
  address: ShippingAddressSnapshot,
  decision: AddressVerificationDecision = null,
): Promise<ShippingAddressVerificationOutcome> {
  const verifyAddress = provider?.verifyAddress;
  if (!verifyAddress) {
    return {
      status: "accepted",
      address: withVerification(address, {
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
        address: withVerification(address, {
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
    throw new IdentityDomainError(
      "We could not verify this as a deliverable address. Use a deliverable shipping address before saving.",
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
        suggestedAddress: snapshotFromAddress(suggestedAddress),
        messages: result.messages,
      }),
      verification: {
        status: "corrected",
        source,
        checkedAt: result.checkedAt,
        suggestedAddress: snapshotFromAddress(suggestedAddress),
        messages: result.messages,
      },
      messages: result.messages,
    };
  }

  if (decision === "accept-suggested" && suggestedAddress) {
    return {
      status: "accepted",
      address: withVerification(suggestedAddress, {
        status: result.status === "unverified" ? "unverified" : "corrected",
        source,
        checkedAt: result.checkedAt,
        buyerDecision: "accepted-suggested",
        suggestedAddress: snapshotFromAddress(suggestedAddress),
        messages: result.messages,
      }),
    };
  }

  if (decision === "keep-original" && suggestedAddress) {
    return {
      status: "accepted",
      address: withVerification(address, {
        status: "unverified",
        source,
        checkedAt: result.checkedAt,
        buyerDecision: "kept-original",
        suggestedAddress: snapshotFromAddress(suggestedAddress),
        messages: result.messages,
      }),
    };
  }

  return {
    status: "accepted",
    address: withVerification(address, {
      status: result.status,
      source,
      checkedAt: result.checkedAt,
      ...(suggestedAddress ? { suggestedAddress: snapshotFromAddress(suggestedAddress) } : {}),
      messages: result.messages,
    }),
  };
}

function toPostageAddress(address: ShippingAddressSnapshot): PostageAddress {
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

function fromPostageAddress(original: ShippingAddressSnapshot, address: PostageAddress): ShippingAddressSnapshot {
  return {
    ...original,
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

function snapshotFromAddress(
  address: ShippingAddressSnapshot,
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
  address: ShippingAddressSnapshot,
  verification: AddressVerificationSnapshot,
): ShippingAddressSnapshot {
  return {
    ...address,
    verification,
  };
}
