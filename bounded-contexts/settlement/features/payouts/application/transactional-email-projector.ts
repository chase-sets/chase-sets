import type { TransactionalEmailGateway } from "@chase-sets/communications-email";
import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { TransportEvent } from "@chase-sets/event-core/transport";
import { mapPayoutCompletedToTransactionalEmail } from "./transactional-email-intents";

export type SettlementPayoutCompletedEmailEvent = Readonly<
  TransportEvent & {
    type: "settlement.payout.completed";
    data: Readonly<{
      notificationEmail: string | null;
      payoutId: string;
      amount: string;
    }>;
  }
>;

function correlationIdFromEvent(event: TransportEvent) {
  return event.trace.traceId ?? event.id;
}

export async function projectSettlementPayoutEventToTransactionalEmail(
  gateway: TransactionalEmailGateway,
  event: TransportEvent,
) {
  if (event.type !== "settlement.payout.completed") return;
  const data = event.data as SettlementPayoutCompletedEmailEvent["data"];
  const sellerEmail = data.notificationEmail?.trim();
  if (!sellerEmail) return;

  await gateway.sendTransactionalEmail(
    mapPayoutCompletedToTransactionalEmail({
      sellerEmail,
      payoutId: data.payoutId,
      amount: data.amount,
      correlationId: correlationIdFromEvent(event),
    }),
  );
}

export function buildSettlementPayoutTransactionalEmailProjectionHandlers(
  gateway: TransactionalEmailGateway,
): ProjectorHandlerMap {
  return {
    "settlement.payout.completed": (event) =>
      projectSettlementPayoutEventToTransactionalEmail(gateway, event),
  };
}
