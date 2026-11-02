import type { EventStoreContext } from "@chase-sets/event-core/storage";
import {
  createDurableJobProgressCheckpoint,
  runDurableJobSideEffect,
  type DurableJobExecutionContext,
} from "@chase-sets/platform-runtime/durable-job-store";
import { sumMoneyAmounts } from "@chase-sets/primitives/money";
import { createId } from "@chase-sets/primitives/typed-ids";
import type { AccountId, PayoutId } from "@chase-sets/primitives/typed-ids";
import {
  normalizeCurrencyCode,
  normalizeMoneyAmount,
  normalizeSignedMoneyAmount,
  SettlementDomainError,
  subtractMoney,
} from "../../../support/runtime-support/common";
import { createPayoutCompletedCsatOutcomeFact } from "./request-support/customer-feedback-outcome-fact";
import {
  getPayoutByProviderPayoutReference,
  listSettlementProviderOperationsForPayout,
  listSettlementProviderIdempotencyKeys,
  listSettlementReconciliationRuns,
  listPayoutsNeedingReconciliation,
  renewPayoutReconciliationWorkClaim,
  recordSettlementReconciliationRun,
  recordSettlementProviderIdempotencyKey,
  recordSettlementProviderOperationFailed,
  recordSettlementProviderOperationPending,
  recordSettlementProviderOperationSucceeded,
  type SettlementProviderOperationRow,
  type SettlementPayoutRow,
} from "../read-model/queries";
import {
  calculateCanonicalMoneyOrThrow,
  isPayoutReconciliationJobHandoff,
  isTerminalProviderFailure,
  payoutAmounts,
  payoutReconciliationJobProgress,
  providerErrorMessage,
  type PayoutPrimitives,
} from "./payout-primitives";
import type {
  PayoutReconciliationJobProgress,
  PayoutReconciliationJobResult,
  PayoutRuntimeDeps,
  PayoutServices,
} from "./runtime";

type PayoutReconciliationMember =
  | "reconcileProviderPayout"
  | "reconcilePayoutsNeedingAttention"
  | "listPayoutsNeedingReconciliation"
  | "listProviderIdempotencyKeys"
  | "listReconciliationRuns"
  | "listNegativeBalanceAccounts"
  | "getPlatformBalanceForecast";

/**
 * The reconciliation members of PayoutServices. The provider payout read also
 * takes the cancellation signal that durable reconciliation work passes
 * through; the public member type does not expose that option.
 */
export type PayoutReconciliation = Readonly<
  Omit<Pick<PayoutServices, PayoutReconciliationMember>, "reconcileProviderPayout"> & {
    reconcileProviderPayout: (
      params: Parameters<PayoutServices["reconcileProviderPayout"]>[0],
      context: EventStoreContext,
      options?: Readonly<{ signal?: AbortSignal }>,
    ) => ReturnType<PayoutServices["reconcileProviderPayout"]>;
  }
>;

function compactPayoutReconciliationJobResult(
  input: Readonly<{ checked: number; reconciled: number; ignored: number; skipped: number }>,
): PayoutReconciliationJobResult {
  return {
    ...input,
    errors: [],
  };
}

function createPayoutReconciliationProgressCheckpoint(
  jobContext: DurableJobExecutionContext<PayoutReconciliationJobProgress, PayoutReconciliationJobResult>,
) {
  return createDurableJobProgressCheckpoint(jobContext, {
    minIntervalMs: 1_000,
    minCompletedDelta: 10,
    minRenewIntervalMs: 5_000,
    completed: (progress) => progress.completed,
    isTerminal: (progress) => progress.phase === "completed" || progress.phase === "failed",
  });
}

/**
 * Provider-state reconciliation: converges payouts that need attention with
 * the provider (resubmitting a missing transfer or payout under its recorded
 * idempotency identity, then completing or failing it), records each run, and
 * serves the operator reconciliation and money-health reads.
 */
export function createPayoutReconciliation(
  deps: Pick<PayoutRuntimeDeps, "db" | "wallets" | "payoutReadiness" | "moneyMovementGateway">,
  primitives: Pick<
    PayoutPrimitives,
    "commandHandler" | "recordOperation" | "recordPayoutProviderReferences" | "failPayoutAndReverseWallet"
  >,
): PayoutReconciliation {
  const { commandHandler, recordOperation, recordPayoutProviderReferences, failPayoutAndReverseWallet } = primitives;

  async function reconcileProviderPayout(
    params: Readonly<{ providerPayoutReference: string }>,
    context: EventStoreContext,
    options: Readonly<{ signal?: AbortSignal }> = {},
  ) {
    const payout = await getPayoutByProviderPayoutReference(deps.db, params.providerPayoutReference);
    if (!payout) {
      await recordOperation({
        kind: "money-movement-webhook-ignored",
        providerPayoutReference: params.providerPayoutReference,
        reason: "Payout not found during reconciliation.",
      });
      return { received: true, ignored: true };
    }

    const readiness = await deps.payoutReadiness.getPayoutReadiness(payout.account_id);
    if (!readiness.provider_reference) {
      throw new SettlementDomainError("Payout setup must include a provider account for reconciliation.");
    }

    const providerPayout = await deps.moneyMovementGateway.retrieveConnectedAccountPayout(
      {
        providerReference: readiness.provider_reference,
        providerPayoutReference: params.providerPayoutReference,
      },
      options,
    );

    if (["paid", "succeeded", "completed"].includes(providerPayout.providerStatus)) {
      if (payout.status === "failed") {
        await recordOperation({
          kind: "money-movement-webhook-ignored",
          accountId: payout.account_id,
          payoutId: payout.payout_id,
          providerPayoutReference: params.providerPayoutReference,
          reason: "Provider reports paid for a locally failed payout; operator review is required.",
        });
        return { received: true, ignored: true };
      }
      const completedAt = new Date().toISOString();
      const result = await commandHandler({
        streamId: `settlement.payout-${payout.payout_id}`,
        command: {
          type: "CompletePayout",
          providerStatus: providerPayout.providerStatus,
          completedAt,
          csatOutcomeFact: createPayoutCompletedCsatOutcomeFact({
            accountId: payout.account_id,
            payoutId: payout.payout_id,
            completedAt,
          }),
        },
        context,
      });
      if (result.newEvents.length > 0) {
        await recordOperation({
          kind: "payout-completed",
          accountId: payout.account_id,
          payoutId: payout.payout_id,
          providerPayoutReference: params.providerPayoutReference,
        });
      }
      return { received: true, ignored: result.newEvents.length === 0 };
    }

    if (["failed", "canceled", "cancelled"].includes(providerPayout.providerStatus)) {
      const failedAmounts = payoutAmounts(payout);
      await failPayoutAndReverseWallet(
        {
          payoutId: payout.payout_id,
          accountId: payout.account_id,
          failureReason: providerPayout.failureMessage,
          providerStatus: providerPayout.providerStatus,
          providerFailureCode: providerPayout.failureCode,
          providerFailureMessage: providerPayout.failureMessage,
          netAmount: failedAmounts.netAmount,
          feeAmount: failedAmounts.feeAmount,
          currencyCode: payout.currency_code,
        },
        context,
      );
      await recordOperation({
        kind: "payout-failed",
        accountId: payout.account_id,
        payoutId: payout.payout_id,
        providerPayoutReference: params.providerPayoutReference,
        reason: providerPayout.failureMessage,
      });
      return { received: true, ignored: false };
    }

    return { received: true, ignored: true };
  }

  function providerOperationByKind(
    operations: readonly SettlementProviderOperationRow[],
    operationKind: string,
  ): SettlementProviderOperationRow | null {
    return operations.find((operation) => operation.operation_kind === operationKind) ?? null;
  }

  function providerOperationRequest(
    operation: SettlementProviderOperationRow | null,
    payout: SettlementPayoutRow,
    providerReference: string,
  ) {
    const request = operation?.request_json && typeof operation.request_json === "object" ? operation.request_json : {};
    const values = request as Record<string, unknown>;
    const amounts = payoutAmounts(payout);
    return {
      payoutId: typeof values.payoutId === "string" ? values.payoutId : payout.payout_id,
      accountId: typeof values.accountId === "string" ? values.accountId : payout.account_id,
      providerReference: typeof values.providerReference === "string" ? values.providerReference : providerReference,
      amount: typeof values.amount === "string" ? values.amount : amounts.netAmount,
      currencyCode: normalizeCurrencyCode(
        typeof values.currencyCode === "string" ? values.currencyCode : payout.currency_code,
      ),
    };
  }

  async function reconcilePayoutProviderState(
    payout: SettlementPayoutRow,
    context: EventStoreContext,
  ): Promise<{ received: boolean; ignored: boolean }> {
    const readiness = await deps.payoutReadiness.getPayoutReadiness(payout.account_id);
    if (!readiness.provider_reference) {
      throw new SettlementDomainError("Payout setup must include a provider account for reconciliation.");
    }

    const operations = await listSettlementProviderOperationsForPayout(deps.db, payout.payout_id);
    const transferOperation = providerOperationByKind(operations, "platform-transfer-create");
    const payoutOperation = providerOperationByKind(operations, "connected-account-payout-create");
    let providerTransferReference =
      payout.provider_transfer_reference ?? transferOperation?.provider_object_reference ?? null;

    if (!providerTransferReference) {
      const transferOperationKey = transferOperation?.operation_key ?? `payout:${payout.payout_id}:transfer`;
      const transferIdempotencyKey =
        transferOperation?.idempotency_key ?? `settlement:payout:${payout.payout_id}:transfer`;
      const request = providerOperationRequest(transferOperation, payout, readiness.provider_reference);
      await recordSettlementProviderOperationPending(deps.db, {
        operationKey: transferOperationKey,
        providerName: deps.moneyMovementGateway.providerName,
        operationKind: "platform-transfer-create",
        accountId: request.accountId,
        payoutId: request.payoutId,
        idempotencyKey: transferIdempotencyKey,
        request,
      });
      try {
        const transfer = await deps.moneyMovementGateway.transferPlatformBalanceToConnectedAccount({
          payoutId: request.payoutId as PayoutId,
          accountId: request.accountId as AccountId,
          providerReference: request.providerReference,
          amount: request.amount,
          currencyCode: request.currencyCode,
          idempotencyKey: transferIdempotencyKey,
        });
        providerTransferReference = transfer.providerTransferReference;
        await recordSettlementProviderOperationSucceeded(deps.db, {
          operationKey: transferOperationKey,
          providerObjectReference: transfer.providerTransferReference,
        });
        await recordSettlementProviderIdempotencyKey(deps.db, {
          operationKey: transferOperationKey,
          providerName: deps.moneyMovementGateway.providerName,
          operationKind: "platform-transfer-create",
          accountId: request.accountId,
          payoutId: request.payoutId,
          providerObjectReference: transfer.providerTransferReference,
          idempotencyKey: transferIdempotencyKey,
          createdAt: new Date().toISOString(),
        });
        await recordPayoutProviderReferences(
          {
            payoutId: payout.payout_id,
            providerTransferReference: transfer.providerTransferReference,
          },
          context,
        );
      } catch (error) {
        const providerFailureMessage = providerErrorMessage(error, "Provider transfer reconciliation failed.");
        await recordSettlementProviderOperationFailed(deps.db, {
          operationKey: transferOperationKey,
          errorMessage: providerFailureMessage,
        });
        if (isTerminalProviderFailure(error)) {
          const failedAmounts = payoutAmounts(payout);
          await failPayoutAndReverseWallet(
            {
              payoutId: payout.payout_id,
              accountId: payout.account_id,
              failureReason: "Payout account details need review.",
              providerStatus: "failed",
              providerFailureMessage,
              failedAt: new Date().toISOString(),
              netAmount: failedAmounts.netAmount,
              feeAmount: failedAmounts.feeAmount,
              currencyCode: payout.currency_code,
            },
            context,
          );
          return { received: true, ignored: false };
        }
        return { received: true, ignored: true };
      }
    } else if (!payout.provider_transfer_reference) {
      await recordPayoutProviderReferences(
        {
          payoutId: payout.payout_id,
          providerTransferReference,
        },
        context,
      );
    }

    const providerPayoutReference =
      payout.provider_payout_reference ?? payoutOperation?.provider_object_reference ?? null;
    if (providerPayoutReference) {
      if (!payout.provider_payout_reference) {
        await recordPayoutProviderReferences(
          {
            payoutId: payout.payout_id,
            providerTransferReference,
            providerPayoutReference,
          },
          context,
        );
      }
      return reconcileProviderPayout({ providerPayoutReference }, context);
    }

    const payoutOperationKey = payoutOperation?.operation_key ?? `payout:${payout.payout_id}:payout`;
    const payoutIdempotencyKey = payoutOperation?.idempotency_key ?? `settlement:payout:${payout.payout_id}:payout`;
    const request = providerOperationRequest(payoutOperation, payout, readiness.provider_reference);
    await recordSettlementProviderOperationPending(deps.db, {
      operationKey: payoutOperationKey,
      providerName: deps.moneyMovementGateway.providerName,
      operationKind: "connected-account-payout-create",
      accountId: request.accountId,
      payoutId: request.payoutId,
      idempotencyKey: payoutIdempotencyKey,
      request,
    });

    try {
      const providerPayout = await deps.moneyMovementGateway.createConnectedAccountPayout({
        payoutId: request.payoutId as PayoutId,
        accountId: request.accountId as AccountId,
        providerReference: request.providerReference,
        amount: request.amount,
        currencyCode: request.currencyCode,
        idempotencyKey: payoutIdempotencyKey,
      });
      await recordSettlementProviderOperationSucceeded(deps.db, {
        operationKey: payoutOperationKey,
        providerObjectReference: providerPayout.providerPayoutReference,
      });
      await recordSettlementProviderIdempotencyKey(deps.db, {
        operationKey: payoutOperationKey,
        providerName: deps.moneyMovementGateway.providerName,
        operationKind: "connected-account-payout-create",
        accountId: request.accountId,
        payoutId: request.payoutId,
        providerObjectReference: providerPayout.providerPayoutReference,
        idempotencyKey: payoutIdempotencyKey,
        createdAt: new Date().toISOString(),
      });
      await recordPayoutProviderReferences(
        {
          payoutId: payout.payout_id,
          providerTransferReference,
          providerPayoutReference: providerPayout.providerPayoutReference,
          providerStatus: providerPayout.providerStatus,
        },
        context,
      );

      if (["paid", "succeeded", "completed"].includes(providerPayout.providerStatus)) {
        const completedAt = new Date().toISOString();
        const result = await commandHandler({
          streamId: `settlement.payout-${payout.payout_id}`,
          command: {
            type: "CompletePayout",
            providerStatus: providerPayout.providerStatus,
            completedAt,
            csatOutcomeFact: createPayoutCompletedCsatOutcomeFact({
              accountId: payout.account_id,
              payoutId: payout.payout_id,
              completedAt,
            }),
          },
          context,
        });
        return { received: true, ignored: result.newEvents.length === 0 };
      }

      const result = await commandHandler({
        streamId: `settlement.payout-${payout.payout_id}`,
        command: {
          type: "MarkPayoutInTransit",
          providerTransferReference,
          providerPayoutReference: providerPayout.providerPayoutReference,
          providerStatus: providerPayout.providerStatus,
          sentAt: new Date().toISOString(),
        },
        context,
      });
      return { received: true, ignored: result.newEvents.length === 0 };
    } catch (error) {
      await recordSettlementProviderOperationFailed(deps.db, {
        operationKey: payoutOperationKey,
        errorMessage: providerErrorMessage(error, "Provider payout reconciliation failed."),
      });
      return { received: true, ignored: true };
    }
  }

  const reconcilePayoutsNeedingAttention: PayoutServices["reconcilePayoutsNeedingAttention"] = async (
    params,
    context,
    jobContext,
  ) => {
    const startedAt = new Date().toISOString();
    const payouts = await listPayoutsNeedingReconciliation(deps.db, {
      accountId: params.accountId,
      limit: params.limit,
      claimOwnerId: params.claimOwnerId,
      claimTtlMs: params.claimTtlMs,
    });
    const progressCheckpoint = jobContext ? createPayoutReconciliationProgressCheckpoint(jobContext) : null;
    let reconciled = 0;
    let ignored = 0;
    let skipped = 0;
    const errors: Array<Readonly<{ payoutId: string; message: string }>> = [];
    let completed = 0;

    for (const payout of payouts) {
      jobContext?.throwIfCancelled();
      if (params.claimOwnerId && params.claimTtlMs) {
        const claimRenewed = await renewPayoutReconciliationWorkClaim(deps.db, {
          payoutId: payout.payout_id,
          claimOwnerId: params.claimOwnerId,
          claimTtlMs: params.claimTtlMs,
        });
        if (!claimRenewed) {
          throw new SettlementDomainError("Payout reconciliation work claim was lost before processing completed.");
        }
      }

      try {
        const providerPayoutReference = payout.provider_payout_reference;
        const result = await runDurableJobSideEffect(
          jobContext,
          (signal) =>
            providerPayoutReference
              ? reconcileProviderPayout({ providerPayoutReference }, context, { signal })
              : reconcilePayoutProviderState(payout, context),
          {
            renewIntervalMs: 5_000,
            claimLostMessage: "Payout reconciliation job claim was lost while reconciling a payout.",
          },
        );
        if (result.ignored) {
          ignored += 1;
        } else {
          reconciled += 1;
        }
      } catch (error) {
        if (isPayoutReconciliationJobHandoff(error, jobContext)) {
          throw error;
        }

        errors.push({
          payoutId: payout.payout_id,
          message: error instanceof Error ? error.message : "Reconciliation failed.",
        });
      }
      completed += 1;
      await progressCheckpoint?.checkpoint(
        payoutReconciliationJobProgress("processing", completed, payouts.length, "Reconciled payout."),
        compactPayoutReconciliationJobResult({ checked: completed, reconciled, ignored, skipped }),
      );
    }

    const result = {
      checked: payouts.length,
      reconciled,
      ignored,
      skipped,
      errors,
    };
    await recordSettlementReconciliationRun(deps.db, {
      reconciliationRunId: createId("rec"),
      kind: "payouts",
      checked: result.checked,
      reconciled: result.reconciled,
      ignored: result.ignored,
      skipped: result.skipped,
      errorCount: result.errors.length,
      status: result.errors.length > 0 ? "completed-with-errors" : "completed",
      summary: result,
      startedAt,
      completedAt: new Date().toISOString(),
    });

    return result;
  };

  return {
    reconcileProviderPayout,
    reconcilePayoutsNeedingAttention,
    listPayoutsNeedingReconciliation: (params) => listPayoutsNeedingReconciliation(deps.db, params),
    listProviderIdempotencyKeys: (params) => listSettlementProviderIdempotencyKeys(deps.db, params),
    listReconciliationRuns: (params) => listSettlementReconciliationRuns(deps.db, params),
    listNegativeBalanceAccounts: (params = {}) => deps.wallets.listNegativeBalanceAccounts(params),
    async getPlatformBalanceForecast(params) {
      const currencyCode = normalizeCurrencyCode(params?.currencyCode ?? "usd");
      const [platformBalance, payouts] = await Promise.all([
        deps.moneyMovementGateway.retrievePlatformBalance({ currencyCode }),
        listPayoutsNeedingReconciliation(deps.db, {
          limit: 500,
          filter: "in-transit",
        }),
      ]);
      const platformAvailableAmount = normalizeSignedMoneyAmount(
        platformBalance.availableAmount,
        "Platform available amount",
      );
      const pendingAmounts = payouts
        .filter((payout) => payout.currency_code === currencyCode)
        .map((payout) =>
          normalizeMoneyAmount(payoutAmounts(payout).netAmount, {
            allowZero: true,
            fieldName: "In-transit payout amount",
          }),
        );
      const pendingDemand = calculateCanonicalMoneyOrThrow(
        "Pending payout demand amount must be a valid decimal.",
        () => sumMoneyAmounts(pendingAmounts),
      );
      const forecastAfterPendingDemand = calculateCanonicalMoneyOrThrow(
        "Platform balance forecast must be a valid signed decimal.",
        () => subtractMoney(platformAvailableAmount, pendingDemand),
      );

      return {
        currency_code: currencyCode,
        available_amount: platformAvailableAmount,
        pending_payout_demand_amount: pendingDemand,
        forecast_after_pending_demand_amount: forecastAfterPendingDemand,
      };
    },
  };
}
