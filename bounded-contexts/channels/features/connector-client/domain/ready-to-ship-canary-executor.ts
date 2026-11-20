import { canonicalJson } from "../../listing-composition/domain/canonical-json";
import { canaryAuthority } from "../../outbound-sync/domain/ready-to-ship-canary";
import { canaryDispatchDeadlineMs } from "../../outbound-sync/domain/order-pull-codec";
import { composeTcgplayerOrderInbound } from "../../tcgplayer-orders/domain/contracts";
import type { OrderPullHandoff } from "./order-pull-handoff";
import type { OrderPullExecution } from "./order-pull-execution";
import { refuse, type ConnectorExecutor, type OperationUnit } from "./operation-protocol";

function member(unit: OperationUnit) {
  const member = unit.members[0];
  if (unit.members.length !== 1 || member?.operationKind !== "tcgplayer-order-pull" || !member.payload.canary) refuse();
  return { payload: member.payload, canary: member.payload.canary };
}

async function postSaved(execution: OrderPullExecution) {
  const handoff = execution.snapshot();
  if (!handoff) return execution.result("admission-ambiguous");
  for (const bundle of handoff.bundles) await execution.sale(bundle.reference, 0);
  return execution.result();
}

export function createReadyToShipCanaryExecutor(): ConnectorExecutor {
  return {
    key: "ready-to-ship-canary",
    readyToShipCanary: true,
    accepts: [["tcgplayer-order-pull", "order-pull"]],
    unit: "operation",
    dispatchDeadlineMs: canaryDispatchDeadlineMs,
    async prepare(unit) {
      member(unit);
      return { ready: true };
    },
    async dispatchOnce(unit, _signal, execution) {
      if (!execution) refuse();
      const { payload, canary } = member(unit);
      const bundles = await Promise.all(
        canary.sales.map(async (sale) => {
          const envelope = await composeTcgplayerOrderInbound(sale);
          return {
            reference: sale.orderNumber,
            source: "intake",
            posts: [
              {
                kind: "sale",
                state: "planned",
                externalReference: envelope.externalReference,
                bytes: canonicalJson(envelope),
              },
            ],
          } as const;
        }),
      );
      const handoff: OrderPullHandoff = {
        authority: canaryAuthority,
        progress: {
          previousDigest: payload.checkpointDigest,
          pages: [],
          postedReferences: [],
          gaps: [],
          followUpTail: false,
        },
        bundles,
        summary: null,
        usage: { providerCalls: 0, posts: 0, providerNotBefore: payload.providerNotBefore },
      };
      await execution.save(handoff);
      return postSaved(execution);
    },
    async reconcileAmbiguous(unit, execution) {
      if (!execution) refuse();
      member(unit);
      return postSaved(execution);
    },
  };
}
