import type { DomainEventCodec } from "../event-core/codec";
import type { EventStoreContext } from "../event-core/storage";
import type { JsonObject } from "../primitives/json";
import { parseStrictTypedUlid, type OrderId } from "../primitives/typed-ids";

export const orderGroupContractVersion = "order-group-admission/v1";
export const abortReasons = [
  "quote-stale",
  "reservation-rejected",
  "capacity-rejected",
  "stage-failed",
  "cancelled",
  "compensating",
] as const;
export const memberRemovalReasons = [
  "buyer-cancelled",
  "seller-cancelled",
  "support-cancel-order",
  "seller-cannot-fulfill",
  "payment-deadline",
  "inventory-unavailable",
  "fraud",
  "compensating",
] as const;
export const admissionRejectionReasons = [
  "packing-started",
  "cancelled",
  "already-grouped",
  "identity-conflict",
] as const;
export const admissionReleaseReasons = ["aborted", "group-dissolved"] as const;
export type AbortReason = (typeof abortReasons)[number];
export type MemberRemovalReason = (typeof memberRemovalReasons)[number];
export type AdmissionRejectionReason = (typeof admissionRejectionReasons)[number];
export type AdmissionReleaseReason = (typeof admissionReleaseReasons)[number];

type Parser<T> = (value: unknown) => T;
type Fields = Readonly<Record<string, Parser<unknown>>>;
type Shape<F extends Fields> = { readonly [K in keyof F]: ReturnType<F[K]> };

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Order Group contract requires an object.");
  }
  return value as Record<string, unknown>;
}

function closedObject<const F extends Fields>(fields: F, validate?: (value: NoInfer<Shape<F>>) => void) {
  const requiredFields = Object.freeze(Object.keys(fields));
  return {
    requiredFields,
    parse(value: unknown): Shape<F> {
      const input = record(value);
      if (
        Object.keys(input).length !== requiredFields.length ||
        requiredFields.some((key) => !Object.hasOwn(input, key))
      ) {
        throw new Error(`Order Group contract requires exactly: ${requiredFields.join(", ")}.`);
      }
      const parsed = Object.fromEntries(
        requiredFields.map((key) => {
          try {
            return [key, fields[key](input[key])];
          } catch (error) {
            throw new Error(`Invalid ${key}: ${error instanceof Error ? error.message : String(error)}`);
          }
        }),
      ) as Shape<F>;
      validate?.(parsed);
      return parsed;
    },
  };
}

function text(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    throw new Error("Expected a nonempty, unpadded string.");
  }
  return value;
}

function integer(minimum: number): Parser<number> {
  return (value) => {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) {
      throw new Error(`Expected an integer from ${minimum} through ${Number.MAX_SAFE_INTEGER}.`);
    }
    return value;
  };
}

function oneOf<const T extends readonly string[]>(values: T): Parser<T[number]> {
  return (value) => {
    if (typeof value !== "string" || !values.some((candidate) => candidate === value)) {
      throw new Error(`Expected one of: ${values.join(", ")}.`);
    }
    return value;
  };
}

function instant(value: unknown): string {
  const input = text(value);
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-](\d{2}):(\d{2}))$/.exec(input);
  if (!parts || !Number.isFinite(Date.parse(input))) throw new Error("Expected a timezone-bearing ISO instant.");
  const [, year, month, day, hour, minute, second, , offsetHour, offsetMinute] = parts;
  const calendar = new Date(0);
  calendar.setUTCFullYear(Number(year), Number(month), 0);
  const daysInMonth = calendar.getUTCDate();
  if (
    Number(month) < 1 ||
    Number(month) > 12 ||
    Number(day) < 1 ||
    Number(day) > daysInMonth ||
    Number(hour) > 23 ||
    Number(minute) > 59 ||
    Number(second) > 59 ||
    Number(offsetHour ?? 0) > 23 ||
    Number(offsetMinute ?? 0) > 59
  ) {
    throw new Error("Expected a valid calendar instant.");
  }
  return input;
}

const orderId = (value: unknown) => parseStrictTypedUlid(text(value), "ord");
const shipmentId = (value: unknown) => parseStrictTypedUlid(text(value), "shp");
const groupId = (value: unknown) => parseStrictTypedUlid(text(value), "ogr");
const version = integer(1);
export const parseAbortReason = oneOf(abortReasons);
export const parseMemberRemovalReason = oneOf(memberRemovalReasons);
export const parseAdmissionRejectionReason = oneOf(admissionRejectionReasons);
export const parseAdmissionReleaseReason = oneOf(admissionReleaseReasons);
const identityFields = {
  requestId: text,
  sourceGeneration: integer(0),
  draftKey: text,
  anchorShipmentId: shipmentId,
  anchorOrderId: orderId,
  proposedMemberOrderId: orderId,
  groupId,
  quoteFingerprint: text,
};

function distinctOrders(value: { anchorOrderId: OrderId; proposedMemberOrderId: OrderId }): void {
  if (value.anchorOrderId === value.proposedMemberOrderId) throw new Error("Admission requires two distinct Orders.");
}

const identitySchema = closedObject(identityFields, distinctOrders);
export const parseAdmissionIdentity = identitySchema.parse;
export type AdmissionIdentity = ReturnType<typeof parseAdmissionIdentity>;
export const parseCommitInput = closedObject({ ...identityFields, anchorOrderVersion: version }, distinctOrders).parse;
export const parseAbortInput = closedObject({ ...identityFields, reason: parseAbortReason }, distinctOrders).parse;

/** Select the complete replay tuple from a decoded fact, without importing caller clocks. */
export function admissionIdentityFromFact(fact: AdmissionIdentity): AdmissionIdentity {
  return parseAdmissionIdentity({
    requestId: fact.requestId,
    sourceGeneration: fact.sourceGeneration,
    draftKey: fact.draftKey,
    anchorShipmentId: fact.anchorShipmentId,
    anchorOrderId: fact.anchorOrderId,
    proposedMemberOrderId: fact.proposedMemberOrderId,
    groupId: fact.groupId,
    quoteFingerprint: fact.quoteFingerprint,
  });
}

function memberOrderIds(value: unknown): readonly [OrderId, OrderId] {
  if (!Array.isArray(value) || value.length !== 2) throw new Error("Expected exactly two original members.");
  const pair: readonly [OrderId, OrderId] = [orderId(value[0]), orderId(value[1])];
  if (pair[0] === pair[1]) throw new Error("Expected distinct members.");
  return pair;
}

const contractFields = { contractVersion: oneOf([orderGroupContractVersion]) };
const admissionFields = { ...contractFields, ...identityFields };
const removalFields = {
  ...contractFields,
  requestId: text,
  groupId,
  anchorOrderId: orderId,
  anchorShipmentId: shipmentId,
  memberOrderIds,
  removedOrderId: orderId,
  reason: parseMemberRemovalReason,
  anchorOrderVersion: version,
};
function originalMembers(value: Shape<typeof removalFields>): void {
  if (value.memberOrderIds[0] !== value.anchorOrderId || !value.memberOrderIds.includes(value.removedOrderId)) {
    throw new Error("Removal must name an original member of the anchor-first pair.");
  }
}

export const orderGroupPayloadValidators = {
  "ordering.order-group.admission-requested": closedObject(
    {
      ...admissionFields,
      requestedAt: instant,
      anchorOrderVersion: version,
    },
    distinctOrders,
  ),
  "ordering.order-group.admission-aborted": closedObject(
    {
      ...admissionFields,
      reason: parseAbortReason,
      abortedAt: instant,
      anchorOrderVersion: version,
    },
    distinctOrders,
  ),
  "ordering.order-group.formed": closedObject(
    {
      ...admissionFields,
      memberOrderIds,
      formedAt: instant,
      anchorOrderVersion: version,
      stagedMemberOrderVersion: version,
    },
    (value) => {
      distinctOrders(value);
      if (value.memberOrderIds[0] !== value.anchorOrderId || value.memberOrderIds[1] !== value.proposedMemberOrderId) {
        throw new Error("Formation members must match the anchor and proposed Order, in that order.");
      }
    },
  ),
  "ordering.order-group.member-removed": closedObject({ ...removalFields, removedAt: instant }, originalMembers),
  "ordering.order-group.dissolved": closedObject({ ...removalFields, dissolvedAt: instant }, originalMembers),
  "fulfillment.shipment-group.admission-reserved": closedObject(
    {
      ...admissionFields,
      reservedAt: instant,
      shipmentVersion: version,
    },
    distinctOrders,
  ),
  "fulfillment.shipment-group.admission-rejected": closedObject(
    {
      ...admissionFields,
      reason: parseAdmissionRejectionReason,
      rejectedAt: instant,
      shipmentVersion: version,
    },
    distinctOrders,
  ),
  "fulfillment.shipment-group.admission-committed": closedObject(
    {
      ...admissionFields,
      anchorOrderVersion: version,
      committedAt: instant,
      shipmentVersion: version,
    },
    distinctOrders,
  ),
  "fulfillment.shipment-group.admission-released": closedObject(
    {
      ...admissionFields,
      reason: parseAdmissionReleaseReason,
      releasedAt: instant,
      shipmentVersion: version,
    },
    distinctOrders,
  ),
};
export type OrderGroupFactType = keyof typeof orderGroupPayloadValidators;
export type OrderGroupEventPayloads = {
  readonly [K in OrderGroupFactType]: ReturnType<(typeof orderGroupPayloadValidators)[K]["parse"]>;
};
export type OrderingOrderGroupAdmissionRequestedPayload =
  OrderGroupEventPayloads["ordering.order-group.admission-requested"];
export type OrderingOrderGroupAdmissionAbortedPayload =
  OrderGroupEventPayloads["ordering.order-group.admission-aborted"];
export type OrderingOrderGroupFormedPayload = OrderGroupEventPayloads["ordering.order-group.formed"];
export type OrderingOrderGroupMemberRemovedPayload = OrderGroupEventPayloads["ordering.order-group.member-removed"];
export type OrderingOrderGroupDissolvedPayload = OrderGroupEventPayloads["ordering.order-group.dissolved"];
export type FulfillmentShipmentGroupAdmissionReservedPayload =
  OrderGroupEventPayloads["fulfillment.shipment-group.admission-reserved"];
export type FulfillmentShipmentGroupAdmissionRejectedPayload =
  OrderGroupEventPayloads["fulfillment.shipment-group.admission-rejected"];
export type FulfillmentShipmentGroupAdmissionCommittedPayload =
  OrderGroupEventPayloads["fulfillment.shipment-group.admission-committed"];
export type FulfillmentShipmentGroupAdmissionReleasedPayload =
  OrderGroupEventPayloads["fulfillment.shipment-group.admission-released"];

function factContract<const K extends OrderGroupFactType, P extends JsonObject>(
  type: K,
  schema: { parse: Parser<P>; requiredFields: readonly string[] },
  publisher: "ordering" | "fulfillment",
  consumers: readonly ("ordering" | "fulfillment")[],
) {
  const codec: DomainEventCodec<{ type: K; data: P }> = {
    encode(event) {
      if (event.type !== type) throw new Error(`Expected ${type}.`);
      return { eventType: type, payload: schema.parse(event.data) };
    },
    decode(stored) {
      if (stored.eventType !== type) throw new Error(`Expected ${type}.`);
      return { type, data: schema.parse(stored.payload) };
    },
  };
  return { type, publisher, consumers, requiredFields: schema.requiredFields, codec };
}

/** ADR 0032's nine-row fact catalog; subscriptions remain owned by the contexts. */
export const orderGroupFactRegistry = {
  "ordering.order-group.admission-requested": factContract(
    "ordering.order-group.admission-requested",
    orderGroupPayloadValidators["ordering.order-group.admission-requested"],
    "ordering",
    ["fulfillment", "ordering"],
  ),
  "ordering.order-group.admission-aborted": factContract(
    "ordering.order-group.admission-aborted",
    orderGroupPayloadValidators["ordering.order-group.admission-aborted"],
    "ordering",
    ["fulfillment", "ordering"],
  ),
  "ordering.order-group.formed": factContract(
    "ordering.order-group.formed",
    orderGroupPayloadValidators["ordering.order-group.formed"],
    "ordering",
    ["fulfillment", "ordering"],
  ),
  "ordering.order-group.member-removed": factContract(
    "ordering.order-group.member-removed",
    orderGroupPayloadValidators["ordering.order-group.member-removed"],
    "ordering",
    ["fulfillment", "ordering"],
  ),
  "ordering.order-group.dissolved": factContract(
    "ordering.order-group.dissolved",
    orderGroupPayloadValidators["ordering.order-group.dissolved"],
    "ordering",
    ["fulfillment", "ordering"],
  ),
  "fulfillment.shipment-group.admission-reserved": factContract(
    "fulfillment.shipment-group.admission-reserved",
    orderGroupPayloadValidators["fulfillment.shipment-group.admission-reserved"],
    "fulfillment",
    ["ordering"],
  ),
  "fulfillment.shipment-group.admission-rejected": factContract(
    "fulfillment.shipment-group.admission-rejected",
    orderGroupPayloadValidators["fulfillment.shipment-group.admission-rejected"],
    "fulfillment",
    ["ordering"],
  ),
  "fulfillment.shipment-group.admission-committed": factContract(
    "fulfillment.shipment-group.admission-committed",
    orderGroupPayloadValidators["fulfillment.shipment-group.admission-committed"],
    "fulfillment",
    ["ordering", "fulfillment"],
  ),
  "fulfillment.shipment-group.admission-released": factContract(
    "fulfillment.shipment-group.admission-released",
    orderGroupPayloadValidators["fulfillment.shipment-group.admission-released"],
    "fulfillment",
    ["ordering", "fulfillment"],
  ),
};

const failureSchema = closedObject({ status: oneOf([...admissionRejectionReasons, "not-reserved", "released"]) });
const reservedResult = closedObject({
  status: oneOf(["accepted", "replayed"]),
  fact: orderGroupPayloadValidators["fulfillment.shipment-group.admission-reserved"].parse,
});
const committedResult = closedObject({
  status: oneOf(["accepted", "replayed"]),
  fact: orderGroupPayloadValidators["fulfillment.shipment-group.admission-committed"].parse,
});
const committedReplayResult = closedObject({
  status: oneOf(["replayed"]),
  fact: orderGroupPayloadValidators["fulfillment.shipment-group.admission-committed"].parse,
});
function abortedRelease(value: unknown) {
  const fact = orderGroupPayloadValidators["fulfillment.shipment-group.admission-released"].parse(value);
  if (fact.reason !== "aborted")
    throw new Error("Abort cannot release committed admission; dissolution owns that release.");
  return { ...fact, reason: fact.reason };
}
const releasedResult = closedObject({
  status: oneOf(["accepted", "replayed"]),
  fact: abortedRelease,
});
type AdmissionFailure = ReturnType<typeof failureSchema.parse>;
export type ReserveResult =
  | ReturnType<typeof reservedResult.parse>
  | ReturnType<typeof committedReplayResult.parse>
  | AdmissionFailure;
export type CommitResult = ReturnType<typeof committedResult.parse> | AdmissionFailure;
export type AbortResult = ReturnType<typeof releasedResult.parse> | AdmissionFailure;

export function parseReserveResult(value: unknown): ReserveResult {
  const input = record(value);
  if (input.status !== "accepted" && input.status !== "replayed") return failureSchema.parse(value);
  return Object.hasOwn(record(input.fact), "committedAt")
    ? committedReplayResult.parse(value)
    : reservedResult.parse(value);
}
export function parseCommitResult(value: unknown): CommitResult {
  const input = record(value);
  return input.status === "accepted" || input.status === "replayed"
    ? committedResult.parse(value)
    : failureSchema.parse(value);
}
export function parseAbortResult(value: unknown): AbortResult {
  const input = record(value);
  return input.status === "accepted" || input.status === "replayed"
    ? releasedResult.parse(value)
    : failureSchema.parse(value);
}

export interface ShipmentGroupAdmissionAuthority {
  reserve(input: AdmissionIdentity, context: EventStoreContext): Promise<ReserveResult>;
  commit(input: AdmissionIdentity & { anchorOrderVersion: number }, context: EventStoreContext): Promise<CommitResult>;
  abort(input: AdmissionIdentity & { reason: AbortReason }, context: EventStoreContext): Promise<AbortResult>;
}

export const orderGroupCombinedPlanContractVersion = "order-group-combined-plan/v1";

const boolean = (value: unknown): boolean => {
  if (typeof value !== "boolean") throw new Error("Expected a boolean.");
  return value;
};
const strings = (value: unknown): readonly string[] => {
  if (!Array.isArray(value)) throw new Error("Expected an array.");
  return value.map(text);
};
const measure = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > Number.MAX_SAFE_INTEGER)
    throw new Error("Expected a positive finite measure within safe numeric bounds.");
  return value;
};
const insuredValue = (value: unknown): string | null => {
  if (value === null) return null;
  const amount = text(value);
  if (!/^(0|[1-9]\d*)\.\d{2}$/.test(amount) || !Number.isSafeInteger(Number(amount.replace(".", ""))))
    throw new Error("Expected a non-negative monetary amount in whole cents.");
  return amount;
};
const combinedPackage = closedObject({
  packageId: text,
  mailpieceClass: oneOf(["letter", "parcel"]),
  lengthInches: measure,
  widthInches: measure,
  heightInches: measure,
  weightOunces: measure,
  billableWeightOunces: measure,
  serviceLevel: oneOf(["letter", "standard-parcel", "expedited-parcel", "priority-parcel"]),
  productMeasureVersions: strings,
});
const combinedPackagePlan = closedObject({
  packagePlanVersion: text,
  packageCount: (value: unknown): 1 => {
    if (value !== 1) throw new Error("Combined dispatch requires one package.");
    return 1;
  },
  packages: (value: unknown) => {
    if (!Array.isArray(value) || value.length !== 1) throw new Error("Expected exactly one package.");
    return [combinedPackage.parse(value[0])] as const;
  },
  letterEligibility: closedObject({ eligible: boolean, reasons: strings }).parse,
  postagePolicySnapshot: closedObject({
    policyVersion: text,
    parcelRequired: boolean,
    parcelReasons: strings,
    signatureRequired: boolean,
    signatureReasons: strings,
    insuranceRequired: boolean,
    insuranceReasons: strings,
    insuredValueAmount: insuredValue,
    shippingEvidenceTier: oneOf(["letter-untracked", "tracked-parcel", "signature-confirmed", "carrier-insured"]),
  }).parse,
  missingProductIds: (value: unknown): readonly string[] => {
    if (!Array.isArray(value) || value.length !== 0) throw new Error("Combined measures must be complete.");
    return [];
  },
});

const combinedPlanAcceptedSchema = closedObject({
  contractVersion: oneOf([orderGroupCombinedPlanContractVersion]),
  ...identityFields,
  combinedPackagePlan: combinedPackagePlan.parse,
});
export function parseOrderGroupCombinedPlanAccepted(value: unknown) {
  const fact = combinedPlanAcceptedSchema.parse(value);
  distinctOrders(fact);
  return fact;
}
export type OrderGroupCombinedPlanAccepted = ReturnType<typeof parseOrderGroupCombinedPlanAccepted>;
export const orderGroupCombinedPlanAcceptedCodec: DomainEventCodec<{
  type: "ordering.order.combined-plan-accepted";
  data: OrderGroupCombinedPlanAccepted;
}> = {
  encode: (event) => {
    if (event.type !== "ordering.order.combined-plan-accepted") throw new Error("Unexpected combined plan event.");
    return { eventType: event.type, payload: parseOrderGroupCombinedPlanAccepted(event.data) };
  },
  decode: (event) => {
    if (event.eventType !== "ordering.order.combined-plan-accepted") throw new Error("Unexpected combined plan event.");
    return { type: event.eventType, data: parseOrderGroupCombinedPlanAccepted(event.payload) };
  },
};
