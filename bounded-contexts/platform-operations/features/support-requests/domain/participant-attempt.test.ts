import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  canonicalParticipantRequest,
  parseParticipantAttempt,
  parseParticipantLookup,
  type ParticipantAction,
} from "./participant-attempt";

describe("record-response v1 compatibility", () => {
  const cases = [
    [
      "accept-return",
      "return-for-refund",
      null,
      "f55c25ad843076764090111650709d278f019d3dbff8d7eb3b32d90a56a868bb",
      "cdf5e9128ea848276dbd4538d7c6eeca3de8f180c88d1d444cc871116da68809",
    ],
    [
      "offer-partial-refund",
      "partial-refund",
      "6.00",
      "3ba438568581f403087dcb003a79786b107e03b530c3d82b9e13318fe233bd69",
      "5311718d3c0f214609932c3796b200034f9eead83a7aec7a1120fe9a1bc54216",
    ],
    [
      "offer-replacement",
      "replacement",
      null,
      "ec80db5e99dfdb15bcd815c7d8c43f02a477ff571df2c2dadbbd2db43d01cedb",
      "efe6ae0279a96348820e786fb88d70422dbbcad3b18fdc486462ef1d011bfe09",
    ],
    [
      "provide-tracking",
      null,
      null,
      "a9c895a32c46187ee0474e55a76465ab4540a62b4816435886323df6d73860ca",
      "a9c895a32c46187ee0474e55a76465ab4540a62b4816435886323df6d73860ca",
    ],
  ] as const;
  for (const [responseType, resolution, refundAmount, explicitHash, omittedHash] of cases) {
    it(`${responseType} preserves ordered bytes and hashes for explicit/omitted/null/empty`, () => {
      for (const field of [
        { offerResolutionType: resolution },
        {},
        { offerResolutionType: null },
        { offerResolutionType: "" },
      ]) {
        const canonical = canonicalParticipantRequest("record-response", {
          responseType,
          summary: "Offer",
          refundAmount,
          ...field,
        });
        const expectedResolution = field.offerResolutionType || null;
        const expected = `{"version":1,"actionKind":"record-response","payload":{"submittedByRole":null,"responseType":"${responseType}","summary":"Offer","offerResolutionType":${JSON.stringify(expectedResolution)},"refundAmount":${JSON.stringify(refundAmount)},"affectedLineIds":null,"refundCurrencyCode":null}}`;
        expect(canonical).toBe(expected);
        expect(createHash("sha256").update(canonical).digest("hex")).toBe(
          expectedResolution ? explicitHash : omittedHash,
        );
      }
    });
  }
});

it("participant response refusal controls", () => {
  for (const field of [
    { responseType: "unknown" },
    { offerResolutionType: "unknown" },
    { offerResolutionType: 3 },
    { offerResolutionType: { nested: true } },
    { summary: { nested: true } },
    { affectedLineIds: [{ nested: true }] },
    { unknown: { nested: true } },
  ]) {
    expect(() =>
      canonicalParticipantRequest("record-response", {
        responseType: "offer-partial-refund",
        summary: "Offer",
        refundAmount: "6.00",
        ...field,
      }),
    ).toThrow();
  }
});

describe("schema negatives", () => {
  it("normalizes valid currency form amounts before hashing without admitting invalid amounts", () => {
    const body = { responseType: "offer-partial-refund", summary: "Offer", offerResolutionType: "partial-refund" };
    for (const refundAmount of ["5", "5.0", "05.00"])
      expect(canonicalParticipantRequest("record-response", { ...body, refundAmount })).toBe(
        canonicalParticipantRequest("record-response", { ...body, refundAmount: "5.00" }),
      );
  });
  it("rejects unknown canonical actions before hashing", () => {
    expect(() => canonicalParticipantRequest("unexpected" as ParticipantAction, { reason: "Valid reason" })).toThrow();
  });
  it("rejects array-shaped outcome IDs without coercion", () => {
    expect(() =>
      parseParticipantLookup({
        outcome: "committed",
        actionKind: "cancel",
        result: {
          id: ["sup_case"],
          version: 2,
          status: "cancelled",
          evidenceId: null,
          responseId: null,
          offerId: null,
        },
      }),
    ).toThrow();
  });
  it("normalizes versioned ordered business inputs, not unknown transport fields", () => {
    expect(
      canonicalParticipantRequest("open-support-request", { flowType: "product-not-received", orderId: " ord_case " }),
    ).toBe(
      canonicalParticipantRequest("open-support-request", {
        orderId: "ord_case",
        flowType: "product-not-received",
        affectedLineIds: null,
      }),
    );
    expect(
      canonicalParticipantRequest("open-support-request", {
        orderId: "ord_case",
        flowType: "product-not-received",
        affectedLineIds: ["line_a", "line_b"],
      }),
    ).not.toBe(
      canonicalParticipantRequest("open-support-request", {
        orderId: "ord_case",
        flowType: "product-not-received",
        affectedLineIds: ["line_b", "line_a"],
      }),
    );
  });
  for (const field of ["file", "filename", "path", "url", "objectKey", "cookie", "token", "metadata", "bytes"]) {
    it(`rejects private or nested ${field} in request, descriptor, and closed recursive outcome`, () => {
      for (const [actionKind, body] of [
        ["open-support-request", { orderId: "ord_case", flowType: "product-not-received" }],
        ["submit-evidence", { evidenceType: "support-note", summary: "Valid note" }],
        ["record-response", { responseType: "provide-tracking", summary: "Valid response" }],
      ] as const) {
        expect(() => canonicalParticipantRequest(actionKind, body)).not.toThrow();
        for (const value of ["PRIVATE", { planted: "PRIVATE" }])
          expect(() => canonicalParticipantRequest(actionKind, { ...body, [field]: value })).toThrow();
      }
      expect(() =>
        parseParticipantAttempt({
          attemptId: "7163_attempt_0123456789abcdef",
          requestHash: "a".repeat(64),
          [field]: "PRIVATE",
        }),
      ).toThrow();
      expect(() =>
        parseParticipantLookup({
          outcome: "committed",
          actionKind: "open-support-request",
          result: {
            id: "sup_case",
            version: 2,
            status: "opened",
            evidenceId: null,
            responseId: null,
            offerId: null,
            [field]: "PRIVATE",
          },
        }),
      ).toThrow();
    });
  }
  it("rejects invalid instants, amounts, lists, action kinds and unbounded keys", () => {
    for (const occurredAt of ["not-a-date", "2026-02-30T00:00:00.000Z", "2026-10-12", 123])
      expect(() =>
        canonicalParticipantRequest("submit-evidence", {
          submittedByRole: "buyer",
          evidenceType: "buyer-attestation",
          summary: "A",
          occurredAt,
        }),
      ).toThrow();
    for (const refundAmount of ["NaN", "Infinity", "1e3", 1, "-1.00", "1.001", "10000000000.00"])
      expect(() =>
        canonicalParticipantRequest("record-response", {
          submittedByRole: "seller",
          responseType: "offer-partial-refund",
          summary: "A",
          refundAmount,
        }),
      ).toThrow();
    expect(() =>
      canonicalParticipantRequest("open-support-request", {
        orderId: "ord_case",
        flowType: "product-not-received",
        affectedLineIds: ["line_a", "line_a"],
      }),
    ).toThrow();
    expect(() => parseParticipantAttempt({ attemptId: "a".repeat(129), requestHash: "a".repeat(64) })).toThrow();
    expect(() => parseParticipantLookup({ outcome: "unknown", reason: "connected" })).toThrow();
    expect(() => parseParticipantLookup({ outcome: "not-recorded", result: {} })).toThrow();
  });
});
