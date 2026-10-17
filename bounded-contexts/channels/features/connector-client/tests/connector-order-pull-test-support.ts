import { vi } from "vitest";
import { canonicalJson } from "../../listing-composition/domain/canonical-json";
import { syntheticAuthority, syntheticPage, syntheticPayload } from "../../outbound-sync/tests/order-pull-fixtures";
import type { ClaimedOperationReservation, ClaimedOrderPullOperation } from "../../outbound-sync/domain/contracts";
import { composeTcgplayerOrderInbound } from "../../tcgplayer-orders/domain/contracts";
import { browserPayloadDigest, type ConnectorExecutor } from "../domain/operation-protocol";
import type { OrderPullHandoff } from "../domain/order-pull-handoff";
import { coordinatorFixture } from "./coordinator-test-support";

export async function pullFixture() {
  const f = await coordinatorFixture();
  const payload = syntheticPayload({ connectionId: f.input.connectionId });
  const claim: ClaimedOperationReservation<ClaimedOrderPullOperation> = {
    ...f.claim,
    operations: [
      {
        operationId: "synthetic-pull-operation",
        attemptId: "synthetic-pull-attempt",
        claimGeneration: 1,
        connectionId: f.input.connectionId,
        providerIdentity: f.claim.providerIdentity,
        subject: { kind: "connection", connectionId: f.input.connectionId },
        operationKind: "tcgplayer-order-pull",
        pullId: payload.pullId,
        scheduleGeneration: 1,
        payload,
        payloadDigest: await browserPayloadDigest(payload),
        enqueuedAt: new Date(f.now()).toISOString(),
      },
    ],
  };
  f.claims[0] = claim;
  const sale = await composeTcgplayerOrderInbound({
    version: 1,
    kind: "order",
    pullId: payload.pullId,
    orderNumber: "SYNTHETIC-ORDER-1",
    soldAt: "2026-10-09T00:00:00.000Z",
    cancelled: false,
    lines: [{ productId: "1", skuId: "2", quantity: 1, unitPriceAmount: "1.00" }],
  });
  const summary = await composeTcgplayerOrderInbound({
    version: 1,
    kind: "summary",
    pullId: payload.pullId,
    totalOrders: 1,
    pages: [{ offset: 0, count: 1, totalOrders: 1 }],
    range: { from: "2026-10-09T00:00:00.000Z", to: "2026-10-09T00:01:00.000Z" },
    filter: "unshipped",
    completion: "unknown",
    unknownReason: "detail-missing",
  });
  const handoff: OrderPullHandoff = {
    authority: syntheticAuthority,
    progress: {
      previousDigest: payload.checkpointDigest,
      pages: [syntheticPage(["SYNTHETIC-ORDER-1"])],
      postedReferences: [],
      gaps: [],
      followUpTail: false,
    },
    bundles: [
      {
        reference: "SYNTHETIC-ORDER-1",
        source: "intake",
        posts: [
          { kind: "sale", externalReference: sale.externalReference, bytes: canonicalJson(sale), state: "planned" },
        ],
      },
    ],
    summary: {
      kind: "sale",
      externalReference: summary.externalReference,
      bytes: canonicalJson(summary),
      state: "planned",
    },
    usage: { providerCalls: 0, posts: 0, providerNotBefore: payload.providerNotBefore },
  };
  const posts: string[] = [];
  const post = vi.fn(async (bytes: string, _signal?: AbortSignal) => {
    posts.push(bytes);
    return new Response("{}", { status: 202 });
  });
  const dispatch = vi.fn<ConnectorExecutor["dispatchOnce"]>(async (_unit, _signal, pull) => {
    if (!pull) throw new Error("missing pull journal");
    await pull.save(handoff);
    await pull.sale("SYNTHETIC-ORDER-1", 0, post);
    await pull.sale(null, 0, post);
    return pull.result();
  });
  const executor: ConnectorExecutor = {
    ...f.executor,
    accepts: [["tcgplayer-order-pull", "order-pull"]],
    dispatchDeadlineMs: 600000,
    dispatchOnce: dispatch,
  };
  f.ports.executors = [executor];
  return { ...f, executor, claim, payload, handoff, post, posts, dispatch };
}
