import { describe, expect, it } from "vitest";
import {
  canonicalParticipantRequest,
  parseParticipantAttempt,
  parseParticipantLookup,
  type ParticipantAction,
} from "./participant-attempt";

describe("schema negatives", () => {
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
      expect(() =>
        canonicalParticipantRequest("open-support-request", {
          orderId: "ord_case",
          flowType: "product-not-received",
          [field]: { planted: "PRIVATE" },
        }),
      ).toThrow();
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
    for (const refundAmount of ["NaN", "Infinity", "1e3", 1, "-1.00", "1.001"])
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
