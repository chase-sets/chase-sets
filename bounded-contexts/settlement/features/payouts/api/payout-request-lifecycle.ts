import { recordCommittedEvents } from "@chase-sets/event-core/consistency";
import { applyEvents } from "@chase-sets/event-core/domain";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { deriveDisplayReferenceOrRaw } from "@chase-sets/primitives/display-reference";
import { sumMoneyAmounts } from "@chase-sets/primitives/money";
import { createId } from "@chase-sets/primitives/typed-ids";
import type { AccountId, PayoutId } from "@chase-sets/primitives/typed-ids";
import {
  compareMoney,
  normalizeCurrencyCode,
  normalizeMoneyAmount,
  normalizeSignedMoneyAmount,
  SettlementDomainError,
  subtractMoney,
} from "../../../support/runtime-support/common";
import { moneyStatusDetails } from "@chase-sets/http/money-status";
import {
  assertPayoutAmountWithinPolicy,
  capPayoutAmountToPolicy,
  payoutFeeAmount,
  payoutAmountPolicy,
  quotePayoutFee,
  resolvePayoutAmountSelection,
  settlementPayoutBoundsPolicy,
  settlementPayoutFeePolicy,
  SETTLEMENT_PAYOUT_FEE_LAUNCH_POLICY_VALUE,
  type SettlementPayoutBoundsPolicyValue,
  type SettlementPayoutFeePolicyValue,
} from "../domain/payout-policy";
import { createPayoutCompletedCsatOutcomeFact } from "./request-support/customer-feedback-outcome-fact";
import {
  getPayout,
  findPayoutRequestIdempotency,
  releaseUncommittedPayoutRequestIdempotency,
  reservePayoutRequestIdempotency,
  getAccountPayoutRiskSummary,
  listSettlementProviderIdempotencyKeys,
  listPayouts,
  listPayoutSummaryRows,
  recordSettlementProviderIdempotencyKey,
  recordSettlementProviderOperationFailed,
  recordSettlementProviderOperationPending,
  recordSettlementProviderOperationSucceeded,
} from "../read-model/queries";
import { buildPayoutAvailability, buildPayoutSummary } from "../read-model/payout-summary";
import { getAccountActiveSpendHoldAmount, getAccountActiveSupportHoldAmount } from "../../wallets/read-model/queries";
import type { PayoutReadinessServices } from "../../payout-readiness/api/runtime";
import { decidePayout, evolvePayout, payoutMonthStreamId, planPayoutMonthRequest } from "../domain/domain";
import {
  calculateCanonicalMoneyOrThrow,
  isConcurrencyConflict,
  isTerminalProviderFailure,
  payoutAmounts,
  payoutDebitLedgerEntryId,
  payoutFeeDebitLedgerEntryId,
  providerErrorMessage,
  requirePayoutSnapshot,
  type PayoutPrimitives,
} from "./payout-primitives";
import type {
  PayoutCommandSnapshot,
  PayoutDestinationFrictionPolicy,
  PayoutRuntimeDeps,
  PayoutServices,
  SensitiveActionVerifier,
} from "./runtime";

async function requireExistingPayout(db: PgQueryable, payoutId: string, accountId: string) {
  const payout = await getPayout(db, payoutId, accountId);
  if (!payout) {
    throw new SettlementDomainError("Payout was not found.");
  }
  return payout;
}

const MAX_PAYOUT_IDEMPOTENCY_KEY_LENGTH = 255;

/** Normalise a client Idempotency-Key: trim, drop empties, and bound its length. */
function normalizePayoutIdempotencyKey(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }
  if (trimmed.length > MAX_PAYOUT_IDEMPOTENCY_KEY_LENGTH) {
    throw new SettlementDomainError("Idempotency key is too long.");
  }
  return trimmed;
}

class PayoutRequestRejectedBeforeAppend extends Error {
  constructor(readonly rejection: unknown) {
    super(providerErrorMessage(rejection, "Payout request was rejected before it was recorded."));
    this.name = "PayoutRequestRejectedBeforeAppend";
  }
}

function payoutReadinessIsStale(updatedAt: string | null) {
  if (!updatedAt) {
    return false;
  }
  return Date.now() - Date.parse(updatedAt) > 30 * 24 * 60 * 60 * 1000;
}

type PayoutReadinessSnapshot = Awaited<ReturnType<PayoutReadinessServices["getPayoutReadiness"]>>;

function payoutReadinessStalenessIsOnlySetupBlocker(readiness: PayoutReadinessSnapshot) {
  return (
    readiness.status === "ready" &&
    Boolean(readiness.provider_reference) &&
    readiness.missing_requirements.length === 0 &&
    payoutReadinessIsStale(readiness.updated_at)
  );
}

const DEFAULT_PAYOUT_DESTINATION_FRICTION_POLICY: PayoutDestinationFrictionPolicy = {
  enabled: true,
  coolingPeriodMs: 24 * 60 * 60 * 1000,
  requireStepUpForAccountManagement: true,
  accountManagementRecentAuthMaxAgeMinutes: 15,
};

function payoutDestinationFrictionPolicy(
  policy?: Partial<PayoutDestinationFrictionPolicy>,
): PayoutDestinationFrictionPolicy {
  return {
    ...DEFAULT_PAYOUT_DESTINATION_FRICTION_POLICY,
    ...policy,
  };
}

function payoutDestinationCoolingWindowEndsAt(
  readiness: PayoutReadinessSnapshot,
  policy: PayoutDestinationFrictionPolicy,
  nowMs = Date.now(),
) {
  if (!policy.enabled || !readiness.payout_destination_changed_at) {
    return null;
  }
  const changedAtMs = Date.parse(readiness.payout_destination_changed_at);
  if (!Number.isFinite(changedAtMs)) {
    return null;
  }
  const endsAtMs = changedAtMs + policy.coolingPeriodMs;
  return nowMs < endsAtMs ? new Date(endsAtMs).toISOString() : null;
}

/**
 * Resolves the settlement payout-bounds policy in effect at `at`. When no
 * `policies` runtime is wired (standalone/test usage) this falls back to the
 * compiled launch bounds -- an empty or absent policy table can never break
 * the payout request hot path.
 */
async function resolvePayoutBoundsPolicy(
  deps: Pick<PayoutRuntimeDeps, "policies">,
  at?: string,
): Promise<SettlementPayoutBoundsPolicyValue> {
  if (!deps.policies) {
    return payoutAmountPolicy;
  }
  const resolved = await deps.policies.resolvePolicy(settlementPayoutBoundsPolicy, at ? { at } : undefined);
  return resolved.value;
}

async function loadPayoutQuickAmountContext(
  deps: Pick<PayoutRuntimeDeps, "db" | "wallets" | "policies">,
  accountId: AccountId,
) {
  const wallet = await deps.wallets.getWallet(accountId);
  const [activeSupportHoldAmount, activeSpendHoldAmount, payoutBoundsPolicy] = await Promise.all([
    getAccountActiveSupportHoldAmount(deps.db, accountId),
    getAccountActiveSpendHoldAmount(deps.db, accountId),
    resolvePayoutBoundsPolicy(deps),
  ]);
  const currencyCode = normalizeCurrencyCode(wallet.currency_code);
  const payoutAvailableBalanceAmount = calculateCanonicalMoneyOrThrow(
    "Payout available balance must be a valid signed decimal.",
    () => subtractMoney(subtractMoney(wallet.available_balance_amount, activeSupportHoldAmount), activeSpendHoldAmount),
  );
  return {
    currencyCode,
    payoutAvailableBalanceAmount,
    payoutBoundsPolicy,
    activeSupportHoldAmount,
    activeSpendHoldAmount,
    wallet,
  };
}

type ResolvedPayoutFeePolicy = Readonly<{
  value: SettlementPayoutFeePolicyValue;
  version: string;
  resolvedAt: string;
}>;

async function resolvePayoutFeePolicy(
  deps: Pick<PayoutRuntimeDeps, "policies">,
  at: string,
): Promise<ResolvedPayoutFeePolicy> {
  if (!deps.policies) {
    return { value: SETTLEMENT_PAYOUT_FEE_LAUNCH_POLICY_VALUE, version: "fallback", resolvedAt: at };
  }
  const resolved = await deps.policies.resolvePolicy(settlementPayoutFeePolicy, { at });
  return {
    value: resolved.value,
    version: resolved.documentId ?? "fallback",
    resolvedAt: resolved.resolvedAt,
  };
}

/**
 * Payout request lifecycle: request preview and commit, wallet net/fee
 * debits, provider transfer and payout submission, operator state commands,
 * failure reversal and the payout reads that follow one request.
 */
export function createPayoutRequestLifecycle(
  deps: Pick<
    PayoutRuntimeDeps,
    | "db"
    | "wallets"
    | "payoutReadiness"
    | "moneyMovementGateway"
    | "policies"
    | "payoutDestinationFrictionPolicy"
    | "sensitiveActionVerifier"
    | "payoutPostingFault"
  >,
  primitives: Pick<
    PayoutPrimitives,
    | "commandHandler"
    | "repository"
    | "payoutMonthRepository"
    | "payoutCodec"
    | "payoutMonthCodec"
    | "recordOperation"
    | "recordPayoutProviderReferences"
    | "requireAtomicPayoutAppend"
    | "activePayoutBaselineIds"
    | "failPayoutAndReverseWallet"
  >,
): Pick<
  PayoutServices,
  | "listPayouts"
  | "getPayoutSummary"
  | "getPayout"
  | "getPayoutQuickAmounts"
  | "getPayoutMoneyTimeline"
  | "previewPayoutRequest"
  | "requestPayout"
  | "markPayoutInTransit"
  | "completePayout"
  | "failPayout"
> {
  const {
    commandHandler,
    repository,
    payoutMonthRepository,
    payoutCodec,
    payoutMonthCodec,
    recordOperation,
    recordPayoutProviderReferences,
    requireAtomicPayoutAppend,
    activePayoutBaselineIds,
    failPayoutAndReverseWallet,
  } = primitives;
  const destinationFrictionPolicy = payoutDestinationFrictionPolicy(deps.payoutDestinationFrictionPolicy);
  const sensitiveActionVerifier = deps.sensitiveActionVerifier ?? (async () => false);

  async function verifySensitiveAction(input: Parameters<SensitiveActionVerifier>[0]) {
    if (!input.token.trim()) {
      return false;
    }
    return sensitiveActionVerifier(input);
  }

  // Replay the payout an idempotency reservation points at, straight from the
  // aggregate (strongly consistent — never the lagging read model). A reservation
  // is written immediately before the RequestPayout append, so in the rare window
  // where a concurrent duplicate reads the reservation before the winner's event
  // is visible, retry briefly rather than fabricate a snapshot; we never debited
  // on this path, so a transient throw is safe and the client's retry replays.
  async function replayReservedPayout(
    payoutId: string,
    requestedAmount: string,
    reservedAmount: string,
  ): Promise<{ payoutId: PayoutId; version: number; payout: PayoutCommandSnapshot }> {
    let amountsMatch = false;
    try {
      amountsMatch = compareMoney(reservedAmount, requestedAmount) === 0;
    } catch {
      amountsMatch = false;
    }
    if (!amountsMatch) {
      throw new SettlementDomainError("This idempotency key was already used for a different payout amount.");
    }
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const loaded = await repository.load(`settlement.payout-${payoutId}`);
      if (loaded.state.payoutId) {
        return {
          payoutId: payoutId as PayoutId,
          version: loaded.version,
          payout: requirePayoutSnapshot(loaded.state, loaded.version),
        };
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new SettlementDomainError("Payout request is still being created; retry the request shortly.");
  }

  async function refreshPayoutReadinessWhenStalenessIsOnlyBlocker(
    accountId: AccountId,
    readiness: PayoutReadinessSnapshot,
    context: EventStoreContext,
  ) {
    if (!payoutReadinessStalenessIsOnlySetupBlocker(readiness)) {
      return readiness;
    }

    return deps.payoutReadiness.refreshProviderReadiness(
      {
        accountId,
        providerReference: readiness.provider_reference,
      },
      context,
    );
  }

  async function commitPayoutRequest(
    params: Readonly<{
      payoutId: PayoutId;
      accountId: AccountId;
      requestedAmount: string;
      currencyCode: "usd";
      destinationReference?: string | null;
      note?: string | null;
      notificationEmail?: string | null;
      requestedAt: string;
      feePolicy: ResolvedPayoutFeePolicy;
    }>,
    context: EventStoreContext,
  ) {
    const appendToStreams = requireAtomicPayoutAppend();
    const payoutStreamId = `settlement.payout-${params.payoutId}`;
    const monthStreamId = payoutMonthStreamId(params.accountId, params.requestedAt);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const [payout, month] = await Promise.all([
        repository.load(payoutStreamId),
        payoutMonthRepository.load(monthStreamId),
      ]);
      if (payout.state.payoutId) {
        return {
          payoutId: params.payoutId,
          version: payout.version,
          payout: requirePayoutSnapshot(payout.state, payout.version),
        };
      }
      let monthPlan;
      let payoutEvents;
      try {
        const baselineActivePayoutIds = month.state.initialized
          ? []
          : await activePayoutBaselineIds(params.accountId, params.requestedAt);
        monthPlan = planPayoutMonthRequest(month.state, {
          accountId: params.accountId,
          payoutId: params.payoutId,
          requestedAt: params.requestedAt,
          baselineActivePayoutIds,
        });
        const quote = quotePayoutFee(params.requestedAmount, params.feePolicy.value, {
          isFirstPayoutOfMonth: monthPlan.isFirstPayoutOfMonth,
        });
        payoutEvents = decidePayout(payout.state, {
          type: "RequestPayout",
          payoutId: params.payoutId,
          accountId: params.accountId,
          requestedAmount: params.requestedAmount,
          feeAmount: quote.feeAmount,
          netAmount: quote.netAmount,
          currencyCode: params.currencyCode,
          destinationReference: params.destinationReference ?? null,
          note: params.note ?? null,
          notificationEmail: params.notificationEmail ?? null,
          requestedAt: params.requestedAt,
        });
      } catch (error) {
        throw new PayoutRequestRejectedBeforeAppend(error);
      }

      try {
        const stored = await appendToStreams([
          {
            streamId: monthStreamId,
            expectedVersion: month.version,
            context,
            events: monthPlan.events.map(payoutMonthCodec.encode),
          },
          {
            streamId: payoutStreamId,
            expectedVersion: payout.version,
            context,
            events: payoutEvents.map(payoutCodec.encode),
          },
        ]);
        recordCommittedEvents(
          stored.flatMap((result) => result.storedEvents),
          "settlement",
        );
        const nextState = applyEvents(payout.state, evolvePayout, payoutEvents);
        return {
          payoutId: params.payoutId,
          version: payout.version + payoutEvents.length,
          payout: requirePayoutSnapshot(nextState, payout.version + payoutEvents.length),
        };
      } catch (error) {
        if (!isConcurrencyConflict(error) || attempt === 4) {
          throw error;
        }
      }
    }
    throw new SettlementDomainError("Payout month selection did not converge.");
  }

  return {
    listPayouts: (params) => listPayouts(deps.db, params),
    async getPayoutSummary({ accountId, canRequestPayouts, evaluatedAt = new Date().toISOString() }) {
      const [rows, wallet, readiness] = await Promise.all([
        listPayoutSummaryRows(deps.db, accountId),
        deps.wallets.getWallet(accountId),
        deps.payoutReadiness.getPayoutReadiness(accountId),
      ]);
      return buildPayoutSummary({
        items: rows.items,
        total: rows.total,
        completeness: rows.completeness,
        evaluatedAt,
        availability: buildPayoutAvailability({ wallet, readiness, canRequestPayouts }),
      });
    },
    getPayout: (payoutId, accountId) => getPayout(deps.db, payoutId, accountId),
    async getPayoutQuickAmounts({ accountId }) {
      const { currencyCode, payoutAvailableBalanceAmount, payoutBoundsPolicy } = await loadPayoutQuickAmountContext(
        deps,
        accountId,
      );
      return {
        currency_code: currencyCode,
        minimum_amount: payoutBoundsPolicy.minimumAmount,
        maximum_amount: payoutBoundsPolicy.maximumAmount,
        full_available_amount: capPayoutAmountToPolicy(payoutAvailableBalanceAmount, payoutBoundsPolicy),
      };
    },
    async getPayoutMoneyTimeline(params) {
      const payout = await requireExistingPayout(deps.db, params.payoutId, params.accountId);
      const amounts = payoutAmounts(payout);
      const [walletEntries, idempotencyKeys] = await Promise.all([
        deps.wallets.listWalletEntries({
          accountId: params.accountId,
          limit: 250,
        }),
        listSettlementProviderIdempotencyKeys(deps.db, {
          accountId: params.accountId,
          limit: 100,
        }),
      ]);
      const items = [
        {
          occurred_at: payout.requested_at,
          kind: "payout-requested",
          label: "Payout requested",
          reference: payout.display_reference,
          amount: amounts.requestedAmount,
          requested_amount: amounts.requestedAmount,
          fee_amount: amounts.feeAmount,
          net_amount: amounts.netAmount,
          currency_code: payout.currency_code,
        },
        ...walletEntries.items
          .filter((entry) => entry.payout_id === payout.payout_id)
          .map((entry) => ({
            occurred_at: entry.posted_at,
            kind: `wallet-${entry.kind}`,
            label: entry.direction === "credit" ? "Wallet credited" : "Wallet debited",
            reference: entry.ledger_entry_id,
            amount: entry.amount,
            currency_code: entry.currency_code,
          })),
        ...idempotencyKeys
          .filter((entry) => entry.payout_id === payout.payout_id)
          .map((entry) => ({
            occurred_at: entry.created_at,
            kind: entry.operation_kind,
            label: "Provider operation submitted",
            reference: entry.provider_object_reference ?? entry.operation_key,
            amount: null,
            currency_code: null,
          })),
        ...(payout.sent_at
          ? [
              {
                occurred_at: payout.sent_at,
                kind: "provider-payout-submitted",
                label: "Provider payout submitted",
                reference: payout.provider_payout_reference,
                amount: amounts.netAmount,
                requested_amount: amounts.requestedAmount,
                fee_amount: amounts.feeAmount,
                net_amount: amounts.netAmount,
                currency_code: payout.currency_code,
              },
            ]
          : []),
        ...(payout.completed_at
          ? [
              {
                occurred_at: payout.completed_at,
                kind: "payout-completed",
                label: "Payout completed",
                reference: payout.provider_payout_reference,
                amount: amounts.netAmount,
                requested_amount: amounts.requestedAmount,
                fee_amount: amounts.feeAmount,
                net_amount: amounts.netAmount,
                currency_code: payout.currency_code,
              },
            ]
          : []),
        ...(payout.failed_at
          ? [
              {
                occurred_at: payout.failed_at,
                kind: "payout-failed",
                label: "Payout failed",
                reference: payout.provider_payout_reference,
                amount: amounts.netAmount,
                requested_amount: amounts.requestedAmount,
                fee_amount: amounts.feeAmount,
                net_amount: amounts.netAmount,
                currency_code: payout.currency_code,
              },
            ]
          : []),
      ].sort((left, right) => left.occurred_at.localeCompare(right.occurred_at));

      return {
        payout_id: payout.payout_id,
        account_id: payout.account_id,
        items,
      };
    },
    async previewPayoutRequest(params, context) {
      const evaluatedAt = new Date().toISOString();
      let readiness = await deps.payoutReadiness.getPayoutReadiness(params.accountId);
      const payoutQuickAmountContext = await loadPayoutQuickAmountContext(deps, params.accountId);
      const [riskSummary, platformBalance, payoutFeePolicy, payoutMonth] = await Promise.all([
        getAccountPayoutRiskSummary(deps.db, params.accountId),
        deps.moneyMovementGateway.retrievePlatformBalance({ currencyCode: payoutQuickAmountContext.currencyCode }),
        resolvePayoutFeePolicy(deps, evaluatedAt),
        payoutMonthRepository.load(payoutMonthStreamId(params.accountId, evaluatedAt)),
      ]);
      const {
        currencyCode,
        payoutAvailableBalanceAmount,
        payoutBoundsPolicy,
        activeSupportHoldAmount,
        activeSpendHoldAmount,
        wallet,
      } = payoutQuickAmountContext;
      const amount = normalizeMoneyAmount(
        resolvePayoutAmountSelection(
          {
            amount: params.amount,
            shortcut: params.amountSelection,
            availableAmount: payoutAvailableBalanceAmount,
          },
          payoutBoundsPolicy,
        ),
        { fieldName: "Payout amount" },
      );
      const baselineActivePayoutIds = payoutMonth.state.initialized
        ? []
        : await activePayoutBaselineIds(params.accountId, evaluatedAt);
      const isFirstPayoutOfMonth =
        payoutMonth.state.activePayoutIds.length === 0 && baselineActivePayoutIds.length === 0;
      const recurringFeeAmount = payoutFeeAmount(amount, payoutFeePolicy.value);
      const monthlyActiveFeeAmount = isFirstPayoutOfMonth
        ? payoutFeePolicy.value.firstPayoutOfMonthFixedAmount
        : "0.00";
      const feeAmount = calculateCanonicalMoneyOrThrow("Payout fee amount must be valid.", () =>
        sumMoneyAmounts([recurringFeeAmount, monthlyActiveFeeAmount]),
      );
      const amountExceedsFee = compareMoney(amount, feeAmount) > 0;
      const netAmount = amountExceedsFee
        ? calculateCanonicalMoneyOrThrow("Payout net amount must be valid.", () => subtractMoney(amount, feeAmount))
        : "0.00";
      const platformAvailableAmount = normalizeSignedMoneyAmount(
        platformBalance.availableAmount,
        "Platform available amount",
      );
      const unavailableReasons: string[] = [];
      // Buyer-spend holds reserve balance the account applied at checkout but
      // that has not yet debited at capture; it must not be payable meanwhile,
      // or the same funds could be both withdrawn and spent.

      if (payoutReadinessStalenessIsOnlySetupBlocker(readiness)) {
        try {
          readiness = await refreshPayoutReadinessWhenStalenessIsOnlyBlocker(params.accountId, readiness, context);
        } catch {
          unavailableReasons.push("payout-setup-refresh-required");
        }
      }
      if (readiness.status !== "ready" || !readiness.provider_reference) {
        unavailableReasons.push("payout-setup-incomplete");
      }
      if (readiness.status === "ready" && payoutReadinessIsStale(readiness.updated_at)) {
        unavailableReasons.push("payout-setup-refresh-required");
      }
      if (readiness.missing_requirements.length > 0) {
        unavailableReasons.push("provider-requirements-open");
      }
      if (payoutDestinationCoolingWindowEndsAt(readiness, destinationFrictionPolicy)) {
        unavailableReasons.push("payout-destination-cooling-period");
      }
      if (compareMoney(payoutAvailableBalanceAmount, "0.00") <= 0) {
        unavailableReasons.push("no-available-wallet-balance");
      }
      if (
        wallet.negative_balance_status !== "in-good-standing" ||
        compareMoney(wallet.available_balance_amount, "0.00") < 0
      ) {
        unavailableReasons.push("negative-balance-active");
      }
      if (
        compareMoney(payoutAvailableBalanceAmount, "0.00") <= 0 &&
        compareMoney(wallet.pending_balance_amount, "0.00") > 0
      ) {
        unavailableReasons.push("payout-release-hold-active");
      }
      if (compareMoney(amount, payoutBoundsPolicy.minimumAmount) < 0) {
        unavailableReasons.push("amount-below-minimum");
      }
      if (compareMoney(amount, payoutBoundsPolicy.maximumAmount) > 0) {
        unavailableReasons.push("amount-above-maximum");
      }
      if (!amountExceedsFee) {
        unavailableReasons.push("payout-amount-below-fee");
      }
      if (compareMoney(payoutAvailableBalanceAmount, amount) < 0) {
        unavailableReasons.push("amount-exceeds-available-balance");
      }
      if (compareMoney(activeSupportHoldAmount, "0.00") > 0) {
        unavailableReasons.push("support-hold-active");
      }
      if (amountExceedsFee && compareMoney(platformAvailableAmount, netAmount) < 0) {
        unavailableReasons.push("platform-balance-insufficient");
      }
      if (riskSummary.failed_payout_count > 0) {
        unavailableReasons.push("recent-payout-failure");
      }
      if (riskSummary.stale_requested_payout_count > 0) {
        unavailableReasons.push("payout-reconciliation-required");
      }

      const uniqueReasons = [...new Set(unavailableReasons)];
      return {
        account_id: params.accountId,
        requested_amount: amount,
        fee_amount: feeAmount,
        net_amount: netAmount,
        monthly_active_fee_amount: monthlyActiveFeeAmount,
        is_first_payout_of_month: isFirstPayoutOfMonth,
        fee_policy_version: payoutFeePolicy.version,
        fee_lines: [
          { code: "payout-fee" as const, label: payoutFeePolicy.value.label, amount: recurringFeeAmount },
          ...(compareMoney(monthlyActiveFeeAmount, "0.00") > 0
            ? [
                {
                  code: "monthly-active-fee" as const,
                  label: "First payout of the month",
                  amount: monthlyActiveFeeAmount,
                },
              ]
            : []),
        ],
        currency_code: currencyCode,
        available_balance_amount: payoutAvailableBalanceAmount,
        platform_available_amount: platformAvailableAmount,
        estimated_wallet_balance_after:
          compareMoney(payoutAvailableBalanceAmount, amount) >= 0
            ? calculateCanonicalMoneyOrThrow("Payout available balance must be a valid signed decimal.", () =>
                subtractMoney(payoutAvailableBalanceAmount, amount),
              )
            : "0.00",
        can_request: uniqueReasons.length === 0,
        unavailable_reasons: uniqueReasons,
        unavailable_reason_details: moneyStatusDetails(uniqueReasons),
      };
    },
    async requestPayout(params, context) {
      const idempotencyKey = normalizePayoutIdempotencyKey(params.idempotencyKey);
      if (idempotencyKey) {
        const existing = await findPayoutRequestIdempotency(deps.db, params.accountId, idempotencyKey);
        if (existing) {
          // A prior request with this key already minted (and debited) a payout;
          // replay it rather than create a second one.
          return await replayReservedPayout(existing.payout_id, params.amount, existing.requested_amount);
        }
      }
      const wallet = await deps.wallets.getWallet(params.accountId);
      let readiness = await deps.payoutReadiness.getPayoutReadiness(params.accountId);
      const currencyCode = normalizeCurrencyCode(wallet.currency_code);
      const requestedAt = new Date().toISOString();
      const [payoutBoundsPolicy, payoutFeePolicy] = await Promise.all([
        resolvePayoutBoundsPolicy(deps),
        resolvePayoutFeePolicy(deps, requestedAt),
      ]);
      const amount = assertPayoutAmountWithinPolicy(params.amount, currencyCode, payoutBoundsPolicy);
      try {
        readiness = await refreshPayoutReadinessWhenStalenessIsOnlyBlocker(params.accountId, readiness, context);
      } catch {
        await recordOperation({
          kind: "payout-request-blocked-by-setup",
          accountId: params.accountId,
          amount,
          currencyCode,
          readinessStatus: readiness.status,
          providerReference: readiness.provider_reference,
          missingRequirementCount: readiness.missing_requirements.length,
          staleReadiness: true,
          safeCategory: "setup_stale",
        });
        throw new SettlementDomainError("Payout setup status must be refreshed before requesting a payout.");
      }
      if (readiness.status !== "ready") {
        await recordOperation({
          kind: "payout-request-blocked-by-setup",
          accountId: params.accountId,
          amount,
          currencyCode,
          readinessStatus: readiness.status,
          providerReference: readiness.provider_reference,
          missingRequirementCount: readiness.missing_requirements.length,
          staleReadiness: payoutReadinessIsStale(readiness.updated_at),
          safeCategory: "setup_incomplete",
        });
        throw new SettlementDomainError("Payout setup must be complete before requesting payouts.");
      }
      if (!readiness.provider_reference) {
        await recordOperation({
          kind: "payout-request-blocked-by-setup",
          accountId: params.accountId,
          amount,
          currencyCode,
          readinessStatus: readiness.status,
          providerReference: readiness.provider_reference,
          missingRequirementCount: readiness.missing_requirements.length,
          staleReadiness: payoutReadinessIsStale(readiness.updated_at),
          safeCategory: "missing_provider_account",
        });
        throw new SettlementDomainError("Payout setup must include a provider account.");
      }
      if (payoutReadinessIsStale(readiness.updated_at)) {
        await recordOperation({
          kind: "payout-request-blocked-by-setup",
          accountId: params.accountId,
          amount,
          currencyCode,
          readinessStatus: readiness.status,
          providerReference: readiness.provider_reference,
          missingRequirementCount: readiness.missing_requirements.length,
          staleReadiness: true,
          safeCategory: "setup_stale",
        });
        throw new SettlementDomainError("Payout setup status must be refreshed before requesting a payout.");
      }
      if (readiness.missing_requirements.length > 0) {
        await recordOperation({
          kind: "payout-request-blocked-by-setup",
          accountId: params.accountId,
          amount,
          currencyCode,
          readinessStatus: readiness.status,
          providerReference: readiness.provider_reference,
          missingRequirementCount: readiness.missing_requirements.length,
          staleReadiness: false,
          safeCategory: "requirements_open",
        });
        throw new SettlementDomainError("Payout setup requirements must be resolved before requesting a payout.");
      }
      const coolingWindowEndsAt = payoutDestinationCoolingWindowEndsAt(readiness, destinationFrictionPolicy);
      if (coolingWindowEndsAt) {
        const verified = await verifySensitiveAction({
          accountId: params.accountId,
          userId: params.actorUserId ?? null,
          token: params.sensitiveActionToken ?? "",
          purpose: "payout-request",
        });
        if (!verified) {
          await recordOperation({
            kind: "payout-request-blocked-by-destination-friction",
            accountId: params.accountId,
            amount,
            currencyCode,
            providerReference: readiness.provider_reference,
            reason: `Payout destination changed within cooling period ending ${coolingWindowEndsAt}.`,
          });
          throw new SettlementDomainError(
            "Confirm it is you before requesting a payout, or wait until the payout destination cooling period ends.",
          );
        }
      }
      const riskSummary = await getAccountPayoutRiskSummary(deps.db, params.accountId);
      if (riskSummary.failed_payout_count > 0) {
        throw new SettlementDomainError("Recent payout failures must be reviewed before requesting another payout.");
      }
      if (riskSummary.stale_requested_payout_count > 0) {
        throw new SettlementDomainError(
          "A previous payout request needs reconciliation before requesting another payout.",
        );
      }

      const [activeSupportHoldAmount, activeSpendHoldAmount] = await Promise.all([
        getAccountActiveSupportHoldAmount(deps.db, params.accountId),
        getAccountActiveSpendHoldAmount(deps.db, params.accountId),
      ]);
      // Reserved buyer-spend credit (applied at checkout, not yet captured) is
      // not payable -- gate it out so the same funds can't be paid out and spent.
      const payoutAvailableBalanceAmount = calculateCanonicalMoneyOrThrow(
        "Payout available balance must be a valid signed decimal.",
        () =>
          subtractMoney(subtractMoney(wallet.available_balance_amount, activeSupportHoldAmount), activeSpendHoldAmount),
      );
      if (
        wallet.negative_balance_status !== "in-good-standing" ||
        compareMoney(wallet.available_balance_amount, "0.00") < 0
      ) {
        throw new SettlementDomainError("Negative balance must be recovered before requesting payout.");
      }
      if (compareMoney(activeSupportHoldAmount, "0.00") > 0) {
        throw new SettlementDomainError("Open support requests must be resolved before requesting this payout.");
      }
      if (compareMoney(activeSpendHoldAmount, "0.00") > 0 && compareMoney(payoutAvailableBalanceAmount, amount) < 0) {
        throw new SettlementDomainError("Wallet balance is reserved for an in-flight checkout and is not yet payable.");
      }
      if (compareMoney(payoutAvailableBalanceAmount, amount) < 0) {
        throw new SettlementDomainError("Available balance is too low for this payout.");
      }
      const payoutMonth = await payoutMonthRepository.load(payoutMonthStreamId(params.accountId, requestedAt));
      const baselineActivePayoutIds = payoutMonth.state.initialized
        ? []
        : await activePayoutBaselineIds(params.accountId, requestedAt);
      const isFirstPayoutOfMonth =
        payoutMonth.state.activePayoutIds.length === 0 && baselineActivePayoutIds.length === 0;
      try {
        quotePayoutFee(amount, payoutFeePolicy.value, { isFirstPayoutOfMonth });
      } catch {
        throw new SettlementDomainError("Requested payout amount must exceed the payout fee.");
      }
      const maximumNetAmount = quotePayoutFee(amount, payoutFeePolicy.value, {
        isFirstPayoutOfMonth: false,
      }).netAmount;
      const platformBalance = await deps.moneyMovementGateway.retrievePlatformBalance({
        currencyCode,
      });
      const platformAvailableAmount = normalizeSignedMoneyAmount(
        platformBalance.availableAmount,
        "Platform available amount",
      );
      if (compareMoney(platformAvailableAmount, maximumNetAmount) < 0) {
        await recordOperation({
          kind: "platform-balance-insufficient",
          accountId: params.accountId,
          amount: maximumNetAmount,
          currencyCode,
          reason: `Available platform balance ${platformAvailableAmount} is below the maximum net payout amount ${maximumNetAmount}.`,
        });
        throw new SettlementDomainError("Platform balance is too low for this payout.");
      }
      const payoutId = createId("pyo") as PayoutId;
      if (idempotencyKey) {
        // Claim the key before the payout stream is created and the wallet is
        // debited. If a concurrent duplicate already won the claim, abandon this
        // freshly minted (still-uncreated, undebited) payoutId and replay theirs.
        const reservation = await reservePayoutRequestIdempotency(deps.db, {
          accountId: params.accountId,
          idempotencyKey,
          payoutId,
          requestedAmount: amount,
          currencyCode,
          createdAt: requestedAt,
        });
        if (!reservation.reserved) {
          return await replayReservedPayout(reservation.payout_id, amount, reservation.requested_amount);
        }
      }
      let commandSnapshot;
      try {
        commandSnapshot = await commitPayoutRequest(
          {
            payoutId,
            accountId: params.accountId,
            requestedAmount: amount,
            currencyCode,
            destinationReference: params.destinationReference ?? null,
            note: params.note ?? null,
            notificationEmail: params.notificationEmail ?? null,
            requestedAt,
            feePolicy: payoutFeePolicy,
          },
          context,
        );
      } catch (error) {
        if (idempotencyKey && error instanceof PayoutRequestRejectedBeforeAppend) {
          await releaseUncommittedPayoutRequestIdempotency(deps.db, {
            accountId: params.accountId,
            idempotencyKey,
            payoutId,
          });
          throw error.rejection;
        }
        throw error;
      }
      const { fee_amount: feeAmount, net_amount: netAmount } = commandSnapshot.payout;
      await recordOperation({
        kind: "payout-requested",
        accountId: params.accountId,
        payoutId,
        amount,
        requestedAmount: amount,
        feeAmount,
        netAmount,
        currencyCode,
      });

      try {
        await deps.wallets.postEntry(
          {
            accountId: params.accountId,
            ledgerEntryId: payoutDebitLedgerEntryId(payoutId),
            kind: "payout",
            direction: "debit",
            amount: netAmount,
            currencyCode,
            fundsStatus: "available",
            payoutId,
            description: params.note ?? `Payout ${deriveDisplayReferenceOrRaw(payoutId)}`,
            postedAt: requestedAt,
          },
          context,
        );
        await deps.payoutPostingFault?.("after-net-debit");
        if (compareMoney(feeAmount, "0.00") > 0) {
          await deps.wallets.postEntry(
            {
              accountId: params.accountId,
              ledgerEntryId: payoutFeeDebitLedgerEntryId(payoutId),
              kind: "fee",
              direction: "debit",
              amount: feeAmount,
              currencyCode,
              fundsStatus: "available",
              payoutId,
              description: `Payout fee for ${deriveDisplayReferenceOrRaw(payoutId)}`,
              postedAt: requestedAt,
            },
            context,
          );
        }
      } catch (error) {
        const failureMessage = providerErrorMessage(error, "Payout wallet debit failed.");
        const failedSnapshot = await failPayoutAndReverseWallet(
          {
            payoutId,
            accountId: params.accountId,
            failureReason: "Payout account details need review.",
            providerStatus: "failed",
            providerFailureMessage: failureMessage,
            netAmount,
            feeAmount,
            currencyCode,
          },
          context,
        );
        return {
          payoutId,
          version: failedSnapshot.version,
          payout: failedSnapshot.payout,
        };
      }

      const transferIdempotencyKey = `settlement:payout:${payoutId}:transfer`;
      const transferOperationKey = `payout:${payoutId}:transfer`;
      await recordSettlementProviderOperationPending(deps.db, {
        operationKey: transferOperationKey,
        providerName: deps.moneyMovementGateway.providerName,
        operationKind: "platform-transfer-create",
        accountId: params.accountId,
        payoutId,
        idempotencyKey: transferIdempotencyKey,
        request: {
          payoutId,
          accountId: params.accountId,
          providerReference: readiness.provider_reference,
          amount: netAmount,
          currencyCode,
        },
        createdAt: requestedAt,
      });

      let providerTransferReference: string | null = null;
      try {
        const transfer = await deps.moneyMovementGateway.transferPlatformBalanceToConnectedAccount({
          payoutId,
          accountId: params.accountId,
          providerReference: readiness.provider_reference,
          amount: netAmount,
          currencyCode,
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
          accountId: params.accountId,
          payoutId,
          providerObjectReference: transfer.providerTransferReference,
          idempotencyKey: transferIdempotencyKey,
          createdAt: new Date().toISOString(),
        });
        commandSnapshot = await recordPayoutProviderReferences(
          {
            payoutId,
            providerTransferReference: transfer.providerTransferReference,
          },
          context,
        );
        await recordOperation({
          kind: "provider-transfer-submitted",
          accountId: params.accountId,
          payoutId,
          amount: netAmount,
          requestedAmount: amount,
          feeAmount,
          netAmount,
          currencyCode,
          providerTransferReference: transfer.providerTransferReference,
        });
      } catch (error) {
        const providerFailureMessage = providerErrorMessage(error, "Provider transfer submission failed.");
        await recordSettlementProviderOperationFailed(deps.db, {
          operationKey: transferOperationKey,
          errorMessage: providerFailureMessage,
        });
        if (!isTerminalProviderFailure(error)) {
          return commandSnapshot;
        }
        await recordOperation({
          kind: "payout-failed",
          accountId: params.accountId,
          payoutId,
          amount: netAmount,
          requestedAmount: amount,
          feeAmount,
          netAmount,
          currencyCode,
          reason: providerFailureMessage,
        });
        const failedSnapshot = await failPayoutAndReverseWallet(
          {
            payoutId,
            accountId: params.accountId,
            failureReason: "Payout account details need review.",
            providerStatus: "failed",
            providerFailureMessage,
            netAmount,
            feeAmount,
            currencyCode,
          },
          context,
        );
        return {
          payoutId,
          version: failedSnapshot.version,
          payout: failedSnapshot.payout,
        };
      }

      const payoutIdempotencyKey = `settlement:payout:${payoutId}:payout`;
      const payoutOperationKey = `payout:${payoutId}:payout`;
      await recordSettlementProviderOperationPending(deps.db, {
        operationKey: payoutOperationKey,
        providerName: deps.moneyMovementGateway.providerName,
        operationKind: "connected-account-payout-create",
        accountId: params.accountId,
        payoutId,
        idempotencyKey: payoutIdempotencyKey,
        request: {
          payoutId,
          accountId: params.accountId,
          providerReference: readiness.provider_reference,
          amount: netAmount,
          currencyCode,
        },
      });

      try {
        const providerPayout = await deps.moneyMovementGateway.createConnectedAccountPayout({
          payoutId,
          accountId: params.accountId,
          providerReference: readiness.provider_reference,
          amount: netAmount,
          currencyCode,
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
          accountId: params.accountId,
          payoutId,
          providerObjectReference: providerPayout.providerPayoutReference,
          idempotencyKey: payoutIdempotencyKey,
          createdAt: new Date().toISOString(),
        });
        commandSnapshot = await recordPayoutProviderReferences(
          {
            payoutId,
            providerTransferReference,
            providerPayoutReference: providerPayout.providerPayoutReference,
            providerStatus: providerPayout.providerStatus,
          },
          context,
        );
        await recordOperation({
          kind: "provider-payout-submitted",
          accountId: params.accountId,
          payoutId,
          amount: netAmount,
          requestedAmount: amount,
          feeAmount,
          netAmount,
          currencyCode,
          providerPayoutReference: providerPayout.providerPayoutReference,
        });

        const inTransit = await commandHandler({
          streamId: `settlement.payout-${payoutId}`,
          command: {
            type: "MarkPayoutInTransit",
            providerTransferReference,
            providerPayoutReference: providerPayout.providerPayoutReference,
            providerStatus: providerPayout.providerStatus,
            sentAt: new Date().toISOString(),
          },
          context,
        });
        commandSnapshot = {
          payoutId,
          version: inTransit.version,
          payout: requirePayoutSnapshot(inTransit.state, inTransit.version),
        };
      } catch (error) {
        const providerFailureMessage = providerErrorMessage(error, "Provider payout submission failed.");
        await recordSettlementProviderOperationFailed(deps.db, {
          operationKey: payoutOperationKey,
          errorMessage: providerFailureMessage,
        });
        await recordOperation({
          kind: "payout-failed",
          accountId: params.accountId,
          payoutId,
          amount: netAmount,
          requestedAmount: amount,
          feeAmount,
          netAmount,
          currencyCode,
          reason: providerFailureMessage,
        });
      }

      return commandSnapshot;
    },
    async markPayoutInTransit(params, context) {
      await requireExistingPayout(deps.db, params.payoutId, params.accountId);
      const result = await commandHandler({
        streamId: `settlement.payout-${params.payoutId}`,
        command: {
          type: "MarkPayoutInTransit",
          providerTransferReference: null,
          providerPayoutReference: null,
          providerStatus: null,
          sentAt: params.sentAt ?? new Date().toISOString(),
        },
        context,
      });

      return {
        payoutId: params.payoutId,
        version: result.version,
      };
    },
    async completePayout(params, context) {
      await requireExistingPayout(deps.db, params.payoutId, params.accountId);
      const completedAt = params.completedAt ?? new Date().toISOString();
      const result = await commandHandler({
        streamId: `settlement.payout-${params.payoutId}`,
        command: {
          type: "CompletePayout",
          providerStatus: null,
          completedAt,
          csatOutcomeFact: createPayoutCompletedCsatOutcomeFact({
            accountId: params.accountId,
            payoutId: params.payoutId,
            completedAt,
          }),
        },
        context,
      });

      return {
        payoutId: params.payoutId,
        version: result.version,
      };
    },
    failPayout: failPayoutAndReverseWallet,
  };
}
