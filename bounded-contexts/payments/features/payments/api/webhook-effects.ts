import type { EventStore } from "@chase-sets/event-core/event-store";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { PaymentProcessorGateway } from "@chase-sets/payment-processing";
import { createId } from "@chase-sets/primitives/typed-ids";
import { refundAggregate } from "../../refunds/api/runtime";
import {
  listPaymentProviderOperationsNeedingReconciliation,
  recordPaymentProviderOperationFailed,
  recordPaymentProviderOperationSucceeded,
  type PaymentProviderOperationRow,
} from "../read-model/queries";

const refundKeyPrefix = "payments:refund:";
export const fraudRefundOperationKey = (refundId: string) => `${refundKeyPrefix}${refundId}`;
export const revokedGrantDetachOperationKey = (providerReference: string) =>
  `payments:revoked-grant-detach:${providerReference}`;

type EffectDeps = Readonly<{ db: PgQueryable; eventStore: EventStore; processorGateway: PaymentProcessorGateway }>;

export async function submitWebhookProviderOperation(deps: EffectDeps, operation: PaymentProviderOperationRow) {
  const target = operation.provider_object_reference;
  if (!target) throw new Error("Webhook provider operation is missing its target reference.");

  let providerObjectReference: string;
  if (operation.operation_kind === "revoked-grant-detach") {
    const current = await deps.processorGateway.retrieveSavedPaymentMethod(target);
    if (!current) throw new Error("Could not confirm the revoked payment method's state.");
    if (!current.removed) {
      await deps.processorGateway.detachSavedPaymentMethod(target, operation.idempotency_key);
    }
    providerObjectReference = target;
  } else if (operation.operation_kind === "early-fraud-refund") {
    const refundId = operation.operation_key.slice(refundKeyPrefix.length);
    const { state } = await refundAggregate(deps.eventStore).repository.load(`payments.refund-${refundId}`);
    if (state.refundId !== refundId || state.paymentId !== operation.payment_id) {
      throw new Error("Webhook refund operation does not match its reserved refund.");
    }
    if (state.status === "issued" && state.processorRefundReference) {
      providerObjectReference = state.processorRefundReference;
    } else {
      if (state.status !== "requested" || !state.paymentId || !state.amount || !state.currencyCode || !state.reason) {
        throw new Error("Webhook refund operation has no request to submit.");
      }
      // An unknown send may have succeeded. Do not resend beyond the provider's minimum key lifetime.
      const age = Date.now() - new Date(operation.created_at).getTime();
      if (!(age < 23 * 60 * 60 * 1000)) {
        const reason = "Refund submission is unresolved beyond the safe provider retry window.";
        await recordPaymentProviderOperationFailed(deps.db, {
          operationKey: operation.operation_key,
          errorMessage: reason,
        });
        return reason;
      }
      const result = await deps.processorGateway.createRefund({
        refundId,
        paymentId: state.paymentId,
        orderIds: state.orderIds,
        processorPaymentReference: target,
        amount: state.amount,
        currencyCode: state.currencyCode,
        reason: state.reason,
        idempotencyKey: operation.idempotency_key,
      });
      providerObjectReference = result.processorRefundReference;
    }
  } else {
    throw new Error("Unsupported webhook provider operation.");
  }
  await recordPaymentProviderOperationSucceeded(deps.db, {
    operationKey: operation.operation_key,
    providerObjectReference,
  });
  return null;
}

export async function tryWebhookProviderOperation(deps: EffectDeps, key: string) {
  const [operation] = await listPaymentProviderOperationsNeedingReconciliation(deps.db, {
    limit: 1,
    claimOwnerId: createId("claim"),
    webhookOperationKey: key,
  });
  if (operation) {
    try {
      await submitWebhookProviderOperation(deps, operation);
    } catch {
      // The durable pending operation is retried by Payment reconciliation after the claim expires.
    }
  }
}
