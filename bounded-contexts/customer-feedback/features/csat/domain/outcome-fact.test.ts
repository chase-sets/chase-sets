import { describe, expect, it } from "vitest";
import { createCsatOutcomeFactV1 } from "./outcome-fact";

describe("createCsatOutcomeFactV1", () => {
  const input = {
    outcomeCode: "offer.accepted",
    sourceContext: "marketplace",
    subjectAccountId: "acct_seller",
    subjectKind: "seller" as const,
    subject: { entityType: "offer", entityId: "off_1" },
    outcomeOccurredAt: "2026-07-13T12:00:00.000Z",
    idempotencyKey: "marketplace:offer.accepted:off_1",
  };

  it("adds the current schema version to a registered, owned outcome", () => {
    expect(createCsatOutcomeFactV1(input)).toEqual({
      factSchemaVersion: 1,
      ...input,
    });
  });

  it("rejects unknown or mis-owned outcome codes", () => {
    expect(() => createCsatOutcomeFactV1({ ...input, outcomeCode: "offer.declined" })).toThrow(
      "provenance is not authoritative",
    );
    expect(() => createCsatOutcomeFactV1({ ...input, sourceContext: "inventory" })).toThrow(
      "provenance is not authoritative",
    );
  });
});
