import { describe, expect, expectTypeOf, it } from "vitest";
import type { DomainEventCodec } from "@chase-sets/event-core/codec";
import type { ChaseSetsEventPayloads } from "@chase-sets/event-core/public-event-payloads";
import { parseGlobalPosition, type EventStoreContext, type StoredEvent } from "@chase-sets/event-core/storage";
import { toTransportEvent } from "@chase-sets/event-core/transport";
import { parseIsoUtcTimestamp } from "@chase-sets/primitives/iso-utc-timestamp";
import type { JsonValue } from "@chase-sets/primitives/json";
import {
  abortReasons,
  admissionIdentityFromFact,
  admissionRejectionReasons,
  admissionReleaseReasons,
  memberRemovalReasons,
  orderGroupContractVersion,
  orderGroupFactRegistry,
  orderGroupPayloadValidators,
  parseAbortInput,
  parseAbortResult,
  parseAdmissionIdentity,
  parseCommitInput,
  parseCommitResult,
  parseReserveResult,
  type AbortReason,
  type AbortResult,
  type AdmissionIdentity,
  type CommitResult,
  type OrderGroupEventPayloads,
  type OrderGroupFactType,
  type ReserveResult,
  type ShipmentGroupAdmissionAuthority,
} from "@chase-sets/order-groups";

const timestamp = "2026-10-03T20:00:00.000Z";
const identity: AdmissionIdentity = {
  requestId: "request-1",
  sourceGeneration: 0,
  draftKey: "draft-1",
  anchorShipmentId: "shp_01ARYZ6S41TSV4RRFFQ69G5FAV",
  anchorOrderId: "ord_01ARYZ6S41TSV4RRFFQ69G5FAV",
  proposedMemberOrderId: "ord_01ARYZ6S41TSV4RRFFQ69G5FAW",
  groupId: "ogr_01ARYZ6S41TSV4RRFFQ69G5FAV",
  quoteFingerprint: "quote-1",
};
const thirdOrderId = "ord_01ARYZ6S41TSV4RRFFQ69G5FAX";
const pair = [identity.anchorOrderId, identity.proposedMemberOrderId] as const;
const admission = { contractVersion: orderGroupContractVersion, ...identity } as const;
const removal = {
  contractVersion: orderGroupContractVersion,
  requestId: identity.requestId,
  groupId: identity.groupId,
  anchorOrderId: identity.anchorOrderId,
  anchorShipmentId: identity.anchorShipmentId,
  memberOrderIds: pair,
  removedOrderId: identity.proposedMemberOrderId,
  reason: "buyer-cancelled",
  anchorOrderVersion: 4,
} as const;
const payloads = {
  "ordering.order-group.admission-requested": { ...admission, requestedAt: timestamp, anchorOrderVersion: 4 },
  "ordering.order-group.admission-aborted": {
    ...admission,
    reason: "quote-stale",
    abortedAt: timestamp,
    anchorOrderVersion: 4,
  },
  "ordering.order-group.formed": {
    ...admission,
    memberOrderIds: pair,
    formedAt: timestamp,
    anchorOrderVersion: 4,
    stagedMemberOrderVersion: 1,
  },
  "ordering.order-group.member-removed": { ...removal, removedAt: timestamp },
  "ordering.order-group.dissolved": { ...removal, dissolvedAt: timestamp },
  "fulfillment.shipment-group.admission-reserved": { ...admission, reservedAt: timestamp, shipmentVersion: 2 },
  "fulfillment.shipment-group.admission-rejected": {
    ...admission,
    reason: "packing-started",
    rejectedAt: timestamp,
    shipmentVersion: 2,
  },
  "fulfillment.shipment-group.admission-committed": {
    ...admission,
    anchorOrderVersion: 4,
    committedAt: timestamp,
    shipmentVersion: 3,
  },
  "fulfillment.shipment-group.admission-released": {
    ...admission,
    reason: "aborted",
    releasedAt: timestamp,
    shipmentVersion: 4,
  },
} satisfies OrderGroupEventPayloads;
const context: EventStoreContext = {
  tenantId: "tnt_01ARYZ6S41TSV4RRFFQ69G5FAV",
  audit: { performedByUserId: "usr_01ARYZ6S41TSV4RRFFQ69G5FAV", forAccountId: "acc_01ARYZ6S41TSV4RRFFQ69G5FAV" },
};

function stored<K extends OrderGroupFactType>(eventType: K): StoredEvent<K, OrderGroupEventPayloads[K]> {
  return {
    eventId: "evt_01ARYZ6S41TSV4RRFFQ69G5FAV",
    eventType,
    payload: payloads[eventType],
    streamId: `${eventType.startsWith("ordering.") ? "ordering.order" : "fulfillment.shipment"}-anchor`,
    streamVersion: 4,
    globalPosition: parseGlobalPosition("12"),
    tenantId: context.tenantId,
    metadata: { causationId: null },
    ...context.audit,
    occurredAt: parseIsoUtcTimestamp(timestamp),
    recordedAt: parseIsoUtcTimestamp(timestamp),
  };
}

// The keys are copied from #7197 / ADR 0032, not derived from the validators under test.
const identityKeys = [
  "requestId",
  "sourceGeneration",
  "draftKey",
  "anchorShipmentId",
  "anchorOrderId",
  "proposedMemberOrderId",
  "groupId",
  "quoteFingerprint",
];
const admissionKeys = ["contractVersion", ...identityKeys];
const removalKeys = [
  "contractVersion",
  "requestId",
  "groupId",
  "anchorOrderId",
  "anchorShipmentId",
  "memberOrderIds",
  "removedOrderId",
  "reason",
  "anchorOrderVersion",
];
const expectedFields = {
  "ordering.order-group.admission-requested": [...admissionKeys, "requestedAt", "anchorOrderVersion"],
  "ordering.order-group.admission-aborted": [...admissionKeys, "reason", "abortedAt", "anchorOrderVersion"],
  "ordering.order-group.formed": [
    ...admissionKeys,
    "memberOrderIds",
    "formedAt",
    "anchorOrderVersion",
    "stagedMemberOrderVersion",
  ],
  "ordering.order-group.member-removed": [...removalKeys, "removedAt"],
  "ordering.order-group.dissolved": [...removalKeys, "dissolvedAt"],
  "fulfillment.shipment-group.admission-reserved": [...admissionKeys, "reservedAt", "shipmentVersion"],
  "fulfillment.shipment-group.admission-rejected": [...admissionKeys, "reason", "rejectedAt", "shipmentVersion"],
  "fulfillment.shipment-group.admission-committed": [
    ...admissionKeys,
    "anchorOrderVersion",
    "committedAt",
    "shipmentVersion",
  ],
  "fulfillment.shipment-group.admission-released": [...admissionKeys, "reason", "releasedAt", "shipmentVersion"],
} satisfies Record<OrderGroupFactType, string[]>;

function codecSuite<K extends OrderGroupFactType>(
  type: K,
  codec: DomainEventCodec<{ type: K; data: OrderGroupEventPayloads[K] }>,
) {
  describe(type, () => {
    const source = stored(type);
    it("round-trips the stored public envelope with the same direct payload type", () => {
      const decoded = codec.decode(JSON.parse(JSON.stringify(source)));
      expect(decoded).toEqual({ type, data: payloads[type] });
      expect(codec.encode(decoded)).toEqual({ eventType: type, payload: payloads[type] });
      expect(toTransportEvent(source).data).toEqual(decoded.data);
      expect(Object.keys(decoded.data).sort()).toEqual([...expectedFields[type]].sort());
    });
    for (const field of expectedFields[type]) {
      it(`rejects missing ${field}`, () => {
        const payload: Record<string, JsonValue> = { ...source.payload };
        delete payload[field];
        expect(() => codec.decode({ ...source, payload })).toThrow();
      });
    }
    it.each(["buyerEmail", "money", "requestedBy", "unknown"])("rejects extra %s on encode and decode", (field) => {
      const data = { ...source.payload, [field]: "not part of this contract" };
      expect(() => codec.decode({ ...source, payload: data })).toThrow();
      expect(() => codec.encode({ type, data })).toThrow();
    });
    it.each([{ payload: null }, { payload: [] }, { payload: "payload" }, { payload: 7 }])(
      "rejects a malformed payload: $payload",
      ({ payload }) => {
        expect(() => codec.decode(JSON.parse(JSON.stringify({ ...source, payload })))).toThrow();
      },
    );
    it("rejects wrong event and schema versions", () => {
      expect(() => codec.decode({ ...source, eventType: `${type}.v1` })).toThrow();
      expect(() =>
        codec.decode({ ...source, payload: { ...source.payload, contractVersion: "order-group-admission/v2" } }),
      ).toThrow();
    });
    for (const field of expectedFields[type].filter((key) => key.endsWith("At"))) {
      it.each(["2026-10-03", "2026-10-03T20:00:00", "2026-02-30T20:00:00Z", "2026-10-03T24:00:00Z", "not-a-date"])(
        `rejects malformed ${field}: %s`,
        (value) => {
          expect(() => codec.decode({ ...source, payload: { ...source.payload, [field]: value } })).toThrow();
        },
      );
      it("accepts explicit timezone offsets without rewriting facts", () => {
        const data = { ...source.payload, [field]: "2026-10-03T15:00:00-05:00" };
        expect(codec.decode({ ...source, payload: data }).data).toEqual(data);
      });
    }
    for (const field of expectedFields[type].filter((key) => key.endsWith("Version") && key !== "contractVersion")) {
      it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "4", null])(`rejects out-of-range ${field}: %j`, (value) => {
        expect(() => codec.decode({ ...source, payload: { ...source.payload, [field]: value } })).toThrow();
      });
    }
    if (expectedFields[type].includes("sourceGeneration")) {
      it.each([-1, 0.5, Number.MAX_SAFE_INTEGER + 1, "0", null])(
        "rejects malformed stored generation: %j",
        (sourceGeneration) => {
          expect(() => codec.decode({ ...source, payload: { ...source.payload, sourceGeneration } })).toThrow();
        },
      );
    }
    it("rejects malformed IDs and opaque identity fields", () => {
      for (const field of expectedFields[type].filter(
        (key) => key.endsWith("Id") || ["draftKey", "quoteFingerprint"].includes(key),
      )) {
        expect(() => codec.decode({ ...source, payload: { ...source.payload, [field]: "" } })).toThrow();
      }
      expect(() =>
        codec.decode({ ...source, payload: { ...source.payload, groupId: identity.anchorShipmentId } }),
      ).toThrow();
    });
  });
}
codecSuite(
  "ordering.order-group.admission-requested",
  orderGroupFactRegistry["ordering.order-group.admission-requested"].codec,
);
codecSuite(
  "ordering.order-group.admission-aborted",
  orderGroupFactRegistry["ordering.order-group.admission-aborted"].codec,
);
codecSuite("ordering.order-group.formed", orderGroupFactRegistry["ordering.order-group.formed"].codec);
codecSuite("ordering.order-group.member-removed", orderGroupFactRegistry["ordering.order-group.member-removed"].codec);
codecSuite("ordering.order-group.dissolved", orderGroupFactRegistry["ordering.order-group.dissolved"].codec);
codecSuite(
  "fulfillment.shipment-group.admission-reserved",
  orderGroupFactRegistry["fulfillment.shipment-group.admission-reserved"].codec,
);
codecSuite(
  "fulfillment.shipment-group.admission-rejected",
  orderGroupFactRegistry["fulfillment.shipment-group.admission-rejected"].codec,
);
codecSuite(
  "fulfillment.shipment-group.admission-committed",
  orderGroupFactRegistry["fulfillment.shipment-group.admission-committed"].codec,
);
codecSuite(
  "fulfillment.shipment-group.admission-released",
  orderGroupFactRegistry["fulfillment.shipment-group.admission-released"].codec,
);

describe("exact-two membership and closed reasons", () => {
  for (const type of [
    "ordering.order-group.formed",
    "ordering.order-group.member-removed",
    "ordering.order-group.dissolved",
  ] as const) {
    it.each([
      { members: [] },
      { members: [pair[0]] },
      { members: [...pair, thirdOrderId] },
      { members: [pair[0], pair[0]] },
      { members: [pair[1], pair[0]] },
      { members: [{ id: pair[0], extra: true }, pair[1]] },
    ])(`${type} rejects wrong cardinality, identity or nested extras: $members`, ({ members }) => {
      expect(() => orderGroupPayloadValidators[type].parse({ ...payloads[type], memberOrderIds: members })).toThrow();
    });
  }
  it("rejects formation with a different proposed member", () => {
    expect(() =>
      orderGroupPayloadValidators["ordering.order-group.formed"].parse({
        ...payloads["ordering.order-group.formed"],
        proposedMemberOrderId: thirdOrderId,
      }),
    ).toThrow();
  });
  it.each(["ordering.order-group.member-removed", "ordering.order-group.dissolved"] as const)(
    "requires %s to remove an original member",
    (type) => {
      expect(() =>
        orderGroupPayloadValidators[type].parse({ ...payloads[type], removedOrderId: thirdOrderId }),
      ).toThrow();
      for (const reason of memberRemovalReasons) {
        for (const removedOrderId of pair)
          expect(orderGroupPayloadValidators[type].parse({ ...payloads[type], reason, removedOrderId }).reason).toBe(
            reason,
          );
      }
    },
  );
  it("pins all reason catalogs and rejects former/default Abort aliases", () => {
    expect(abortReasons).toEqual([
      "quote-stale",
      "reservation-rejected",
      "capacity-rejected",
      "stage-failed",
      "cancelled",
      "compensating",
    ]);
    expect(memberRemovalReasons).toEqual([
      "buyer-cancelled",
      "seller-cancelled",
      "support-cancel-order",
      "seller-cannot-fulfill",
      "payment-deadline",
      "inventory-unavailable",
      "fraud",
      "compensating",
    ]);
    expect(admissionRejectionReasons).toEqual(["packing-started", "cancelled", "already-grouped", "identity-conflict"]);
    expect(admissionReleaseReasons).toEqual(["aborted", "group-dissolved"]);
    for (const reason of abortReasons) expect(parseAbortInput({ ...identity, reason }).reason).toBe(reason);
    for (const reason of [
      "aborted",
      "stale-quote",
      "reservation-failed",
      "capacity-failed",
      "staging-failed",
      "buyer-cancelled",
      "group-dissolved",
      "expired",
      "unknown",
      "",
    ]) {
      expect(() => parseAbortInput({ ...identity, reason })).toThrow();
      expect(() =>
        orderGroupPayloadValidators["ordering.order-group.admission-aborted"].parse({
          ...payloads["ordering.order-group.admission-aborted"],
          reason,
        }),
      ).toThrow();
    }
    for (const type of [
      "ordering.order-group.member-removed",
      "ordering.order-group.dissolved",
      "fulfillment.shipment-group.admission-rejected",
      "fulfillment.shipment-group.admission-released",
    ] as const) {
      expect(() => orderGroupPayloadValidators[type].parse({ ...payloads[type], reason: "unknown" })).toThrow();
    }
  });
});

describe("direct admission boundary", () => {
  it("closes direct inputs and imposes finite integer bounds", () => {
    expect(parseAdmissionIdentity(identity)).toEqual(identity);
    expect(Object.keys(parseAdmissionIdentity(identity))).toEqual(identityKeys);
    for (const field of identityKeys) {
      const value: Record<string, unknown> = { ...identity };
      delete value[field];
      expect(() => parseAdmissionIdentity(value)).toThrow();
    }
    for (const sourceGeneration of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN, "0", null]) {
      expect(() => parseAdmissionIdentity({ ...identity, sourceGeneration })).toThrow();
    }
    expect(parseAdmissionIdentity({ ...identity, sourceGeneration: Number.MAX_SAFE_INTEGER }).sourceGeneration).toBe(
      Number.MAX_SAFE_INTEGER,
    );
    expect(() => parseAdmissionIdentity({ ...identity, requestedAt: timestamp })).toThrow();
    expect(() => parseCommitInput({ ...identity, anchorOrderVersion: 4, timestamp })).toThrow();
    expect(() => parseAbortInput({ ...identity, reason: "cancelled", timestamp })).toThrow();
    expect(() => parseAdmissionIdentity({ ...identity, proposedMemberOrderId: identity.anchorOrderId })).toThrow();
    for (const anchorOrderId of [
      "ord_bad",
      "shp_01ARYZ6S41TSV4RRFFQ69G5FAV",
      "ord_01aryz6s41tsv4rrffq69g5fav",
      "ord_81ARYZ6S41TSV4RRFFQ69G5FAV",
    ]) {
      expect(() => parseAdmissionIdentity({ ...identity, anchorOrderId })).toThrow();
    }
  });

  it("shares exact input, result and public-payload types across package boundaries", () => {
    expectTypeOf<Parameters<ShipmentGroupAdmissionAuthority["reserve"]>>().toEqualTypeOf<
      [AdmissionIdentity, EventStoreContext]
    >();
    expectTypeOf<Parameters<ShipmentGroupAdmissionAuthority["commit"]>>().toEqualTypeOf<
      [AdmissionIdentity & { anchorOrderVersion: number }, EventStoreContext]
    >();
    expectTypeOf<Parameters<ShipmentGroupAdmissionAuthority["abort"]>>().toEqualTypeOf<
      [AdmissionIdentity & { reason: AbortReason }, EventStoreContext]
    >();
    expectTypeOf<ReturnType<ShipmentGroupAdmissionAuthority["reserve"]>>().toEqualTypeOf<Promise<ReserveResult>>();
    expectTypeOf<ReturnType<ShipmentGroupAdmissionAuthority["commit"]>>().toEqualTypeOf<Promise<CommitResult>>();
    expectTypeOf<ReturnType<ShipmentGroupAdmissionAuthority["abort"]>>().toEqualTypeOf<Promise<AbortResult>>();
    expectTypeOf<Pick<ChaseSetsEventPayloads, OrderGroupFactType>>().toEqualTypeOf<OrderGroupEventPayloads>();
    expectTypeOf<ReturnType<typeof parseCommitInput>>().toEqualTypeOf<
      Readonly<AdmissionIdentity & { anchorOrderVersion: number }>
    >();
    expectTypeOf<ReturnType<typeof parseAbortInput>>().toEqualTypeOf<
      Readonly<AdmissionIdentity & { reason: AbortReason }>
    >();
  });
});

// A contract fixture, not an aggregate: no clock, storage, or lifecycle implementation is exported.
function fulfillmentAuthorityFixture(): ShipmentGroupAdmissionAuthority {
  let reserved: ReturnType<typeof parseAdmissionIdentity> | undefined;
  return {
    async reserve(input, receivedContext) {
      expect(receivedContext).toBe(context);
      const parsed = parseAdmissionIdentity(input);
      if (reserved && JSON.stringify(reserved) !== JSON.stringify(parsed)) return { status: "identity-conflict" };
      const replay = reserved !== undefined;
      reserved = parsed;
      return parseReserveResult({
        status: replay ? "replayed" : "accepted",
        fact: {
          contractVersion: orderGroupContractVersion,
          ...parsed,
          reservedAt: timestamp,
          shipmentVersion: 2,
        },
      });
    },
    async commit(input, receivedContext) {
      expect(receivedContext).toBe(context);
      const parsed = parseCommitInput(input);
      return parseCommitResult({
        status: "accepted",
        fact: {
          contractVersion: orderGroupContractVersion,
          ...parsed,
          committedAt: timestamp,
          shipmentVersion: 3,
        },
      });
    },
    async abort(input, receivedContext) {
      expect(receivedContext).toBe(context);
      const parsed = parseAbortInput(input);
      return parseAbortResult({
        status: "accepted",
        fact: {
          contractVersion: orderGroupContractVersion,
          ...admissionIdentityFromFact(parsed),
          reason: "aborted",
          releasedAt: timestamp,
          shipmentVersion: 4,
        },
      });
    },
  };
}

async function orderingReserveFixture(authority: ShipmentGroupAdmissionAuthority, input: AdmissionIdentity) {
  return authority.reserve(input, context);
}

describe("direct and durable identity golden vectors", () => {
  it("produces byte-identical reserved facts from direct input and a stored request, including next-day replay", async () => {
    const direct = await orderingReserveFixture(fulfillmentAuthorityFixture(), identity);
    const request = orderGroupFactRegistry["ordering.order-group.admission-requested"].codec.decode(
      stored("ordering.order-group.admission-requested"),
    );
    const authority = fulfillmentAuthorityFixture();
    const recovered = await orderingReserveFixture(authority, admissionIdentityFromFact(request.data));
    expect(JSON.stringify(recovered)).toBe(JSON.stringify(direct));
    const nextDay = {
      ...stored("ordering.order-group.admission-requested"),
      recordedAt: parseIsoUtcTimestamp("2026-10-04T20:00:00.000Z"),
    };
    const replay = await orderingReserveFixture(
      authority,
      admissionIdentityFromFact(
        orderGroupFactRegistry["ordering.order-group.admission-requested"].codec.decode(nextDay).data,
      ),
    );
    expect(replay).toEqual({ ...direct, status: "replayed" });
    if (direct.status !== "accepted" || recovered.status !== "accepted" || replay.status !== "replayed")
      throw new Error("Expected facts.");
    expect(JSON.stringify(direct.fact)).toBe(JSON.stringify(recovered.fact));
    expect(JSON.stringify(replay.fact)).toBe(JSON.stringify(direct.fact));
  });
  const changedIdentities = {
    requestId: { ...identity, requestId: "request-2" },
    sourceGeneration: { ...identity, sourceGeneration: 1 },
    draftKey: { ...identity, draftKey: "draft-2" },
    anchorShipmentId: { ...identity, anchorShipmentId: "shp_01ARYZ6S41TSV4RRFFQ69G5FAW" },
    anchorOrderId: { ...identity, anchorOrderId: thirdOrderId },
    proposedMemberOrderId: { ...identity, proposedMemberOrderId: thirdOrderId },
    groupId: { ...identity, groupId: "ogr_01ARYZ6S41TSV4RRFFQ69G5FAW" },
    quoteFingerprint: { ...identity, quoteFingerprint: "quote-2" },
  } satisfies Record<keyof AdmissionIdentity, AdmissionIdentity>;
  for (const [field, changed] of Object.entries(changedIdentities)) {
    it(`treats changed ${field} as identity-conflict without replacing the reserved identity`, async () => {
      const authority = fulfillmentAuthorityFixture();
      await orderingReserveFixture(authority, identity);
      expect(await orderingReserveFixture(authority, changed)).toEqual({ status: "identity-conflict" });
      expect((await orderingReserveFixture(authority, identity)).status).toBe("replayed");
    });
  }
  it("composes Ordering and Fulfillment through the real port without casts or local interfaces", async () => {
    const fulfillment = fulfillmentAuthorityFixture();
    expect((await orderingReserveFixture(fulfillment, identity)).status).toBe("accepted");
    expect((await fulfillment.commit({ ...identity, anchorOrderVersion: 4 }, context)).status).toBe("accepted");
    expect((await fulfillment.abort({ ...identity, reason: "cancelled" }, context)).status).toBe("accepted");
  });
});

describe("closed result unions", () => {
  const statuses = [
    "packing-started",
    "cancelled",
    "already-grouped",
    "identity-conflict",
    "not-reserved",
    "released",
  ] as const;
  it("is exhaustive over success, replay and every rejection", () => {
    expectTypeOf<ReserveResult["status"]>().toEqualTypeOf<"accepted" | "replayed" | (typeof statuses)[number]>();
    expectTypeOf<CommitResult["status"]>().toEqualTypeOf<ReserveResult["status"]>();
    expectTypeOf<AbortResult["status"]>().toEqualTypeOf<ReserveResult["status"]>();
  });
  for (const [name, parse, fact] of [
    ["reserve", parseReserveResult, payloads["fulfillment.shipment-group.admission-reserved"]],
    ["commit", parseCommitResult, payloads["fulfillment.shipment-group.admission-committed"]],
    ["abort", parseAbortResult, payloads["fulfillment.shipment-group.admission-released"]],
  ] as const) {
    it(`${name} validates every result and recursively closes the fact`, () => {
      for (const status of statuses) expect(parse({ status })).toEqual({ status });
      for (const status of ["accepted", "replayed"]) expect(parse({ status, fact })).toEqual({ status, fact });
      for (const value of [
        null,
        {},
        { status: "unknown" },
        { status: "accepted" },
        { status: "accepted", fact: { ...fact, extra: true } },
        { status: "accepted", fact, extra: true },
        { status: "released", fact },
        { status: "not-reserved", reason: "expired" },
      ]) {
        expect(() => parse(value)).toThrow();
      }
    });
  }
  it("permits reserve replay of durable committed authority, not just a reservation", () => {
    const value = { status: "replayed", fact: payloads["fulfillment.shipment-group.admission-committed"] };
    expect(parseReserveResult(value)).toEqual(value);
    expect(() => parseReserveResult({ ...value, status: "accepted" })).toThrow();
    expect(() =>
      parseCommitResult({ status: "accepted", fact: payloads["fulfillment.shipment-group.admission-reserved"] }),
    ).toThrow();
    expect(() => parseAbortResult(value)).toThrow();
    expect(() =>
      parseAbortResult({
        status: "accepted",
        fact: {
          ...payloads["fulfillment.shipment-group.admission-released"],
          reason: "group-dissolved",
        },
      }),
    ).toThrow();
  });
});

describe("nine-fact catalog", () => {
  it("has one identity, publisher, consumers and exact required fields for every ADR row", () => {
    expect(Object.keys(orderGroupFactRegistry).sort()).toEqual(Object.keys(expectedFields).sort());
    for (const [type, entry] of Object.entries(orderGroupFactRegistry)) {
      expect(entry.type).toBe(type);
      expect(entry.publisher).toBe(type.split(".")[0]);
      const consumers = type.startsWith("ordering.")
        ? ["fulfillment", "ordering"]
        : ["fulfillment.shipment-group.admission-committed", "fulfillment.shipment-group.admission-released"].includes(
              type,
            )
          ? ["ordering", "fulfillment"]
          : ["ordering"];
      expect(entry.consumers).toEqual(consumers);
      expect([...entry.requiredFields].sort()).toEqual([...expectedFields[entry.type]].sort());
    }
  });
});
