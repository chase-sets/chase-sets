import type { EventStoreContext } from "@chase-sets/event-core/storage";
import {
  hasProcessedProviderWebhookEvent as hasProcessedProviderWebhookInboxEvent,
  recordProviderWebhookEvent as recordProviderWebhookInboxEvent,
} from "@chase-sets/provider-webhook-inbox";
import type { PayoutId } from "@chase-sets/primitives/typed-ids";
import { SettlementDomainError } from "../../../support/runtime-support/common";
import type { MoneyMovementWebhookEvent } from "@chase-sets/money-movement";
import { providerWebhookErrorFromUnknown, type ProviderWebhookTelemetryEvent } from "@chase-sets/http/provider-errors";
import { createPayoutCompletedCsatOutcomeFact } from "./request-support/customer-feedback-outcome-fact";
import { getPayoutByProviderOperationReference, getPayoutByProviderPayoutReference } from "../read-model/queries";
import { payoutAmounts, requirePayoutSnapshot, type PayoutPrimitives } from "./payout-primitives";
import type { PayoutRuntimeDeps, PayoutServices } from "./runtime";

function providerObjectReferenceFromEvent(event: MoneyMovementWebhookEvent) {
  if (event.kind === "payout-readiness-updated") {
    return event.providerReference;
  }
  return event.kind === "payout-completed" || event.kind === "payout-failed" ? event.providerPayoutReference : null;
}

/**
 * Money-movement provider events: signed webhook parsing, inbox
 * deduplication, payout completion/failure and readiness updates, the
 * acknowledgement telemetry, and the provider adapter health it reports.
 */
export function createPayoutProviderEvents(
  deps: Pick<PayoutRuntimeDeps, "db" | "payoutReadiness" | "moneyMovementGateway" | "webhookTelemetry">,
  primitives: Pick<
    PayoutPrimitives,
    | "commandHandler"
    | "repository"
    | "recordOperation"
    | "recordPayoutProviderReferences"
    | "failPayoutAndReverseWallet"
  >,
): Pick<PayoutServices, "getProviderHealth" | "processMoneyMovementWebhook"> {
  const { commandHandler, repository, recordOperation, recordPayoutProviderReferences, failPayoutAndReverseWallet } =
    primitives;
  const webhookTelemetry = deps.webhookTelemetry ?? { record: (_event: ProviderWebhookTelemetryEvent) => undefined };
  const recordWebhookTelemetry = (event: ProviderWebhookTelemetryEvent) => {
    try {
      webhookTelemetry.record(event);
    } catch {
      // Telemetry must never change webhook acknowledgement or retry behavior.
    }
  };

  async function getCommittedPayout(payoutId: PayoutId | null) {
    if (!payoutId) {
      return null;
    }
    const loaded = await repository.load(`settlement.payout-${payoutId}`);
    return loaded.state.payoutId ? requirePayoutSnapshot(loaded.state, loaded.version) : null;
  }

  async function recordProviderWebhookEvent(event: MoneyMovementWebhookEvent) {
    return recordProviderWebhookInboxEvent(deps.db, {
      tableName: "settlement_money_movement_webhook_events",
      providerEventId: event.providerEventId,
      providerName: deps.moneyMovementGateway.providerName,
      eventKind: event.kind,
      providerObjectReference: providerObjectReferenceFromEvent(event),
    });
  }

  async function hasProcessedProviderWebhookEvent(event: MoneyMovementWebhookEvent) {
    return hasProcessedProviderWebhookInboxEvent(deps.db, {
      tableName: "settlement_money_movement_webhook_events",
      providerEventId: event.providerEventId,
    });
  }

  async function handleMoneyMovementEvent(event: MoneyMovementWebhookEvent, context: EventStoreContext) {
    switch (event.kind) {
      case "payout-completed": {
        const payout =
          (await getPayoutByProviderPayoutReference(deps.db, event.providerPayoutReference)) ??
          (await getPayoutByProviderOperationReference(deps.db, event.providerPayoutReference)) ??
          (await getCommittedPayout(event.payoutId));
        if (!payout) {
          await recordOperation({
            kind: "money-movement-webhook-ignored",
            providerEventId: event.providerEventId,
            providerPayoutReference: event.providerPayoutReference,
            reason: "Payout not found for provider payout reference.",
          });
          throw new SettlementDomainError("Payout was not found for provider webhook.");
        }
        if (payout.status === "failed") {
          await recordOperation({
            kind: "money-movement-webhook-ignored",
            providerEventId: event.providerEventId,
            accountId: payout.account_id,
            payoutId: payout.payout_id,
            providerPayoutReference: event.providerPayoutReference,
            reason: "Provider reports paid for a locally failed payout; operator review is required.",
            occurredAt: event.occurredAt,
          });
          return { received: true, ignored: true };
        }
        if (!payout.provider_payout_reference) {
          await recordPayoutProviderReferences(
            {
              payoutId: payout.payout_id,
              providerPayoutReference: event.providerPayoutReference,
              providerStatus: event.providerStatus,
              recordedAt: event.occurredAt,
            },
            context,
          );
        }
        const result = await commandHandler({
          streamId: `settlement.payout-${payout.payout_id}`,
          command: {
            type: "CompletePayout",
            providerStatus: event.providerStatus,
            completedAt: event.occurredAt,
            csatOutcomeFact: createPayoutCompletedCsatOutcomeFact({
              accountId: payout.account_id,
              payoutId: payout.payout_id,
              completedAt: event.occurredAt,
            }),
          },
          context,
        });
        if (result.newEvents.length > 0) {
          await recordOperation({
            kind: "payout-completed",
            providerEventId: event.providerEventId,
            accountId: payout.account_id,
            payoutId: payout.payout_id,
            providerPayoutReference: event.providerPayoutReference,
            occurredAt: event.occurredAt,
          });
        }
        return { received: true, ignored: result.newEvents.length === 0 };
      }
      case "payout-failed": {
        const payout =
          (await getPayoutByProviderPayoutReference(deps.db, event.providerPayoutReference)) ??
          (await getPayoutByProviderOperationReference(deps.db, event.providerPayoutReference)) ??
          (await getCommittedPayout(event.payoutId));
        if (!payout) {
          await recordOperation({
            kind: "money-movement-webhook-ignored",
            providerEventId: event.providerEventId,
            providerPayoutReference: event.providerPayoutReference,
            reason: "Payout not found for provider payout reference.",
          });
          throw new SettlementDomainError("Payout was not found for provider webhook.");
        }
        if (!payout.provider_payout_reference && payout.status !== "failed") {
          await recordPayoutProviderReferences(
            {
              payoutId: payout.payout_id,
              providerPayoutReference: event.providerPayoutReference,
              providerStatus: event.providerStatus,
              recordedAt: event.occurredAt,
            },
            context,
          );
        }
        const failedAmounts = payoutAmounts(payout);
        await failPayoutAndReverseWallet(
          {
            payoutId: payout.payout_id,
            accountId: payout.account_id,
            failureReason: event.failureMessage,
            providerStatus: event.providerStatus,
            providerFailureCode: event.failureCode,
            providerFailureMessage: event.failureMessage,
            failedAt: event.occurredAt,
            netAmount: failedAmounts.netAmount,
            feeAmount: failedAmounts.feeAmount,
            currencyCode: payout.currency_code,
          },
          context,
        );
        await recordOperation({
          kind: "payout-failed",
          providerEventId: event.providerEventId,
          accountId: payout.account_id,
          payoutId: payout.payout_id,
          providerPayoutReference: event.providerPayoutReference,
          reason: event.failureMessage,
          occurredAt: event.occurredAt,
        });
        return { received: true, ignored: false };
      }
      case "payout-readiness-updated":
        if (
          !(await deps.payoutReadiness.recordProviderReadinessFromWebhook(
            {
              providerReference: event.providerReference,
              readiness: event.readiness,
              recordedAt: event.occurredAt,
            },
            context,
          ))
        ) {
          throw new SettlementDomainError("Payout readiness target is not ready for provider webhook processing.");
        }
        return { received: true, ignored: false };
    }
  }

  return {
    async getProviderHealth() {
      await recordOperation({
        kind: "provider-health-checked",
      });
      return {
        provider_name: deps.moneyMovementGateway.providerName,
        adapter_mode: deps.moneyMovementGateway.providerName === "fake" ? "fake" : "provider",
        webhook_signature_required: deps.moneyMovementGateway.providerName !== "fake",
        webhook_failure_classes: [
          "signature-invalid",
          "unknown-event",
          "schema-mismatch",
          "handler-failure",
          "inbox-conflict",
        ],
        platform_balance_supported: true,
        connected_account_payouts_supported: true,
      };
    },
    async processMoneyMovementWebhook(params, context) {
      let event: MoneyMovementWebhookEvent | null;
      try {
        event = await deps.moneyMovementGateway.parseMoneyMovementWebhook(params);
      } catch (error) {
        const classified = providerWebhookErrorFromUnknown(error);
        recordWebhookTelemetry({
          endpoint: "settlement",
          failureClass: classified.failureClass,
          outcome: classified.retryable ? "failed" : "ignored",
          statusCode: classified.retryable ? 400 : 200,
          retryable: classified.retryable,
          providerEventId: classified.providerEventId,
          eventKind: classified.eventKind,
        });
        throw classified;
      }
      if (!event) {
        await recordOperation({
          kind: "money-movement-webhook-ignored",
          reason: "Provider webhook event was unsupported.",
        });
        recordWebhookTelemetry({
          endpoint: "settlement",
          failureClass: "unknown-event",
          outcome: "ignored",
          statusCode: 200,
          retryable: false,
        });
        return { received: true, ignored: true };
      }
      const alreadyProcessed = await hasProcessedProviderWebhookEvent(event);
      if (alreadyProcessed) {
        await recordOperation({
          kind: "money-movement-webhook-ignored",
          providerEventId: event.providerEventId,
          providerPayoutReference: providerObjectReferenceFromEvent(event) ?? undefined,
          reason: "Provider webhook event was already processed.",
        });
        recordWebhookTelemetry({
          endpoint: "settlement",
          failureClass: "inbox-conflict",
          outcome: "ignored",
          statusCode: 200,
          retryable: false,
          providerEventId: event.providerEventId,
          eventKind: event.kind,
        });
        return { received: true, ignored: true, failure_class: "inbox-conflict" as const };
      }
      try {
        const result = await handleMoneyMovementEvent(event, context);
        const recorded = await recordProviderWebhookEvent(event);
        if (!recorded) {
          recordWebhookTelemetry({
            endpoint: "settlement",
            failureClass: "inbox-conflict",
            outcome: "ignored",
            statusCode: 200,
            retryable: false,
            providerEventId: event.providerEventId,
            eventKind: event.kind,
          });
          return { received: true, ignored: true, failure_class: "inbox-conflict" as const };
        }
        recordWebhookTelemetry({
          endpoint: "settlement",
          failureClass: null,
          outcome: "processed",
          statusCode: 200,
          retryable: false,
          providerEventId: event.providerEventId,
          eventKind: event.kind,
        });
        return result;
      } catch (error) {
        const classified = providerWebhookErrorFromUnknown(error, {
          providerEventId: event.providerEventId,
          eventKind: event.kind,
        });
        if (classified.failureClass !== "inbox-conflict") {
          recordWebhookTelemetry({
            endpoint: "settlement",
            failureClass: "handler-failure",
            outcome: "failed",
            statusCode: 400,
            retryable: true,
            providerEventId: event.providerEventId,
            eventKind: event.kind,
          });
        }
        throw classified;
      }
    },
  };
}
