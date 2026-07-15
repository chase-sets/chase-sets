import { normalizeAddressSnapshot, type AddressSnapshot } from "@chase-sets/primitives/address-snapshot";
import { FulfillmentDomainError, assert, ensureIsoTimestamp, normalizeRequiredText } from "./common";

/**
 * The platform return-facility directory — a Fulfillment-owned, typed and
 * validated configuration of the facilities a buyer-to-platform reverse shipment
 * can be routed to.
 *
 * Reverse logistics is generic Fulfillment behaviour, so the directory lives here
 * rather than in Authenticity; Authenticity may judge a specific item on request
 * but does not own return routing. The directory separates two audiences:
 *
 * - **Restricted** operational data — full postal address, operational contact,
 *   and internal routing metadata — is exposed only to authorized consumers and
 *   never placed on broadly consumed contracts.
 * - **Display-safe** data — the facility name and buyer instructions — is what a
 *   customer sees.
 *
 * When a facility is chosen, the selection is captured as an immutable
 * {@link ReturnDestinationSnapshot} that is stamped onto the ReturnShipment
 * `requested` fact. Later directory edits (a new configuration version, a
 * retirement) never rewrite that snapshot, so history stays auditable.
 */

/** Package constraints a facility can accept, in the reverse-shipment package plan's units. */
export type ReturnFacilityPackageConstraints = Readonly<{
  maxWeightOunces: number;
  maxLengthInches: number;
  maxWidthInches: number;
  maxHeightInches: number;
}>;

/** Operational routing/contact metadata restricted to authorized consumers. Never surfaced to customers or public contracts. */
export type ReturnFacilityRestrictedRouting = Readonly<{
  operationalContact: string;
  internalRoutingCode: string;
}>;

export type ReturnFacilityInput = Readonly<{
  facilityId: string;
  configVersion: string;
  effectiveAt: string;
  retiredAt?: string | null;
  supportedReturnPrograms: readonly string[];
  supportedCarriers: readonly string[];
  supportedRegions: readonly string[];
  packageConstraints: ReturnFacilityPackageConstraints;
  postalAddress: AddressSnapshot;
  restrictedRouting: ReturnFacilityRestrictedRouting;
  displayName: string;
  displayInstructions: string;
}>;

export type ReturnFacility = Readonly<{
  facilityId: string;
  configVersion: string;
  effectiveAt: string;
  retiredAt: string | null;
  supportedReturnPrograms: readonly string[];
  supportedCarriers: readonly string[];
  supportedRegions: readonly string[];
  packageConstraints: ReturnFacilityPackageConstraints;
  postalAddress: AddressSnapshot;
  restrictedRouting: ReturnFacilityRestrictedRouting;
  displayName: string;
  displayInstructions: string;
}>;

function normalizeLowerCaseTokens(values: readonly string[], message: string): readonly string[] {
  const normalized = values.map((value) => normalizeRequiredText(value, message).toLowerCase());
  assert(normalized.length > 0, message);
  return [...new Set(normalized)].sort();
}

function ensurePositiveNumber(value: number, message: string): number {
  assert(typeof value === "number" && Number.isFinite(value) && value > 0, message);
  return value;
}

function normalizePackageConstraints(input: ReturnFacilityPackageConstraints): ReturnFacilityPackageConstraints {
  return {
    maxWeightOunces: ensurePositiveNumber(input.maxWeightOunces, "Facility max weight must be a positive number."),
    maxLengthInches: ensurePositiveNumber(input.maxLengthInches, "Facility max length must be a positive number."),
    maxWidthInches: ensurePositiveNumber(input.maxWidthInches, "Facility max width must be a positive number."),
    maxHeightInches: ensurePositiveNumber(input.maxHeightInches, "Facility max height must be a positive number."),
  };
}

/** Validates and canonicalizes a facility configuration entry. Throws on any malformed field. */
export function normalizeReturnFacility(input: ReturnFacilityInput): ReturnFacility {
  const effectiveAt = ensureIsoTimestamp(input.effectiveAt, "Facility effective date must be a timestamp.");
  const retiredAt = input.retiredAt
    ? ensureIsoTimestamp(input.retiredAt, "Facility retired date must be a timestamp.")
    : null;
  if (retiredAt) {
    assert(Date.parse(retiredAt) > Date.parse(effectiveAt), "Facility retired date must be after its effective date.");
  }
  return {
    facilityId: normalizeRequiredText(input.facilityId, "Facility id is required."),
    configVersion: normalizeRequiredText(input.configVersion, "Facility configuration version is required."),
    effectiveAt,
    retiredAt,
    supportedReturnPrograms: normalizeLowerCaseTokens(
      input.supportedReturnPrograms,
      "Facility must support at least one return program.",
    ),
    supportedCarriers: normalizeLowerCaseTokens(input.supportedCarriers, "Facility must support at least one carrier."),
    supportedRegions: normalizeLowerCaseTokens(input.supportedRegions, "Facility must serve at least one region."),
    packageConstraints: normalizePackageConstraints(input.packageConstraints),
    postalAddress: normalizeAddressSnapshot(input.postalAddress, "Facility postal address"),
    restrictedRouting: {
      operationalContact: normalizeRequiredText(
        input.restrictedRouting.operationalContact,
        "Facility operational contact is required.",
      ),
      internalRoutingCode: normalizeRequiredText(
        input.restrictedRouting.internalRoutingCode,
        "Facility internal routing code is required.",
      ),
    },
    displayName: normalizeRequiredText(input.displayName, "Facility display name is required."),
    displayInstructions: normalizeRequiredText(
      input.displayInstructions,
      "Facility display instructions are required.",
    ),
  };
}

/** An active, validated directory. Facility ids are unique. */
export type ReturnFacilityDirectory = Readonly<{ facilities: readonly ReturnFacility[] }>;

export function createReturnFacilityDirectory(inputs: readonly ReturnFacilityInput[]): ReturnFacilityDirectory {
  const facilities = inputs.map(normalizeReturnFacility);
  const seen = new Set<string>();
  for (const facility of facilities) {
    assert(!seen.has(facility.facilityId), `Duplicate facility id in directory: ${facility.facilityId}`);
    seen.add(facility.facilityId);
  }
  return { facilities };
}

/** The criteria a reverse shipment imposes on facility selection. */
export type ReturnFacilitySelectionCriteria = Readonly<{
  returnProgram: string;
  carrier: string;
  region: string;
  packageWeightOunces: number;
  packageLengthInches: number;
  packageWidthInches: number;
  packageHeightInches: number;
}>;

/**
 * The label-safe, immutable destination captured onto a ReturnShipment fact.
 *
 * Carries the postal address needed to create a label plus display-safe copy and
 * the facility id/version for audit — but never the restricted operational
 * contact or internal routing code, so those secrets stay out of the event log.
 */
export type ReturnDestinationSnapshot = Readonly<{
  destinationType: "platform-facility";
  facilityId: string;
  configVersion: string;
  displayName: string;
  displayInstructions: string;
  postalAddress: AddressSnapshot;
  region: string;
  selectionPolicyVersion: string;
  selectedAt: string;
}>;

export type ReturnFacilitySelectionResult =
  | Readonly<{ outcome: "selected"; facility: ReturnFacility; snapshot: ReturnDestinationSnapshot }>
  | Readonly<{ outcome: "no-eligible-facility"; reason: string }>;

function facilityIsActiveAt(facility: ReturnFacility, asOf: string): boolean {
  const asOfMs = Date.parse(asOf);
  if (Date.parse(facility.effectiveAt) > asOfMs) {
    return false;
  }
  return facility.retiredAt === null || Date.parse(facility.retiredAt) > asOfMs;
}

function facilityAcceptsPackage(facility: ReturnFacility, criteria: ReturnFacilitySelectionCriteria): boolean {
  const { packageConstraints } = facility;
  return (
    criteria.packageWeightOunces <= packageConstraints.maxWeightOunces &&
    criteria.packageLengthInches <= packageConstraints.maxLengthInches &&
    criteria.packageWidthInches <= packageConstraints.maxWidthInches &&
    criteria.packageHeightInches <= packageConstraints.maxHeightInches
  );
}

/**
 * Deterministic, policy-versioned facility selection.
 *
 * Filters the directory to facilities that are active at `asOf`, support the
 * requested program, carrier, and region, and accept the parcel. The winner is
 * the eligible facility with the lowest `facilityId` (a total order), so the same
 * inputs always select the same facility regardless of directory ordering. When
 * nothing qualifies, returns an explicit `no-eligible-facility` result rather
 * than throwing, so the caller can route the exception.
 */
export function selectReturnFacility(
  directory: ReturnFacilityDirectory,
  criteria: ReturnFacilitySelectionCriteria,
  options: Readonly<{ asOf: string; selectionPolicyVersion: string }>,
): ReturnFacilitySelectionResult {
  const asOf = ensureIsoTimestamp(options.asOf, "Facility selection must record an as-of timestamp.");
  const selectionPolicyVersion = normalizeRequiredText(
    options.selectionPolicyVersion,
    "Facility selection policy version is required.",
  );
  const returnProgram = normalizeRequiredText(criteria.returnProgram, "A return program is required.").toLowerCase();
  const carrier = normalizeRequiredText(criteria.carrier, "A carrier is required.").toLowerCase();
  const region = normalizeRequiredText(criteria.region, "A region is required.").toLowerCase();

  const eligible = directory.facilities
    .filter((facility) => facilityIsActiveAt(facility, asOf))
    .filter((facility) => facility.supportedReturnPrograms.includes(returnProgram))
    .filter((facility) => facility.supportedCarriers.includes(carrier))
    .filter((facility) => facility.supportedRegions.includes(region))
    .filter((facility) => facilityAcceptsPackage(facility, criteria))
    .sort((left, right) => left.facilityId.localeCompare(right.facilityId));

  const chosen = eligible[0];
  if (!chosen) {
    return {
      outcome: "no-eligible-facility",
      reason: `No active platform return facility accepts program '${returnProgram}', carrier '${carrier}', region '${region}' for the requested parcel.`,
    };
  }

  return {
    outcome: "selected",
    facility: chosen,
    snapshot: {
      destinationType: "platform-facility",
      facilityId: chosen.facilityId,
      configVersion: chosen.configVersion,
      displayName: chosen.displayName,
      displayInstructions: chosen.displayInstructions,
      postalAddress: chosen.postalAddress,
      region,
      selectionPolicyVersion,
      selectedAt: asOf,
    },
  };
}

/** Validates an already-captured destination snapshot (e.g. one decoded from an event) without re-selecting. */
export function normalizeReturnDestinationSnapshot(input: ReturnDestinationSnapshot): ReturnDestinationSnapshot {
  if (input.destinationType !== "platform-facility") {
    throw new FulfillmentDomainError("Return destination snapshot must target a platform facility.");
  }
  return {
    destinationType: "platform-facility",
    facilityId: normalizeRequiredText(input.facilityId, "Destination snapshot facility id is required."),
    configVersion: normalizeRequiredText(
      input.configVersion,
      "Destination snapshot configuration version is required.",
    ),
    displayName: normalizeRequiredText(input.displayName, "Destination snapshot display name is required."),
    displayInstructions: normalizeRequiredText(
      input.displayInstructions,
      "Destination snapshot display instructions are required.",
    ),
    postalAddress: normalizeAddressSnapshot(input.postalAddress, "Destination snapshot postal address"),
    region: normalizeRequiredText(input.region, "Destination snapshot region is required.").toLowerCase(),
    selectionPolicyVersion: normalizeRequiredText(
      input.selectionPolicyVersion,
      "Destination snapshot selection policy version is required.",
    ),
    selectedAt: ensureIsoTimestamp(input.selectedAt, "Destination snapshot must record a selection timestamp."),
  };
}

/** Removes restricted operational fields, leaving only what a customer may see. */
export function customerSafeDestination(
  snapshot: ReturnDestinationSnapshot,
): Readonly<{ displayName: string; displayInstructions: string; region: string; city: string; state: string }> {
  return {
    displayName: snapshot.displayName,
    displayInstructions: snapshot.displayInstructions,
    region: snapshot.region,
    city: snapshot.postalAddress.city,
    state: snapshot.postalAddress.state,
  };
}
