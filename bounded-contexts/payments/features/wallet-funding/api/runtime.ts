import { createAggregateCommandHandler } from "@chase-sets/event-core/aggregate-command-handler";
import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import type { EventStore } from "@chase-sets/event-core/event-store";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { createProjectionHandlerSet } from "@chase-sets/event-core/projector";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import type { AccountId } from "@chase-sets/primitives/typed-ids";
import type { PaymentProcessorGateway, PaymentProcessorWebhookEvent } from "@chase-sets/payment-processing";
import type { CheckoutProcessingFeePolicyResolver } from "../../payments/api/checkout-processing-fee-policy-resolver";
import { quoteMarketplaceCheckoutFee } from "../../payments/api/marketplace-checkout-fee-policy";
import { getSavedCheckoutInstrument } from "../../payments/read-model/queries";
import { compareMoney, normalizeMoneyAmount } from "../../../support/runtime-support/common";
import { buildWalletFundingProjectionHandlers } from "../read-model/projection";
import {
  fundingIdForProcessorReference,
  listWalletFundings,
  releaseWalletFundingCreation,
  reserveWalletFundingCreation,
} from "../read-model/queries";
import {
  decideWalletFunding,
  evolveWalletFunding,
  initialWalletFundingState,
  fundingRule,
  type WalletFundingCommand,
  type WalletFundingEvent,
  type WalletFundingId,
  type WalletFundingState,
} from "../domain/domain";
import {
  parsePrepaidRefundReservation,
  unavailablePrepaidRefundAuthority,
  type PrepaidRefundAuthority,
  type PrepaidRefundReservation,
} from "./prepaid-refund-authority";
import { defaultWalletFundingLimits, decodeWalletFundingLimits, type WalletFundingLimits } from "./limits-policy";
import { refundObservationConflict, type WalletFundingRefundObservation } from "../domain/refund-operation";

export interface WalletFundingEligibilityResolver {
  resolve(
    accountId: AccountId,
  ): Promise<Readonly<{ goodStanding: boolean; paymentsTerms: "not-active" | "accepted" | "unaccepted" }>>;
}
export type WalletFundingRuntimeDeps = Readonly<{
  eventStore: EventStore;
  pool: PgTransactionalPool;
  processorGateway: PaymentProcessorGateway;
  prepaidRefundAuthority?: PrepaidRefundAuthority;
  walletFundingEligibilityResolver?: WalletFundingEligibilityResolver;
  checkoutProcessingFeePolicyResolver?: CheckoutProcessingFeePolicyResolver;
  resolveLimits?: () => Promise<WalletFundingLimits>;
  environment?: Readonly<Record<string, string | undefined>>;
  now?: () => Date;
}>;
export type CreateWalletFundingInput = Readonly<{
  fundingId: WalletFundingId;
  accountId: AccountId;
  requestedAmount: string;
  currencyCode: string;
  paymentMethodCategory: string;
  quoteFingerprint?: string;
  savedInstrumentId?: string | null;
}>;

export function createWalletFundingRuntime(deps: WalletFundingRuntimeDeps) {
  const now = () => (deps.now?.() ?? new Date()).toISOString();
  const authority = deps.prepaidRefundAuthority ?? unavailablePrepaidRefundAuthority;
  const aggregate = createAggregateCommandHandler<WalletFundingState, WalletFundingCommand, WalletFundingEvent>({
    eventStore: deps.eventStore,
    codec: createPassthroughDomainEventCodec<WalletFundingEvent>(),
    initialState: () => initialWalletFundingState,
    evolve: evolveWalletFunding,
    decide: decideWalletFunding,
    commitSourceContextName: "payments",
  });
  const stream = (id: WalletFundingId) => `payments.wallet-funding-${id}`;
  async function command(fundingId: WalletFundingId, value: WalletFundingCommand, context: EventStoreContext) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await aggregate.commandHandler({ streamId: stream(fundingId), command: value, context });
      } catch (error) {
        if (
          attempt >= 5 ||
          typeof error !== "object" ||
          error === null ||
          !("code" in error) ||
          error.code !== "concurrency_conflict"
        )
          throw error;
      }
    }
  }
  async function stateFor(fundingId: WalletFundingId) {
    return (await aggregate.repository.load(stream(fundingId))).state;
  }
  async function eligible(input: CreateWalletFundingInput) {
    const limits = decodeWalletFundingLimits(
      await (deps.resolveLimits?.() ?? Promise.resolve(defaultWalletFundingLimits)),
    );
    fundingRule(
      limits.allowedCurrencies.some((c) => c === input.currencyCode),
      "funding_currency_not_allowed",
    );
    fundingRule(
      limits.allowedMethods.some((m) => m === input.paymentMethodCategory),
      "funding_method_not_allowed",
    );
    fundingRule(compareMoney(input.requestedAmount, limits.minimumAmount) >= 0, "funding_below_minimum");
    fundingRule(compareMoney(input.requestedAmount, limits.maximumAmount) <= 0, "funding_above_maximum");
    const env = deps.environment ?? process.env;
    if (env.DEPLOYMENT_ENVIRONMENT === "production" || (!env.DEPLOYMENT_ENVIRONMENT && env.NODE_ENV === "production")) {
      fundingRule(
        env.PRODUCTION_WALLET_FUNDING_APPROVED === "true" && Boolean(env.PRODUCTION_WALLET_FUNDING_REFERENCE?.trim()),
        "funding_production_not_approved",
      );
      const allowlist =
        env.PRODUCTION_WALLET_FUNDING_ACCOUNT_ALLOWLIST?.split(",")
          .map((s) => s.trim())
          .filter(Boolean) ?? [];
      fundingRule(allowlist.length === 0 || allowlist.includes(input.accountId), "funding_account_not_allowlisted");
    }
    fundingRule(deps.walletFundingEligibilityResolver, "funding_identity_unavailable");
    const eligibility = await deps.walletFundingEligibilityResolver.resolve(input.accountId);
    fundingRule(eligibility.goodStanding === true, "funding_account_not_in_good_standing");
    fundingRule(
      eligibility.paymentsTerms === "not-active" || eligibility.paymentsTerms === "accepted",
      "funding_payments_terms_required",
    );
    return limits;
  }
  async function settle(fundingId: WalletFundingId, refundId: string, context: EventStoreContext) {
    const state = await stateFor(fundingId);
    const operation = state.refunds[refundId];
    fundingRule(operation && state.processorPaymentReference, "refund_not_found");
    if (operation.status !== "success-awaiting-commit" && operation.status !== "failure-awaiting-release")
      return operation;
    fundingRule(
      operation.reservationId && operation.processorRefundReference && operation.outcomeEvidenceId,
      "refund_terminal_evidence_required",
    );
    const reservation: PrepaidRefundReservation = {
      accountId: operation.accountId,
      fundingId,
      refundId,
      currencyCode: operation.currencyCode,
      amount: operation.amount,
      reservationId: operation.reservationId,
    };
    try {
      if (operation.status === "success-awaiting-commit") {
        const result = await authority.commit({
          ...reservation,
          processorPaymentReference: state.processorPaymentReference,
          processorRefundReference: operation.processorRefundReference,
          factId: `payments.wallet-funding-refunded:${fundingId}:${refundId}`,
        });
        fundingRule(result?.outcome === "committed", "refund_authority_commit_unconfirmed");
        await command(fundingId, { type: "SettleRefundAuthority", refundId, outcome: "committed", at: now() }, context);
      } else {
        fundingRule(
          operation.processorStatus === "failed" || operation.processorStatus === "cancelled",
          "refund_terminal_evidence_required",
        );
        const result = await authority.release({
          ...reservation,
          processorRefundReference: operation.processorRefundReference,
          processorStatus: operation.processorStatus,
          evidenceId: operation.outcomeEvidenceId,
        });
        fundingRule(result?.outcome === "released", "refund_authority_release_unconfirmed");
        await command(fundingId, { type: "SettleRefundAuthority", refundId, outcome: "released", at: now() }, context);
      }
    } catch {
      await command(
        fundingId,
        { type: "RecordRefundException", refundId, exception: "authority-unavailable", at: now() },
        context,
      );
    }
    return (await stateFor(fundingId)).refunds[refundId];
  }
  async function executeRefund(fundingId: WalletFundingId, refundId: string, context: EventStoreContext) {
    let state = await stateFor(fundingId);
    let operation = state.refunds[refundId];
    fundingRule(operation && state.processorPaymentReference, "refund_not_found");
    if (operation.status === "intent") {
      let result: Awaited<ReturnType<PrepaidRefundAuthority["reserve"]>>;
      try {
        result = await authority.reserve({
          accountId: operation.accountId,
          fundingId,
          refundId,
          amount: operation.amount,
          currencyCode: operation.currencyCode,
        });
      } catch {
        await command(
          fundingId,
          { type: "RecordRefundException", refundId, exception: "authority-unavailable", at: now() },
          context,
        );
        return (await stateFor(fundingId)).refunds[refundId];
      }
      const reservation =
        result?.outcome === "reserved" && Object.keys(result).sort().join(",") === "outcome,reservation"
          ? parsePrepaidRefundReservation(result.reservation, operation)
          : null;
      if (!reservation) {
        await command(
          fundingId,
          {
            type: "RecordRefundException",
            refundId,
            exception: result?.outcome === "refused" ? "authority-refused" : "malformed-grant",
            at: now(),
          },
          context,
        );
        return (await stateFor(fundingId)).refunds[refundId];
      }
      await command(fundingId, { type: "ReserveRefund", reservation, at: now() }, context);
    }
    const claimed = await command(fundingId, { type: "ClaimRefundSubmission", refundId, at: now() }, context);
    state = claimed.state;
    operation = state.refunds[refundId];
    if (claimed.newEvents.length > 0) {
      let response;
      try {
        response = await deps.processorGateway.createRefund({
          paymentId: fundingId,
          refundId,
          purpose: "wallet-funding",
          orderIds: [],
          processorPaymentReference: state.processorPaymentReference!,
          amount: operation.amount,
          currencyCode: operation.currencyCode,
          reason: "Wallet Funding Refund",
          idempotencyKey: operation.providerIdempotencyKey,
        });
      } catch {
        await command(
          fundingId,
          { type: "RecordRefundException", refundId, exception: "provider-outcome-unknown", at: now() },
          context,
        );
        return (await stateFor(fundingId)).refunds[refundId];
      }
      const status =
        response.processorStatus === "succeeded" ||
        response.processorStatus === "failed" ||
        response.processorStatus === "pending"
          ? response.processorStatus
          : response.processorStatus === "canceled" || response.processorStatus === "cancelled"
            ? "cancelled"
            : "unknown";
      await command(
        fundingId,
        {
          type: "ObserveRefund",
          observation: {
            refundId,
            processorRefundReference: response.processorRefundReference,
            amount: operation.amount,
            currencyCode: operation.currencyCode,
            status,
            evidenceId: `response:${response.processorRefundReference}:${status}`,
            at: now(),
          },
        },
        context,
      );
    }
    return settle(fundingId, refundId, context);
  }
  return {
    stateFor,
    command,
    projectors: [
      createProjectionHandlerSet({
        projectionName: "payments-wallet-funding-projection",
        handlers: buildWalletFundingProjectionHandlers(deps.pool),
      }),
    ],
    list: (accountId: AccountId) => listWalletFundings(deps.pool, accountId),
    async create(input: CreateWalletFundingInput, context: EventStoreContext) {
      const requestedAmount = normalizeMoneyAmount(input.requestedAmount, { fieldName: "Requested amount" });
      const limits = await eligible({ ...input, requestedAmount });
      const policy = await deps.checkoutProcessingFeePolicyResolver?.resolveCheckoutProcessingFeePolicy();
      const quote = quoteMarketplaceCheckoutFee(
        {
          orderAmount: requestedAmount,
          externalBasisAmount: requestedAmount,
          balanceCreditAmount: "0.00",
          paymentMethodCategory: "card",
          quotedAt: now(),
        },
        policy?.value,
      );
      if (!input.quoteFingerprint) return { outcome: "quoted" as const, quote };
      if (input.quoteFingerprint !== quote.quote_fingerprint) return { outcome: "fee_quote_stale" as const, quote };
      const saved = input.savedInstrumentId
        ? await getSavedCheckoutInstrument(deps.pool, {
            accountId: input.accountId,
            instrumentId: input.savedInstrumentId,
          })
        : null;
      fundingRule(
        !input.savedInstrumentId ||
          (saved && saved.payment_method_category === "card" && saved.readiness === "ready" && !saved.removed_at),
        "funding_instrument_unavailable",
      );
      const quoted = await command(
        input.fundingId,
        {
          type: "Quote",
          quote: {
            fundingId: input.fundingId,
            accountId: input.accountId,
            requestedAmount,
            feeAmount: quote.marketplace_checkout_fee_amount,
            grossAmount: quote.processor_amount,
            currencyCode: "usd",
            quoteFingerprint: quote.quote_fingerprint,
            quotedAt: now(),
            savedInstrumentId: input.savedInstrumentId ?? null,
          },
        },
        context,
      );
      fundingRule(quoted.state.quote, "funding_quote_required");
      await reserveWalletFundingCreation(deps.pool, quoted.state.quote, limits);
      const claimed = await command(input.fundingId, { type: "ClaimCreation", at: now() }, context);
      if (claimed.newEvents.length === 0) {
        const confirmation =
          claimed.state.processorPaymentReference && !claimed.state.capturedAt
            ? await deps.processorGateway.retrieveWalletFundingConfirmation?.(
                input.fundingId,
                claimed.state.processorPaymentReference,
              )
            : null;
        return {
          outcome: claimed.state.processorPaymentReference
            ? ("created" as const)
            : ("reconciliation-required" as const),
          funding: claimed.state,
          processorClientSecret: confirmation?.processorClientSecret ?? null,
          quote,
        };
      }
      let result;
      try {
        result = await deps.processorGateway.createPaymentSession({
          paymentId: input.fundingId,
          buyerAccountId: input.accountId,
          orderIds: [],
          purpose: "wallet-funding",
          amount: quote.processor_amount,
          currencyCode: "usd",
          paymentMethodCategory: "card",
          description: "Wallet Funding Payment",
          idempotencyKey: `payments:wallet-funding:${input.fundingId}:create`,
          cardAuthentication: { requestThreeDSecure: "any", reasonCodes: ["wallet-funding"] },
          marketplaceRiskMetadata: { purpose: "wallet-funding" },
          ...(saved
            ? {
                savedCheckoutInstrument: {
                  instrumentId: saved.instrument_id,
                  providerReference: saved.provider_reference,
                  providerCustomerReference: saved.provider_customer_reference,
                  confirmationExperience: "trusted-payment-step",
                },
              }
            : {}),
        });
      } catch {
        return { outcome: "reconciliation-required" as const, funding: claimed.state, quote };
      }
      const created = await command(
        input.fundingId,
        {
          type: "RecordCreated",
          processorPaymentReference: result.processorPaymentReference,
          processorRedirectUrl: result.processorRedirectUrl,
        },
        context,
      );
      return {
        outcome: "created" as const,
        funding: created.state,
        processorClientSecret: result.processorClientSecret,
        quote,
      };
    },
    async refund(
      input: Readonly<{ fundingId: WalletFundingId; accountId: AccountId; refundId: string; amount: string }>,
      context: EventStoreContext,
    ) {
      const amount = normalizeMoneyAmount(input.amount, { fieldName: "Refund amount" });
      await command(
        input.fundingId,
        { type: "RequestRefund", identity: { ...input, amount, currencyCode: "usd" }, at: now() },
        context,
      );
      return executeRefund(input.fundingId, input.refundId, context);
    },
    async processWebhook(event: PaymentProcessorWebhookEvent, context: EventStoreContext): Promise<boolean> {
      const fundingId = event.internalPaymentId?.startsWith("wfp_")
        ? (event.internalPaymentId as WalletFundingId)
        : await fundingIdForProcessorReference(deps.pool, event.processorPaymentReference);
      if (!fundingId) return false;
      let state = await stateFor(fundingId);
      fundingRule(state.quote, "funding_webhook_target_not_ready");
      if (!state.processorPaymentReference) {
        await command(
          fundingId,
          {
            type: "RecordCreated",
            processorPaymentReference: event.processorPaymentReference,
            processorRedirectUrl: null,
          },
          context,
        );
        state = await stateFor(fundingId);
      }
      fundingRule(
        state.processorPaymentReference === event.processorPaymentReference,
        "funding_provider_reference_conflict",
      );
      if (event.kind === "payment-refunded") {
        const status =
          event.processorStatus === "succeeded" ||
          event.processorStatus === "failed" ||
          event.processorStatus === "pending"
            ? event.processorStatus
            : event.processorStatus === "canceled" || event.processorStatus === "cancelled"
              ? "cancelled"
              : "unknown";
        if (!event.refundId || !event.processorRefundReference || !event.amount || event.currencyCode !== "usd") {
          await command(
            fundingId,
            {
              type: "RecordRefundAttention",
              attention: {
                reason: "unknown-refund-identity",
                observation: {
                  refundId: event.refundId ?? null,
                  processorRefundReference: event.processorRefundReference ?? null,
                  amount: event.amount ?? null,
                  currencyCode: event.currencyCode ?? null,
                  status,
                  evidenceId: event.eventId,
                  at: event.occurredAt,
                },
              },
            },
            context,
          );
          return true;
        }
        const observation: WalletFundingRefundObservation = {
          refundId: event.refundId,
          processorRefundReference: event.processorRefundReference,
          amount: event.amount,
          currencyCode: "usd",
          status,
          evidenceId: event.eventId,
          at: event.occurredAt,
        };
        const observed = await command(fundingId, { type: "ObserveRefund", observation }, context);
        const operation = observed.state.refunds[event.refundId];
        if (operation && !refundObservationConflict(operation, observation))
          await settle(fundingId, event.refundId, context);
      } else if (event.kind === "payment-disputed") {
        fundingRule(
          event.providerObjectReference &&
            event.amount &&
            event.disputeFeeAmount !== null &&
            event.disputeFeeAmount !== undefined &&
            event.disputeLifecycleState,
          "funding_dispute_evidence_incomplete",
        );
        await command(
          fundingId,
          {
            type: "RecordDispute",
            disputeId: event.providerObjectReference,
            lifecycle:
              event.disputeLifecycleState === "won" || event.disputeLifecycleState === "lost"
                ? event.disputeLifecycleState
                : "opened",
            amount: event.amount,
            feeAmount: event.disputeFeeAmount,
            at: event.occurredAt,
          },
          context,
        );
      } else if (event.kind === "payment-early-fraud-warning") {
        await command(
          fundingId,
          {
            type: "RecordFraudWarning",
            warningId: event.providerObjectReference ?? event.eventId,
            at: event.occurredAt,
          },
          context,
        );
      } else if (
        ["payment-authorized", "payment-captured", "payment-failed", "payment-cancelled"].includes(event.kind)
      ) {
        const outcome =
          event.kind === "payment-authorized"
            ? "authorized"
            : event.kind === "payment-captured"
              ? "captured"
              : event.kind === "payment-failed"
                ? "failed"
                : "cancelled";
        const observed = await command(
          fundingId,
          {
            type: "ObserveFunding",
            outcome,
            processorPaymentReference: event.processorPaymentReference,
            at: event.occurredAt,
          },
          context,
        );
        if (!observed.state.capturedAt && outcome === "cancelled")
          await releaseWalletFundingCreation(deps.pool, fundingId);
      }
      return true;
    },
    async reconcile(context: EventStoreContext) {
      const candidates = await deps.pool.query<{ funding_id: WalletFundingId }>(
        `SELECT c.funding_id FROM payments_wallet_funding_creation_reservations c
         LEFT JOIN payments_wallet_funding_pages p ON p.funding_id = c.funding_id
         WHERE p.funding_id IS NULL OR
           (p.state->>'capturedAt' IS NULL AND p.status NOT IN ('failed', 'cancelled')) OR
           (NOT c.released AND p.status IN ('failed', 'cancelled')) OR
           EXISTS (SELECT 1 FROM jsonb_each(p.state->'refunds') r WHERE r.value->>'status' NOT IN ('committed', 'released', 'refused')
             AND NOT (r.value->>'status' = 'intent' AND r.value->>'exception' IS NOT DISTINCT FROM 'authority-refused'))
         ORDER BY reconciled_at NULLS FIRST, created_at LIMIT 100`,
      );
      const attention: { fundingId: WalletFundingId; refundId?: string; classification: string }[] = [];
      let attentionCount = 0;
      const note = (fundingId: WalletFundingId, classification: string, refundId?: string) => {
        attentionCount += 1;
        if (attention.length < 100) attention.push({ fundingId, classification, ...(refundId ? { refundId } : {}) });
      };
      for (const { funding_id: fundingId } of candidates.rows) {
        try {
          let state = await stateFor(fundingId);
          if (!state.quote) {
            note(fundingId, "funding-intent-missing");
            continue;
          }
          const stale = Date.parse(now()) - Date.parse(state.quote.quotedAt) > 24 * 60 * 60 * 1000;
          if (stale && !state.submissionClaimed && state.status === "quoted") {
            state = (await command(fundingId, { type: "FailUnsubmitted", at: now() }, context)).state;
          }
          if (
            !state.capturedAt &&
            (state.status === "cancelled" ||
              (state.status === "failed" && !state.submissionClaimed && !state.processorPaymentReference))
          )
            await releaseWalletFundingCreation(deps.pool, fundingId);
          if (
            !state.capturedAt &&
            state.status !== "cancelled" &&
            (state.submissionClaimed || state.processorPaymentReference)
          ) {
            const result = state.processorPaymentReference
              ? await deps.processorGateway.retrievePaymentResult(state.processorPaymentReference)
              : await deps.processorGateway.retrievePaymentResultByPaymentId?.(fundingId);
            if (result) {
              await command(
                fundingId,
                {
                  type: "RecordCreated",
                  processorPaymentReference: result.processorPaymentReference,
                  processorRedirectUrl: null,
                },
                context,
              );
              let outcome = result.outcome;
              let cancelled = outcome === "cancelled";
              if ((outcome === "pending" || outcome === "failed") && stale) {
                const cancellation = await deps.processorGateway.cancelPayment(result.processorPaymentReference, {
                  kind: "ungoverned",
                });
                cancelled = cancellation.outcome === "cancelled";
                outcome = cancelled ? "failed" : cancellation.outcome;
              }
              if (outcome !== "pending" && outcome !== "unknown") {
                const observed = await command(
                  fundingId,
                  {
                    type: "ObserveFunding",
                    outcome,
                    processorPaymentReference: result.processorPaymentReference,
                    at: now(),
                    ...(cancelled && outcome === "failed" ? { reason: "stale_pending" as const } : {}),
                  },
                  context,
                );
                if (!observed.state.capturedAt && cancelled) await releaseWalletFundingCreation(deps.pool, fundingId);
              }
            } else note(fundingId, "funding-provider-outcome-unknown");
          }
          state = await stateFor(fundingId);
          for (const operation of Object.values(state.refunds)) {
            if (operation.status === "refused") continue;
            if (["submitting", "pending", "unknown"].includes(operation.status)) {
              const result = await deps.processorGateway.retrieveWalletFundingRefund?.({
                fundingId,
                refundId: operation.refundId,
                processorPaymentReference: state.processorPaymentReference!,
                processorRefundReference: operation.processorRefundReference,
              });
              if (
                result &&
                result.fundingId === fundingId &&
                result.refundId === operation.refundId &&
                result.processorPaymentReference === state.processorPaymentReference
              ) {
                await command(
                  fundingId,
                  {
                    type: "ObserveRefund",
                    observation: {
                      ...result,
                      evidenceId: `lookup:${result.processorRefundReference}:${result.status}`,
                      at: now(),
                    },
                  },
                  context,
                );
              } else note(fundingId, "refund-provider-outcome-unknown", operation.refundId);
            } else if (operation.status === "intent" || operation.status === "reserved") {
              await executeRefund(fundingId, operation.refundId, context);
            }
            const settled = await settle(fundingId, operation.refundId, context);
            if (settled.exception) note(fundingId, settled.exception, operation.refundId);
          }
        } catch {
          note(fundingId, "funding-reconciliation-required");
        } finally {
          await deps.pool.query(
            "UPDATE payments_wallet_funding_creation_reservations SET reconciled_at = now() WHERE funding_id = $1",
            [fundingId],
          );
        }
      }
      return { checked: candidates.rows.length, attention, attentionCount };
    },
  };
}
export type WalletFundingServices = ReturnType<typeof createWalletFundingRuntime>;
