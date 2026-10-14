import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as validation from "../../outbound-sync/domain/validation";
import { canonicalJson } from "../../outbound-sync/domain/validation";
import { payloadDigest } from "../../outbound-sync/api/payload-digest";
import { deriveLiveExportId } from "../../outbound-sync/api/live-export-payload";
import {
  assertClaimedLiveExportOutcome,
  type ClaimedLiveExportOutcome,
} from "../../outbound-sync/domain/live-export-codec";
import * as contracts from "../../outbound-sync/domain/contracts";
import * as listing from "../../listing-composition/domain/codecs";
import * as provider from "../../publication-port/domain/validation";
import * as settlement from "../../connector-feed/domain/run-settlement";
import * as records from "../domain/extension-records";
import * as pullCodec from "../../outbound-sync/domain/order-pull-codec";
import * as handoff from "../domain/order-pull-handoff";
import * as stagedImport from "../domain/staged-import-dispatch";
import * as operationCodec from "../domain/operation-codec";
import {
  assertTotalResult,
  browserPayloadDigest,
  parseExecutorResult,
  parseOperationClaim,
  type OperationAttempt,
} from "../domain/operation-protocol";
import { coordinatorFixture } from "./coordinator-test-support";
import { pullFixture } from "./connector-order-pull-test-support";
import { evaluate } from "./coordinator-mutation-support";

afterEach(() => vi.restoreAllMocks());

function substitutedExport(member: OperationAttempt): ClaimedLiveExportOutcome {
  const outcome: ClaimedLiveExportOutcome = {
    operationKind: "tcgplayer-live-export",
    operationId: member.operationId,
    attemptId: member.attemptId,
    claimGeneration: member.claimGeneration,
    payloadDigest: member.payloadDigest,
    exportId: deriveLiveExportId(member.connectionId, 1),
    outcome: { kind: "abandoned", reason: "claimant-cancelled" },
  };
  assertClaimedLiveExportOutcome(outcome);
  return outcome;
}

describe("connector-operation-protocol-schema", () => {
  it.each(["listing", "order-pull"] as const)(
    "rejects a valid live-export result substituted for %s with matching identity and digest",
    async (kind) => {
      const f = kind === "listing" ? await coordinatorFixture() : await pullFixture();
      expect((await f.coordinator().coordinate(f.input)).outcome).toBe("ok");
      const state = await f.journal.read(f.input.connectionId);
      const member = state.members[0];
      expect(() => assertTotalResult(member.receipt!, [member])).not.toThrow();
      const result = { outcomes: [substitutedExport(member)] };
      expect(() => parseExecutorResult(result)).toThrow();
      expect(() => assertTotalResult(result, [member])).toThrow();
      await expect(
        f.journal.change(f.input.connectionId, state, {
          ...state,
          members: [{ ...member, revision: member.revision + 1, receipt: result }],
        }),
      ).rejects.toThrow();
      await expect(
        f.journal.change(f.input.connectionId, state, {
          ...state,
          reservations: state.reservations.map((reservation) => ({
            ...reservation,
            revision: reservation.revision + 1,
            reportEnvelope: { reservationId: reservation.reservationId, ...result },
          })),
        }),
      ).rejects.toThrow();
      expect(await f.journal.read(f.input.connectionId)).toEqual(state);
    },
  );
  it("kills exact-order-pull narrowing removal before handing a foreign outcome to handoff validation", async () => {
    const f = await pullFixture();
    await f.coordinator().coordinate(f.input);
    const member = (await f.journal.read(f.input.connectionId)).members[0];
    const result = { outcomes: [substitutedExport(member)] };
    const source = readFileSync(new URL("../domain/operation-protocol.ts", import.meta.url), "utf8");
    const guard = 'outcome.operationKind !== "tcgplayer-order-pull" ||';
    expect(source.split(guard)).toHaveLength(2);
    for (const bypass of [false, true]) {
      // Admit a canonically valid shared outcome only at the parser seam so its older
      // order-pull-only schema cannot hide the total-result discriminator under test.
      const validateOutcome = vi.fn((value: unknown) => {
        if (
          value &&
          typeof value === "object" &&
          "operationKind" in value &&
          value.operationKind === "tcgplayer-live-export"
        )
          assertClaimedLiveExportOutcome(value);
        else pullCodec.assertClaimedOrderPullOutcome(value);
      });
      const validateHandoff = vi.fn(handoff.assertHandoffOutcome);
      const evaluated = evaluate(bypass ? source.replace(guard, "") : source, {
        "../../outbound-sync/domain/contracts": contracts,
        "../../outbound-sync/domain/validation": validation,
        "../../listing-composition/domain/codecs": listing,
        "../../publication-port/domain/validation": provider,
        "../../connector-feed/domain/run-settlement": settlement,
        "./extension-records": records,
        "../../outbound-sync/domain/order-pull-codec": { ...pullCodec, assertClaimedOrderPullOutcome: validateOutcome },
        "./order-pull-handoff": { ...handoff, assertHandoffOutcome: validateHandoff },
        "./staged-import-dispatch": stagedImport,
        "./operation-codec": operationCodec,
      });
      if (typeof evaluated.assertTotalResult !== "function") throw new Error("missing total-result validator");
      const validate = evaluated.assertTotalResult;
      expect(() => validate(result, [member])).toThrow();
      expect(validateOutcome).toHaveBeenCalledTimes(1);
      expect(validateHandoff).toHaveBeenCalledTimes(bypass ? 1 : 0);
    }
  });
  it("retains the listing-only 16 KiB wire ceiling independently of stricter field bounds", () => {
    // Isolate the transport ceiling; real schema validation has its own smaller scalar limits.
    const validator = vi.spyOn(validation, "assertClaimedOperationOutcome").mockImplementation(() => {});
    try {
      const outcome = {
        operationId: "synthetic",
        attemptId: "synthetic",
        claimGeneration: 1,
        desiredStateSequence: 1,
        outcome: { kind: "applied", result: { kind: "succeeded", externalListingId: "" } },
      };
      outcome.outcome.result.externalListingId = "x".repeat(
        16384 - new TextEncoder().encode(canonicalJson(outcome)).length,
      );
      expect(parseExecutorResult({ outcomes: [outcome] }).outcomes).toEqual([outcome]);
      outcome.outcome.result.externalListingId += "x";
      expect(() => parseExecutorResult({ outcomes: [outcome] })).toThrow("protocol-violation");
    } finally {
      validator.mockRestore();
    }
  });
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
