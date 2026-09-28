import type { JsonObject } from "../primitives/json";
import type { EventStoreContext } from "./storage";
import type { MarketplaceListingPriceTarget } from "./public-event-payloads/marketplace";

export type ListingAuthorityOwner =
  | "marketplace"
  | "identity"
  | "channels"
  | "pricing"
  | "inventory"
  | "catalog"
  | "commercial-terms";

export type ListingAuthorityPurpose =
  | "manage-listing"
  | "connection"
  | "evaluated-price"
  | "stock-allocation"
  | "product-measures"
  | "native-readiness"
  | "native-fee"
  | "native-commitment";

export type ListingAuthorityParticipant = Readonly<{
  owner: ListingAuthorityOwner;
  purpose: ListingAuthorityPurpose;
}>;

export type ListingAuthoritySubject = Readonly<{
  inventoryItemId: string;
  catalogItemId: string;
  productId: string;
  selectedOptions: readonly Readonly<{ dimensionId: string; optionId: string }>[];
  quantity: number;
  pair: Readonly<{ amount: string; currencyCode: string }> | null;
  allocationRevision: number | null;
  commitmentSourceId: string | null;
}>;

/** Constructed by the committing owner, never accepted from a browser body. */
export type ListingAuthorityOperation = Readonly<{
  schemaVersion: 1;
  operationId: string;
  tenantId: string;
  accountId: string;
  actor:
    | Readonly<{ kind: "user"; userId: string }>
    | Readonly<{ kind: "standing-system"; userId: string; authorityId: string; authorityRevision: string }>;
  committingOwner: "marketplace" | "ordering";
  kind:
    | "create-listing"
    | "accept-price"
    | "activate-channel"
    | "native-visibility"
    | "capacity"
    | "resume"
    | "native-commitment";
  requestId: string;
  commandFingerprint: string;
  command: JsonObject;
  listingId: string;
  subject: ListingAuthoritySubject;
  target: MarketplaceListingPriceTarget;
  expectedListingRevision: number;
  expectedTargetRevision: number | null;
  expectedVisibilityRevision: number | null;
  expectedPublicationRevision: number | null;
  generation: number;
  participants: readonly ListingAuthorityParticipant[];
  /** Consumer-clock deadline. Expiry selects ABORTED; it never releases a promise by itself. */
  prepareBefore: string;
}>;

export type ListingAuthorityReservation = Readonly<{
  reservationId: string;
  participant: ListingAuthorityParticipant;
  operation: ListingAuthorityOperation;
  resources: readonly string[];
  sourceRevisions: readonly Readonly<{ resourceId: string; revision: string }>[];
  value: JsonObject;
  /** Source promises until terminal resolution, even after this decision boundary. */
  validBefore: string;
  status: "reserved" | "consumed" | "released";
}>;

export type ListingAuthorityTerminal = Readonly<{
  operation: ListingAuthorityOperation;
  terminalEventId: string;
  status: "committed" | "aborted";
  result: JsonObject | null;
  reason: string | null;
}>;

export type ListingAuthorityOperationStatus =
  | Readonly<{ status: "pending"; operation: ListingAuthorityOperation }>
  | ListingAuthorityTerminal
  | Readonly<{ status: "unknown" }>;

/** Bind this port to one authenticated source owner in the host, not a supplied owner header. */
export type ListingAuthorityConsumerPort = Readonly<{
  inspect(operation: ListingAuthorityOperation): Promise<ListingAuthorityOperationStatus>;
  invalidate(operation: ListingAuthorityOperation, reason: string): Promise<ListingAuthorityTerminal>;
}>;

export type ListingAuthorityParticipantPort = Readonly<{
  participant: ListingAuthorityParticipant;
  prepare(operation: ListingAuthorityOperation, context: EventStoreContext): Promise<ListingAuthorityReservation>;
  inspect(operation: ListingAuthorityOperation): Promise<ListingAuthorityReservation | null>;
  /** Re-reads the consumer's authoritative terminal; the caller cannot manufacture a receipt. */
  settle(operation: ListingAuthorityOperation): Promise<ListingAuthorityReservation>;
}>;

export const LISTING_AUTHORITY_PARTICIPANT_LIMIT = 8;
export const LISTING_AUTHORITY_RESOURCE_LIMIT = 32;

export function listingAuthorityParticipantKey(participant: ListingAuthorityParticipant): string {
  return `${participant.owner}/${participant.purpose}`;
}

export function assertListingAuthorityParticipants(participants: readonly ListingAuthorityParticipant[]): void {
  const owners: Record<ListingAuthorityPurpose, ListingAuthorityOwner> = {
    "manage-listing": "identity",
    connection: "channels",
    "evaluated-price": "pricing",
    "stock-allocation": "inventory",
    "product-measures": "catalog",
    "native-readiness": "marketplace",
    "native-fee": "commercial-terms",
    "native-commitment": "marketplace",
  };
  if (
    participants.length === 0 ||
    participants.length > LISTING_AUTHORITY_PARTICIPANT_LIMIT ||
    new Set(participants.map(listingAuthorityParticipantKey)).size !== participants.length ||
    participants.some(
      (participant) =>
        !owners[participant.purpose] ||
        owners[participant.purpose] !== participant.owner ||
        Object.keys(participant).some((key) => key !== "owner" && key !== "purpose"),
    )
  ) {
    throw new Error("Invalid Listing authority participant set.");
  }
}
