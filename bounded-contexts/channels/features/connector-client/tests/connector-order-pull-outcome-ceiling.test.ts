import { expect, it } from "vitest";
import { canonicalJson } from "../../listing-composition/domain/canonical-json";
import { resolveOrderPullBudget } from "../../outbound-sync/domain/order-pull-codec";
import { orderPullCheckpointDigest } from "../../outbound-sync/domain/order-pull-progress";
import { orderPullProgressByteLimit } from "../../outbound-sync/domain/order-pull-progress-codec";
import { syntheticPage } from "../../outbound-sync/tests/order-pull-fixtures";
import { orderPullReportOutcome, parseOrderPullHandoff, type OrderPullHandoff } from "../domain/order-pull-handoff";
import {
  browserPayloadDigest,
  parseExecutorResult,
  type OperationAttempt,
  type OperationReservation,
} from "../domain/operation-protocol";
import { pullFixture } from "./connector-order-pull-test-support";

const bytes = (value: unknown) => new TextEncoder().encode(canonicalJson(value)).length;

it("replays a largest-valid producer outcome from a retained receipt through report loss and ack", async () => {
  const f = await pullFixture();
  // Synthetic retained admissions, not a provider qualification or a simulated 1,000-post dispatch.
  const selector = { ...f.payload.selector, pageSize: 1000 };
  const authority = {
    ...f.handoff.authority,
    selector,
    nIntakeReadMax: 2000,
    providerCadenceMs: 1,
    providerCallTimeoutMs: 1,
    mappingJournalMs: 0,
    postTimeoutMs: 1,
    maxPostsPerOrder: 1,
  };
  const budget = resolveOrderPullBudget(authority, { listReads: 2, intakeReads: 2000, followUpReads: 0 });
  if (budget.kind !== "fits") throw new Error("fixture drift");
  const checkpoint = { ...f.payload.checkpoint, selector };
  const payload = {
    ...f.payload,
    selector,
    bounds: budget.bounds,
    checkpoint,
    checkpointDigest: orderPullCheckpointDigest(checkpoint),
  };
  const references = (prefix: string) =>
    Array.from({ length: 1000 }, (_, i) => `${prefix}-${String(i).padStart(4, "0")}-${"\u4e00".repeat(77)}`);
  const gapReferences = references("SYNTHETIC-GAP");
  const postedReferences = references("SYNTHETIC-POST");
  const progress = () => ({
    previousDigest: payload.checkpointDigest,
    pages: [
      syntheticPage(gapReferences, { nextCursor: "synthetic-1", totalOrders: null }),
      syntheticPage(postedReferences, { cursor: "synthetic-1", nextCursor: "synthetic-2", totalOrders: null }),
    ],
    postedReferences,
    gaps: gapReferences.map((reference) => ({ reference, reason: "unavailable" as const })),
    followUpTail: false,
  });
  // Gap references occur twice (page and disposition); cursor padding supplies the final odd byte.
  let excess = bytes(progress()) - orderPullProgressByteLimit;
  expect(excess).toBeGreaterThan(0);
  for (let i = 0; excess > 0; i++) {
    const count = Math.min(77, Math.ceil(excess / 6));
    gapReferences[i] = gapReferences[i].slice(0, -count);
    excess -= count * 6;
  }
  const boundedProgress = progress();
  boundedProgress.pages[1] = { ...boundedProgress.pages[1], nextCursor: `synthetic-2${"x".repeat(-excess)}` };
  expect(bytes(boundedProgress)).toBe(orderPullProgressByteLimit);
  const handoff: OrderPullHandoff = {
    authority,
    progress: boundedProgress,
    summary: null,
    bundles: postedReferences.map((reference, i) => ({
      reference,
      source: "intake",
      posts: [
        {
          kind: "fulfillment",
          externalReference: `tcf.v1:${i.toString(16).padStart(64, "0")}`,
          digest: "b".repeat(64),
          variant: "full",
          status: { surface: "detail", value: "Ready to Ship" },
          state: "captured202",
        },
      ],
    })),
    usage: { providerCalls: 2002, posts: 1000, providerNotBefore: payload.providerNotBefore },
  };
  expect(parseOrderPullHandoff(handoff, payload)).toEqual(handoff);
  const operation = f.claim.operations[0];
  const payloadDigest = await browserPayloadDigest(payload);
  const receipt = {
    outcomes: [
      {
        operationKind: operation.operationKind,
        operationId: operation.operationId,
        attemptId: operation.attemptId,
        claimGeneration: operation.claimGeneration,
        pullId: payload.pullId,
        payloadDigest,
        outcome: orderPullReportOutcome(payload, handoff),
      },
    ],
  };
  expect(receipt.outcomes[0].outcome.kind).toBe("continuation-required");
  expect(bytes(receipt.outcomes[0])).toBeGreaterThan(orderPullProgressByteLimit);
  expect(parseExecutorResult(receipt)).toEqual(receipt);
  const member: OperationAttempt = {
    schemaVersion: 1,
    revision: 0,
    connectionId: f.input.connectionId,
    operationId: operation.operationId,
    attemptId: operation.attemptId,
    claimGeneration: operation.claimGeneration,
    reservationId: f.claim.reservationId,
    leaseExpiresAt: f.claim.leaseExpiresAt,
    payloadDigest,
    state: "receipt-captured",
    preparedAt: f.claim.reservedAt,
    dispatchedAt: f.claim.reservedAt,
    operationKind: "tcgplayer-order-pull",
    scheduleGeneration: 1,
    payload,
    handoff,
    receipt,
  };
  const reservation: OperationReservation = {
    schemaVersion: 1,
    revision: 0,
    connectionId: f.input.connectionId,
    reservationId: f.claim.reservationId,
    executorKey: f.executor.key,
    reservedAt: f.claim.reservedAt,
    leaseExpiresAt: f.claim.leaseExpiresAt,
    memberOperationIds: [operation.operationId],
    phase: "receipt-captured",
  };
  await f.journal.change(
    f.input.connectionId,
    { members: [], reservations: [] },
    { members: [member], reservations: [reservation] },
  );
  f.claims.length = 0;
  const request = f.request.getMockImplementation()!;
  f.request.mockImplementation(async (r) => {
    const response = await request(r);
    if (new URL(r.url).pathname.endsWith("/report")) throw new Error("synthetic report loss");
    return response;
  });
  await f.coordinator().coordinate(f.input);
  const saved = await f.journal.read(f.input.connectionId);
  expect(saved.members[0].state).toBe("reported");
  expect(saved.members[0].receipt).toEqual(receipt);
  expect(saved.reservations[0].reportEnvelope?.outcomes).toEqual(receipt.outcomes);
  f.request.mockImplementation(request);
  await f.coordinator().coordinate(f.input);
  expect(f.reports).toHaveLength(2);
  expect(f.reports[1]).toBe(f.reports[0]);
  expect(f.dispatch).not.toHaveBeenCalled();
  expect(f.post).not.toHaveBeenCalled();
  expect((await f.journal.read(f.input.connectionId)).members[0].state).toBe("acked");
  const over = {
    ...handoff,
    progress: {
      ...boundedProgress,
      pages: boundedProgress.pages.map((page, i) => (i === 1 ? { ...page, nextCursor: `${page.nextCursor}x` } : page)),
    },
  };
  expect(bytes(over.progress)).toBe(orderPullProgressByteLimit + 1);
  expect(() => parseOrderPullHandoff(over, payload)).toThrow();
});
