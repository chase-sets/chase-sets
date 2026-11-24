import type { EventStoreContext } from "@chase-sets/event-core/storage";

export type OrderPaymentDeadlineReconciler = (
  order: Readonly<{ orderId: string; buyerAccountId: string; paymentId?: string }>,
  context: EventStoreContext,
) => Promise<"captured" | "not-captured">;
