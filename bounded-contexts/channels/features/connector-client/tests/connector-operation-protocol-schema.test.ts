import { describe, expect, it } from "vitest";
import { canonicalJson } from "../../outbound-sync/domain/validation";
import { payloadDigest } from "../../outbound-sync/api/payload-digest";
import { browserPayloadDigest, parseExecutorResult, parseOperationClaim } from "../domain/operation-protocol";
import { coordinatorFixture } from "./coordinator-test-support";

describe("connector-operation-protocol-schema", () => {
  it("preserves every landed identity and the server canonical digest", async () => {
    const f = await coordinatorFixture();
    expect(await parseOperationClaim(f.claim, f.input.connectionId)).toEqual(f.claim);
    expect(await browserPayloadDigest(f.claim.operations[0].payload)).toBe(
      payloadDigest(f.claim.operations[0].payload),
    );
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });
  it.each(["nested-unknown", "wrong-arm", "digest", "kind", "identity", "date-only"])(
    "refuses a whole %s claim before journal, executor or report effects",
    async (fault) => {
      const f = await coordinatorFixture();
      const operation = structuredClone(f.claim.operations[0]) as Record<string, unknown>;
      if (fault === "nested-unknown") {
        const payload = structuredClone(f.claim.operations[0].payload);
        if (payload.kind === "draft") Object.assign(payload.draft.price, { extra: true });
        operation.payload = payload;
        operation.payloadDigest = payloadDigest(payload);
      } else if (fault === "wrong-arm") operation.operationKind = "delist";
      else if (fault === "digest") operation.payloadDigest = "0".repeat(64);
      else if (fault === "kind") operation.operationKind = "unlanded-kind";
      else if (fault === "identity") operation.connectionId = "foreign-connection";
      else operation.enqueuedAt = "2026-10-09";
      f.claims[0] = { ...f.claim, operations: [{ ...f.claim.operations[0], operationId: "valid-sibling" }, operation] };
      expect(await f.coordinator().coordinate(f.input)).toEqual({ outcome: "protocol-violation" });
      expect(await f.journal.read(f.input.connectionId)).toEqual({ members: [], reservations: [] });
      expect(f.prepare).not.toHaveBeenCalled();
      expect(f.dispatchOnce).not.toHaveBeenCalled();
      expect(f.reports).toEqual([]);
    },
  );
  it.each(["context", "tenantId", "audit", "extra"])(
    "refuses client %s authority rather than stripping it",
    async (key) => {
      const f = await coordinatorFixture("reservation");
      expect(() =>
        parseExecutorResult({
          outcomes: [
            {
              operationId: "op",
              attemptId: "attempt",
              claimGeneration: 1,
              desiredStateSequence: 1,
              outcome: { kind: "outcome-unknown" },
            },
          ],
          runSettlement: { ...f.settlement, [key]: null },
        }),
      ).toThrow();
    },
  );
});
