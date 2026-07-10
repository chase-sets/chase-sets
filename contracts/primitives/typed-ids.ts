import { ulid } from "ulid";

export type Ulid = string;

export type TypedUlid<Prefix extends string> = `${Prefix}_${Ulid}`;

export type InternalId<Prefix extends string> = `${Prefix}_${string}`;

export function createId<Prefix extends string>(prefix: Prefix): TypedUlid<Prefix> {
  return `${prefix}_${ulid()}` as TypedUlid<Prefix>;
}

export function createInternalId<Prefix extends string>(prefix: Prefix): InternalId<Prefix> {
  const crypto = globalThis.crypto;
  const value =
    typeof crypto?.randomUUID === "function"
      ? crypto.randomUUID()
      : createUuidFromRandomValues(crypto?.getRandomValues.bind(crypto));

  return `${prefix}_${value}` as InternalId<Prefix>;
}

function createUuidFromRandomValues(getRandomValues: Crypto["getRandomValues"] | undefined): string {
  if (!getRandomValues) {
    throw new Error("Crypto-backed internal ID generation is unavailable.");
  }

  const bytes = getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  return [...bytes]
    .map((byte, index) => {
      const value = byte.toString(16).padStart(2, "0");
      return [4, 6, 8, 10].includes(index) ? `-${value}` : value;
    })
    .join("");
}

export function parseTypedId<Prefix extends string>(value: string, prefix: Prefix): TypedUlid<Prefix> {
  if (!value.startsWith(`${prefix}_`)) {
    throw new Error(`Expected '${prefix}_' id prefix.`);
  }

  return value as TypedUlid<Prefix>;
}

export type EventId = TypedUlid<"evt">;

export type TenantId = TypedUlid<"tnt">;

export type TraceId = string;

export type SpanId = string;

export type AccountId = TypedUlid<"acc">;

export type UserId = TypedUlid<"usr">;

export type CatalogItemId = TypedUlid<"cat">;

export type InventoryItemId = TypedUlid<"inv">;

export type ListingId = TypedUlid<"lst">;

export type OfferId = TypedUlid<"off">;

export type OrderId = TypedUlid<"ord">;

export type ShipmentId = TypedUlid<"shp">;

export type ReviewId = TypedUlid<"rev">;

export type SupportRequestId = TypedUlid<"sup">;

export type PaymentId = TypedUlid<"pay">;

export type LedgerEntryId = TypedUlid<"led">;

export type PayoutId = TypedUlid<"pyo">;

export type MembershipId = TypedUlid<"mbr">;

export type RoleId = TypedUlid<"rol">;

export type InvitationId = TypedUlid<"ivt">;

export type ConsentId = TypedUlid<"cns">;

export type ContactMethodId = TypedUlid<"ctm">;

export type VerificationId = TypedUlid<"vrf">;

export type CredentialId = TypedUlid<"crd">;

export type AuthenticationMethodId = TypedUlid<"atm">;

export type SessionId = TypedUlid<"ses">;

export type CheckoutSessionId = TypedUlid<"chk">;

export type ApiKeyId = TypedUlid<"key">;

export type ShippingAddressId = TypedUlid<"adr">;
