export type Ulid = string;

export type TypedUlid<Prefix extends string> = `${Prefix}_${Ulid}`;

export type EventId = TypedUlid<"evt">;

export type TenantId = TypedUlid<"tnt">;

export type CorrelationId = TypedUlid<"cor">;

export type CausationId = TypedUlid<"cau">;

export type CommandId = TypedUlid<"cmd">;

export type AccountId = TypedUlid<"acc">;

export type UserId = TypedUlid<"usr">;

export type InventoryLotId = TypedUlid<"lot">;

export type ListingId = TypedUlid<"lst">;

export type OfferId = TypedUlid<"off">;

export type OrderId = TypedUlid<"ord">;

export type ShipmentId = TypedUlid<"shp">;

export type ReviewId = TypedUlid<"rev">;

export type PaymentId = TypedUlid<"pay">;

export type LedgerEntryId = TypedUlid<"led">;

export type PayoutId = TypedUlid<"pyo">;

export type MembershipId = TypedUlid<"mbr">;

export type RoleId = TypedUlid<"rol">;

export type InvitationId = TypedUlid<"inv">;

export type ConsentId = TypedUlid<"cns">;

export type ContactMethodId = TypedUlid<"ctm">;

export type VerificationId = TypedUlid<"vrf">;

export type CredentialId = TypedUlid<"crd">;

export type AuthenticationMethodId = TypedUlid<"atm">;

export type SessionId = TypedUlid<"ses">;

export type ApiKeyId = TypedUlid<"key">;
