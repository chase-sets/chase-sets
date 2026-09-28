import type { JsonObject } from "../primitives/json";
import type { EventStoreContext } from "./storage";
import type { MarketplaceListingPriceTarget } from "./public-event-payloads/marketplace";

export type ListingAuthorityOwner =
  | "auth"
  | "marketplace"
  | "identity"
  | "channels"
  | "pricing"
  | "inventory"
  | "catalog"
  | "commercial-terms";

export type ListingAuthorityPurpose =
  | "authenticated-session"
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

/** Auth's non-secret, non-reused persisted revisions, never a token/hash or timestamp guess. */
export type ListingAuthoritySessionAuthentication = Readonly<{
  kind: "session";
  sessionId: string;
  revision: string;
  tokenRevision: string;
}>;

/** Authenticated server-internal Auth-to-Identity result, not a browser DTO or a capability.
 * validBefore cannot exceed either token or session expiry. Identity adds/revalidates
 * membership and delegation, and may only narrow this boundary in the final principal.
 */
export type ListingAuthoritySessionEvidence = Readonly<{
  tenantId: string;
  userId: string;
  accountId: string;
  authentication: ListingAuthoritySessionAuthentication;
  validBefore: string;
}>;

/** Verified server input, never decoded from command bodies, audit IDs, or owner headers.
 * IDs/revisions are non-secret selectors. Identity revalidates them and reserves
 * the effective membership/credential/scope ceiling, not the account's full role.
 */
export type ListingAuthorityPrincipal = Readonly<{
  tenantId: string;
  accountId: string;
  userId: string;
  validBefore: string;
}> &
  (
    | Readonly<{
        kind: "user";
        membershipId: string;
        authentication:
          | ListingAuthoritySessionAuthentication
          | Readonly<{ kind: "api-key"; keyId: string; revision: string }>
          | Readonly<{ kind: "delegation"; delegationId: string; revision: string; scopeCeiling: readonly string[] }>;
        delegation: Readonly<{ delegationId: string; revision: string; scopeCeiling: readonly string[] }> | null;
      }>
    | Readonly<{
        kind: "standing-system";
        admittingOwner: ListingAuthorityOwner;
        authorityId: string;
        authorityRevision: string;
        scopeCeiling: readonly string[];
      }>
  );

/** Constructed by the committing owner, never accepted from a browser body. */
export type ListingAuthorityOperation = Readonly<{
  schemaVersion: 1;
  operationId: string;
  tenantId: string;
  accountId: string;
  /** Required whenever Identity or Auth participates. Session authentication always requires Auth. */
  principal: ListingAuthorityPrincipal | null;
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

/** Identity consumes a host-authenticated admitting owner's real participant.
 * Its owner must equal principal.admittingOwner and its participant must be in
 * the exact final operation. The owner verifies authorityId/revision, scopes and
 * validity and protects all invalidating writers until that operation's terminal.
 * prepare/inspect must return the identical operation, not an intermediate grant.
 * No lookup by system user ID or caller-supplied owner is an implementation.
 */
export type ListingAuthorityStandingAuthorityPort = ListingAuthorityParticipantPort;

/** Auth protects session/<sessionId> with resourceScope: 'owner', binding the full
 * final operation/principal and both session/<sessionId> and session-token/<sessionId>
 * exact source revisions. Auth validates lifecycle/credential, not Identity permissions.
 * Every session/token invalidator closes that shared resource before competing for
 * final terminals. Unknown outcomes retain closure and the stable mutation identity.
 * Token SQL needs owner-local durable CAS/idempotency and reconciliation before
 * reopening; the participant mutation callback alone cannot make SQL idempotent.
 */
export type ListingAuthoritySessionAuthorityPort = Omit<ListingAuthorityParticipantPort, "participant"> &
  Readonly<{ participant: Readonly<{ owner: "auth"; purpose: "authenticated-session" }> }>;

export function requireListingAuthorityPrincipal(context: EventStoreContext): ListingAuthorityPrincipal {
  const principal = context.listingAuthorityPrincipal;
  const nonempty = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
  const scopes = (value: unknown): boolean => Array.isArray(value) && value.every(nonempty);
  if (
    !principal ||
    principal.tenantId !== context.tenantId ||
    principal.accountId !== context.audit.forAccountId ||
    principal.userId !== context.audit.performedByUserId ||
    !Number.isFinite(Date.parse(principal.validBefore)) ||
    (principal.kind === "user"
      ? !nonempty(principal.membershipId) ||
        !principal.authentication ||
        !nonempty(principal.authentication.revision) ||
        (principal.authentication.kind === "session"
          ? !nonempty(principal.authentication.sessionId) || !nonempty(principal.authentication.tokenRevision)
          : principal.authentication.kind === "api-key"
            ? !nonempty(principal.authentication.keyId)
            : principal.authentication.kind !== "delegation" ||
              !nonempty(principal.authentication.delegationId) ||
              !scopes(principal.authentication.scopeCeiling)) ||
        (principal.delegation !== null &&
          (!principal.delegation ||
            !nonempty(principal.delegation.delegationId) ||
            !nonempty(principal.delegation.revision) ||
            !scopes(principal.delegation.scopeCeiling)))
      : principal.kind !== "standing-system" ||
        !["marketplace", "identity", "channels", "pricing", "inventory", "catalog", "commercial-terms"].includes(
          principal.admittingOwner,
        ) ||
        !nonempty(principal.authorityId) ||
        !nonempty(principal.authorityRevision) ||
        !scopes(principal.scopeCeiling))
  )
    throw new Error("Trusted Listing authenticated principal is missing or mismatched.");
  return principal;
}

export const LISTING_AUTHORITY_PARTICIPANT_LIMIT = 8;
export const LISTING_AUTHORITY_RESOURCE_LIMIT = 32;

export function listingAuthorityParticipantKey(participant: ListingAuthorityParticipant): string {
  return `${participant.owner}/${participant.purpose}`;
}

export function assertListingAuthorityParticipants(participants: readonly ListingAuthorityParticipant[]): void {
  const owners: Record<ListingAuthorityPurpose, ListingAuthorityOwner> = {
    "authenticated-session": "auth",
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

/** Required at admission AND when validating retained final operations. */
export function assertListingAuthorityAuthenticationParticipants(
  participants: readonly ListingAuthorityParticipant[],
  principal: ListingAuthorityPrincipal | null,
): void {
  assertListingAuthorityParticipants(participants);
  const session = principal?.kind === "user" && principal.authentication.kind === "session";
  if (participants.some((participant) => participant.owner === "auth") !== session)
    throw new Error("Listing authenticated-session participation must match the selected authentication.");
}

/** Call before fingerprinting a NEW final operation, never to upgrade retained history. */
export function completeListingAuthorityParticipants(
  participants: readonly ListingAuthorityParticipant[],
  principal: ListingAuthorityPrincipal | null,
): readonly ListingAuthorityParticipant[] {
  const completed = [...participants];
  if (
    principal?.kind === "user" &&
    principal.authentication.kind === "session" &&
    !completed.some((participant) => participant.owner === "auth")
  )
    completed.push({ owner: "auth", purpose: "authenticated-session" });
  assertListingAuthorityAuthenticationParticipants(completed, principal);
  return completed;
}
