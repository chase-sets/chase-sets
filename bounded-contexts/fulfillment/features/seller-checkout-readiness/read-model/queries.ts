import { parseIsoUtcTimestamp, type IsoUtcTimestamp } from "@chase-sets/primitives/iso-utc-timestamp";
import type { AccountId } from "@chase-sets/primitives/typed-ids";
import {
  sellerCheckoutLabelPreferences,
  type SellerCheckoutBlockingFact,
  type SellerCheckoutDimensionReadiness,
  type SellerCheckoutLabelPreference,
  type SellerCheckoutReadinessKey,
  type SellerCheckoutReadinessOwner,
  type SellerCheckoutReadinessResult,
} from "../domain/contract";

/** One label preference's availability, evaluated at a revision of its owner's facts. */
export type SellerCheckoutPreferenceFact = Readonly<{
  labelPreference: SellerCheckoutLabelPreference;
  availability: "available" | "unavailable";
  revision: number;
}>;

/**
 * The facts Fulfillment records for one owner at one Ship-From Location.
 * `revision` increases with every change to them and each preference fact keeps
 * the revision it was last evaluated at, so a fact behind its record is stale.
 * A guest-to-account merge sets `mergedIntoAccountId` on the anonymous owner's
 * record.
 */
export type SellerCheckoutReadinessFacts = Readonly<{
  owner: SellerCheckoutReadinessOwner;
  shipFromLocationId: string;
  revision: number;
  recordedAt: string;
  mergedIntoAccountId: AccountId | null;
  labelPreferences: readonly SellerCheckoutPreferenceFact[];
  providerRoutes: readonly SellerCheckoutPreferenceFact[];
}>;

/** One bounded read of the facts recorded for a key's owner and Ship-From Location. */
export type SellerCheckoutReadinessFactSource = (
  key: SellerCheckoutReadinessKey,
) => Promise<SellerCheckoutReadinessFacts | null>;

type SourceStamp = Pick<SellerCheckoutReadinessResult, "sourceRevision" | "sourceTimestamp">;

const labelPreferences: ReadonlySet<unknown> = new Set(sellerCheckoutLabelPreferences);
const noSourceStamp: SourceStamp = { sourceRevision: null, sourceTimestamp: null };

function hasIdPrefix<Prefix extends string>(value: unknown, prefix: Prefix): value is `${Prefix}${string}` {
  return typeof value === "string" && value.length > prefix.length && value.startsWith(prefix);
}

function ownerOf(value: unknown): SellerCheckoutReadinessOwner | null {
  const { kind, accountId, anonymousSellListId } = (value ?? {}) as Readonly<Record<string, unknown>>;
  if (kind === "account" && hasIdPrefix(accountId, "acc_")) {
    return { kind, accountId };
  }
  if (kind === "anonymous" && hasIdPrefix(anonymousSellListId, "anon_")) {
    return { kind, anonymousSellListId };
  }
  return null;
}

/** Rebuilds the key from its typed fields alone, or returns null when it cannot name an owner fact. */
function ownedKeyOf(key: SellerCheckoutReadinessKey): SellerCheckoutReadinessKey | null {
  const owner = ownerOf(key.owner);
  const { shipFromLocationId, labelPreference } = key;
  if (
    !owner ||
    typeof shipFromLocationId !== "string" ||
    shipFromLocationId.trim() === "" ||
    !labelPreferences.has(labelPreference)
  ) {
    return null;
  }
  return { owner, shipFromLocationId, labelPreference };
}

function sameOwner(left: SellerCheckoutReadinessOwner, right: SellerCheckoutReadinessOwner) {
  return left.kind === "account"
    ? right.kind === "account" && right.accountId === left.accountId
    : right.kind === "anonymous" && right.anonymousSellListId === left.anonymousSellListId;
}

function isRevision(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isoUtcTimestamp(value: unknown): IsoUtcTimestamp | null {
  if (typeof value !== "string") {
    return null;
  }
  try {
    return parseIsoUtcTimestamp(value);
  } catch {
    return null;
  }
}

function blockingFact(
  facts: readonly SellerCheckoutPreferenceFact[],
  labelPreference: SellerCheckoutLabelPreference,
  revision: number,
): SellerCheckoutBlockingFact | null {
  const [fact, ...others] = facts.filter((candidate) => candidate?.labelPreference === labelPreference);
  if (!fact) {
    return "missing";
  }
  if (others.length > 0) {
    return "conflicting";
  }
  if (!isRevision(fact.revision)) {
    return "unavailable";
  }
  if (fact.revision > revision) {
    return "conflicting";
  }
  if (fact.revision < revision) {
    return "stale";
  }
  return fact.availability === "available" ? null : "unavailable";
}

function dimension<BlockedReason extends string>(
  blockedReason: BlockedReason,
  fact: SellerCheckoutBlockingFact | null,
): SellerCheckoutDimensionReadiness<BlockedReason> {
  return fact === null ? { status: "ready", reason: "ready" } : { status: "blocked", reason: blockedReason, fact };
}

function blocked(fact: SellerCheckoutBlockingFact, stamp: SourceStamp = noSourceStamp): SellerCheckoutReadinessResult {
  return {
    schemaVersion: "fulfillment.seller-checkout-readiness.v1",
    label: dimension("label-not-ready", fact),
    provider: dimension("provider-not-ready", fact),
    ...stamp,
  };
}

/**
 * Fulfillment's pre-checkout label and provider readiness for one owner,
 * Ship-From Location and label preference. It makes one bounded read of the
 * owner's facts and blocks anything it cannot vouch for: missing, stale,
 * conflicting or unavailable facts never default ready, and nothing a browser
 * posts is input. Another owner's revision is never returned.
 */
export async function readSellerCheckoutReadiness(
  source: SellerCheckoutReadinessFactSource,
  key: SellerCheckoutReadinessKey,
): Promise<SellerCheckoutReadinessResult> {
  const ownedKey = ownedKeyOf(key);
  if (!ownedKey) {
    return blocked("missing");
  }

  let facts: SellerCheckoutReadinessFacts | null;
  try {
    facts = await source(ownedKey);
  } catch {
    return blocked("unavailable");
  }
  if (!facts) {
    return blocked("missing");
  }

  const recordOwner = ownerOf(facts.owner);
  if (
    !recordOwner ||
    !sameOwner(recordOwner, ownedKey.owner) ||
    facts.shipFromLocationId !== ownedKey.shipFromLocationId
  ) {
    return blocked("conflicting");
  }

  const sourceTimestamp = isoUtcTimestamp(facts.recordedAt);
  if (
    !isRevision(facts.revision) ||
    !sourceTimestamp ||
    !Array.isArray(facts.labelPreferences) ||
    !Array.isArray(facts.providerRoutes)
  ) {
    return blocked("unavailable");
  }

  const fromRecord: SourceStamp = { sourceRevision: facts.revision, sourceTimestamp };
  if (facts.mergedIntoAccountId !== null) {
    return blocked("stale", fromRecord);
  }

  return {
    schemaVersion: "fulfillment.seller-checkout-readiness.v1",
    label: dimension("label-not-ready", blockingFact(facts.labelPreferences, ownedKey.labelPreference, facts.revision)),
    provider: dimension(
      "provider-not-ready",
      blockingFact(facts.providerRoutes, ownedKey.labelPreference, facts.revision),
    ),
    ...fromRecord,
  };
}
