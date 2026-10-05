import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { parseOrderGroupCombinedPlanAccepted, type AdmissionIdentity } from "@chase-sets/order-groups";
import { normalizeAddressSnapshot, type AddressSnapshot } from "@chase-sets/primitives/address-snapshot";
import type { PostagePackage } from "@chase-sets/postage-labels";
import type { StoredEvent } from "@chase-sets/event-core/storage";
import { FulfillmentDomainError } from "./common";
import { sameAdmissionIdentity, type FulfillmentShipmentState, type ShipmentPhysicalGroup } from "./domain";

export function physicalDestinationsEqual(left: AddressSnapshot | null, right: AddressSnapshot | null): boolean {
  if (!left || !right) return false;
  const physical = (address: AddressSnapshot) => {
    const normalized = normalizeAddressSnapshot(address);
    return [
      normalized.name,
      normalized.company,
      normalized.line1,
      normalized.line2,
      normalized.city,
      normalized.state,
      normalized.postalCode,
      normalized.country,
      normalized.phone,
    ];
  };
  return isDeepStrictEqual(physical(left), physical(right));
}

function cents(value: string | null | undefined): number {
  if (typeof value !== "string" || !/^(0|[1-9]\d*)\.\d{2}$/.test(value))
    throw new FulfillmentDomainError("Combined insurance requires each member's committed merchandise value.");
  const amount = Number(value.replace(".", ""));
  if (!Number.isSafeInteger(amount)) throw new FulfillmentDomainError("Combined merchandise value is out of range.");
  return amount;
}

export function combinedPostagePlan(
  anchor: FulfillmentShipmentState,
  member: FulfillmentShipmentState,
  identity: AdmissionIdentity,
  callerPackage?: PostagePackage | null,
  serviceLevel = "GroundAdvantage",
) {
  let accepted;
  try {
    accepted = parseOrderGroupCombinedPlanAccepted(member.combinedPlanAccepted);
  } catch {
    throw new FulfillmentDomainError("Combined dispatch requires a complete accepted plan.");
  }
  if (!sameAdmissionIdentity(accepted, identity) || member.orderId !== identity.proposedMemberOrderId)
    throw new FulfillmentDomainError("Combined plan does not match committed admission.");
  const plan = accepted.combinedPackagePlan;
  const policies = [
    anchor.shippingPlanSnapshot?.postagePolicySnapshot,
    member.shippingPlanSnapshot?.postagePolicySnapshot,
    plan.postagePolicySnapshot,
  ];
  if (policies.some((policy) => !policy))
    throw new FulfillmentDomainError("Both member postage policies must be committed.");
  for (const policy of policies) {
    if (
      [policy!.parcelRequired, policy!.signatureRequired, policy!.insuranceRequired].some(
        (value) => typeof value !== "boolean",
      ) ||
      !["letter-untracked", "tracked-parcel", "signature-confirmed", "carrier-insured"].includes(
        policy!.shippingEvidenceTier,
      )
    )
      throw new FulfillmentDomainError("Malformed committed postage policy.");
  }
  const pkg = plan.packages[0];
  const parcel: PostagePackage = {
    mailpieceClass: pkg.mailpieceClass,
    lengthInches: pkg.lengthInches,
    widthInches: pkg.widthInches,
    heightInches: pkg.heightInches,
    weightOunces: pkg.weightOunces,
  };
  if (
    callerPackage &&
    !isDeepStrictEqual(
      { ...callerPackage, mailpieceClass: callerPackage.mailpieceClass ?? parcel.mailpieceClass },
      parcel,
    )
  )
    throw new FulfillmentDomainError("Caller parcel differs from the accepted combined plan.");
  if (policies.some((policy) => policy!.signatureRequired))
    throw new FulfillmentDomainError("Combined signature postage is outside the evidenced provider envelope.");
  for (const policy of policies) {
    if (policy!.insuranceRequired) cents(policy!.insuredValueAmount);
  }
  const insuranceRequired = policies.some((policy) => policy!.insuranceRequired);
  const memberValues = [anchor, member].map((state) =>
    Math.max(
      cents(state.itemSubtotalAmount),
      state.shippingPlanSnapshot?.postagePolicySnapshot?.insuredValueAmount == null
        ? 0
        : cents(state.shippingPlanSnapshot.postagePolicySnapshot.insuredValueAmount),
    ),
  );
  const sum = memberValues[0] + memberValues[1];
  if (!Number.isSafeInteger(sum)) throw new FulfillmentDomainError("Combined merchandise value is out of range.");
  const insuredCents = Math.max(
    sum,
    plan.postagePolicySnapshot.insuredValueAmount === null ? 0 : cents(plan.postagePolicySnapshot.insuredValueAmount),
  );
  // #6461 captured this exact TEST envelope, not a broader carrier capability.
  if (
    pkg.mailpieceClass !== "parcel" ||
    pkg.serviceLevel !== "standard-parcel" ||
    serviceLevel !== "GroundAdvantage" ||
    pkg.lengthInches !== 7 ||
    pkg.widthInches !== 5 ||
    pkg.heightInches !== 2 ||
    pkg.weightOunces !== 8 ||
    (insuranceRequired && insuredCents !== 60000)
  )
    throw new FulfillmentDomainError("Combined postage is outside the evidenced provider envelope.");
  return { plan, parcel, insuranceAmount: insuranceRequired ? "600.00" : null, deliveryConfirmation: null } as const;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, child]) => [key, canonical(child)]),
    );
  return value;
}

export function shipmentLabelGeneration(events: readonly StoredEvent[]): number {
  return (
    [...events]
      .reverse()
      .find(
        (event) =>
          event.eventType === "fulfillment.shipment.label-voided" &&
          (event.payload.refundStatus === "submitted" || event.payload.refundStatus === "refunded"),
      )?.streamVersion ?? 0
  );
}

export function shipmentGroupPostageKey(
  input: Readonly<{
    tenantId: string;
    group: ShipmentPhysicalGroup;
    subjectId: string;
    operationKind: "purchase-usps-label" | "void-label";
    labelGeneration: number;
  }>,
) {
  const tuple = {
    contractVersion: "shipment-group-postage/v1",
    tenantId: input.tenantId,
    shipmentGroupId: input.group.shipmentGroupId,
    admission: input.group.identity,
    committedShipmentVersion: input.group.committedVersion,
    dispositionVersion: input.group.dispositionVersion,
    subjectId: input.subjectId,
    packageOrdinal: 1,
    operationKind: input.operationKind,
    labelGeneration: input.labelGeneration,
  };
  const digest = createHash("sha256")
    .update(`chase-sets:shipment-group-postage/v1\n${JSON.stringify(canonical(tuple))}`, "utf8")
    .digest("hex");
  return `shipment-group-postage:v1:${digest}`;
}
