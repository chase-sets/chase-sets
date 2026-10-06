import type { DomainEvent } from "@chase-sets/event-core/domain";
import type { AccountId, TypedUlid } from "@chase-sets/primitives/typed-ids";
import {
  addMoney,
  compareMoney,
  normalizeMoneyAmount,
  PaymentsDomainError,
} from "../../../support/runtime-support/common";
import {
  claimRefundSubmission,
  observeRefund,
  refundIntent,
  reserveRefund,
  settleRefundAuthority,
  normalizeRefundOperation,
  refundAttentionKey,
  refundObservationConflict,
  type WalletFundingRefundAttention,
  type WalletFundingRefundOperation,
  type WalletFundingRefundObservation,
} from "./refund-operation";
import {
  matchesPrepaidRefundIdentity,
  type PrepaidRefundIdentity,
  type PrepaidRefundReservation,
} from "../api/prepaid-refund-authority";

export type WalletFundingId = TypedUlid<"wfp">;
export type WalletFundingStatus =
  | "quoted"
  | "pending-confirmation"
  | "authorized"
  | "captured"
  | "partially-refunded"
  | "refunded"
  | "disputed"
  | "failed"
  | "cancelled";
export type WalletFundingAmounts = Readonly<{
  fundingId: WalletFundingId;
  accountId: AccountId;
  requestedAmount: string;
  feeAmount: string;
  grossAmount: string;
  currencyCode: "usd";
}>;
export type WalletFundingQuote = WalletFundingAmounts &
  Readonly<{
    quoteFingerprint: string;
    quotedAt: string;
    savedInstrumentId: string | null;
  }>;
export type WalletFundingFact = WalletFundingAmounts &
  Readonly<{
    processorPaymentReference: string | null;
    occurredAt: string;
  }>;
export type WalletFundingRefundFact = WalletFundingFact &
  Readonly<{
    refundId: string;
    refundAmount: string;
    reservationId: string;
    processorRefundReference: string;
    factId: string;
  }>;
export type WalletFundingDisputeFact = WalletFundingFact &
  Readonly<{
    disputeId: string;
    lifecycle: "opened" | "won" | "lost";
    disputeAmount: string;
    disputeFeeAmount: string;
  }>;
export type WalletFundingState = Readonly<{
  quote: WalletFundingQuote | null;
  status: WalletFundingStatus | null;
  processorPaymentReference: string | null;
  processorRedirectUrl: string | null;
  submissionClaimed: boolean;
  capturedAt: string | null;
  refundedAmount: string;
  refunds: Readonly<Record<string, WalletFundingRefundOperation>>;
  refundAttention: readonly WalletFundingRefundAttention[];
  disputes: Readonly<Record<string, "opened" | "won" | "lost">>;
  fraudWarningIds: readonly string[];
}>;
export const initialWalletFundingState: WalletFundingState = {
  quote: null,
  status: null,
  processorPaymentReference: null,
  processorRedirectUrl: null,
  submissionClaimed: false,
  capturedAt: null,
  refundedAmount: "0.00",
  refunds: {},
  refundAttention: [],
  disputes: {},
  fraudWarningIds: [],
};
export type WalletFundingEvent =
  | DomainEvent<"payments.wallet-funding-quoted", WalletFundingQuote>
  | DomainEvent<"payments.wallet-funding-submission-claimed", Readonly<{ at: string }>>
  | DomainEvent<
      "payments.wallet-funding-created",
      Readonly<{ processorPaymentReference: string; processorRedirectUrl: string | null }>
    >
  | DomainEvent<"payments.wallet-funding-authorized", WalletFundingFact>
  | DomainEvent<"payments.wallet-funding-captured", WalletFundingFact>
  | DomainEvent<"payments.wallet-funding-failed", WalletFundingFact & Readonly<{ reason: string }>>
  | DomainEvent<"payments.wallet-funding-cancelled", WalletFundingFact>
  | DomainEvent<"payments.wallet-funding-refund-operation-recorded", WalletFundingRefundOperation>
  | DomainEvent<"payments.wallet-funding-refund-attention-recorded", WalletFundingRefundAttention>
  | DomainEvent<"payments.wallet-funding-refunded", WalletFundingRefundFact>
  | DomainEvent<"payments.wallet-funding-dispute-recorded", WalletFundingDisputeFact>
  | DomainEvent<"payments.wallet-funding-fraud-warning-recorded", WalletFundingFact & Readonly<{ warningId: string }>>;

export type WalletFundingCommand =
  | Readonly<{ type: "Quote"; quote: WalletFundingQuote }>
  | Readonly<{ type: "ClaimCreation"; at: string }>
  | Readonly<{ type: "FailUnsubmitted"; at: string }>
  | Readonly<{ type: "RecordCreated"; processorPaymentReference: string; processorRedirectUrl: string | null }>
  | Readonly<{
      type: "ObserveFunding";
      outcome: "authorized" | "captured" | "failed" | "cancelled";
      processorPaymentReference: string;
      at: string;
      reason?: "stale_pending";
    }>
  | Readonly<{
      type: "RecordDispute";
      disputeId: string;
      lifecycle: "opened" | "won" | "lost";
      amount: string;
      feeAmount: string;
      at: string;
    }>
  | Readonly<{ type: "RecordFraudWarning"; warningId: string; at: string }>
  | Readonly<{ type: "RequestRefund"; identity: PrepaidRefundIdentity; at: string }>
  | Readonly<{ type: "ReserveRefund"; reservation: PrepaidRefundReservation; at: string }>
  | Readonly<{ type: "ClaimRefundSubmission"; refundId: string; at: string }>
  | Readonly<{ type: "ObserveRefund"; observation: WalletFundingRefundObservation }>
  | Readonly<{ type: "RecordRefundAttention"; attention: WalletFundingRefundAttention }>
  | Readonly<{ type: "SettleRefundAuthority"; refundId: string; outcome: "committed" | "released"; at: string }>
  | Readonly<{
      type: "RecordRefundException";
      refundId: string;
      exception: WalletFundingRefundOperation["exception"];
      at: string;
    }>;

export function fundingRule(condition: unknown, code: string): asserts condition {
  if (!condition) throw new PaymentsDomainError(code, code);
}
function fact(state: WalletFundingState, at: string): WalletFundingFact {
  fundingRule(state.quote, "funding_quote_required");
  const { fundingId, accountId, requestedAmount, feeAmount, grossAmount, currencyCode } = state.quote;
  return {
    fundingId,
    accountId,
    requestedAmount,
    feeAmount,
    grossAmount,
    currencyCode,
    processorPaymentReference: state.processorPaymentReference,
    occurredAt: at,
  };
}
function capturedStatus(state: WalletFundingState): WalletFundingStatus {
  return state.refundedAmount === state.quote?.requestedAmount
    ? "refunded"
    : state.refundedAmount === "0.00"
      ? "captured"
      : "partially-refunded";
}
export function evolveWalletFunding(state: WalletFundingState, event: WalletFundingEvent): WalletFundingState {
  switch (event.type) {
    case "payments.wallet-funding-quoted":
      return { ...state, quote: event.data, status: "quoted" };
    case "payments.wallet-funding-submission-claimed":
      return { ...state, submissionClaimed: true };
    case "payments.wallet-funding-created":
      return { ...state, ...event.data, status: state.status === "quoted" ? "pending-confirmation" : state.status };
    case "payments.wallet-funding-authorized":
      return { ...state, status: "authorized" };
    case "payments.wallet-funding-captured":
      return {
        ...state,
        capturedAt: event.data.occurredAt,
        status: Object.values(state.disputes).some((s) => s !== "won") ? "disputed" : capturedStatus(state),
      };
    case "payments.wallet-funding-failed":
      return { ...state, status: "failed" };
    case "payments.wallet-funding-cancelled":
      return { ...state, status: "cancelled" };
    case "payments.wallet-funding-refund-operation-recorded":
      return { ...state, refunds: { ...state.refunds, [event.data.refundId]: normalizeRefundOperation(event.data) } };
    case "payments.wallet-funding-refund-attention-recorded":
      return (state.refundAttention ?? []).some((entry) => refundAttentionKey(entry) === refundAttentionKey(event.data))
        ? state
        : { ...state, refundAttention: [...(state.refundAttention ?? []), event.data] };
    case "payments.wallet-funding-refunded": {
      const next = { ...state, refundedAmount: addMoney(state.refundedAmount, event.data.refundAmount) };
      return { ...next, status: state.status === "disputed" ? "disputed" : capturedStatus(next) };
    }
    case "payments.wallet-funding-dispute-recorded": {
      const next = { ...state, disputes: { ...state.disputes, [event.data.disputeId]: event.data.lifecycle } };
      return {
        ...next,
        status: Object.values(next.disputes).some((s) => s !== "won") ? "disputed" : capturedStatus(next),
      };
    }
    case "payments.wallet-funding-fraud-warning-recorded":
      return { ...state, fraudWarningIds: [...state.fraudWarningIds, event.data.warningId] };
  }
}

export function decideWalletFunding(
  state: WalletFundingState,
  command: WalletFundingCommand,
): readonly WalletFundingEvent[] {
  if (command.type === "Quote") {
    const quote = command.quote;
    fundingRule(
      quote.fundingId.startsWith("wfp_") && quote.accountId.startsWith("acc_") && quote.currencyCode === "usd",
      "funding_identity_invalid",
    );
    for (const key of ["requestedAmount", "feeAmount", "grossAmount"] as const) {
      fundingRule(
        normalizeMoneyAmount(quote[key], { fieldName: key, allowZero: key === "feeAmount" }) === quote[key],
        "funding_amount_invalid",
      );
    }
    fundingRule(
      addMoney(quote.requestedAmount, quote.feeAmount) === quote.grossAmount && quote.quoteFingerprint.length > 0,
      "funding_gross_invalid",
    );
    if (state.quote) {
      for (const key of [
        "fundingId",
        "accountId",
        "requestedAmount",
        "feeAmount",
        "grossAmount",
        "currencyCode",
        "quoteFingerprint",
        "savedInstrumentId",
      ] as const) {
        fundingRule(state.quote[key] === quote[key], "funding_identity_conflict");
      }
      return [];
    }
    return [{ type: "payments.wallet-funding-quoted", data: quote }];
  }
  fundingRule(state.quote, "funding_not_found");
  if (command.type === "ClaimCreation") {
    if (state.submissionClaimed) return [];
    fundingRule(state.status === "quoted", "funding_creation_terminal");
    return [{ type: "payments.wallet-funding-submission-claimed", data: { at: command.at } }];
  }
  if (command.type === "FailUnsubmitted") {
    if (state.submissionClaimed || state.status !== "quoted") return [];
    return [{ type: "payments.wallet-funding-failed", data: { ...fact(state, command.at), reason: "stale_pending" } }];
  }
  if (command.type === "RecordCreated") {
    fundingRule(command.processorPaymentReference.trim(), "funding_provider_reference_required");
    if (state.processorPaymentReference) {
      fundingRule(
        state.processorPaymentReference === command.processorPaymentReference,
        "funding_provider_reference_conflict",
      );
      return [];
    }
    return [
      {
        type: "payments.wallet-funding-created",
        data: {
          processorPaymentReference: command.processorPaymentReference,
          processorRedirectUrl: command.processorRedirectUrl,
        },
      },
    ];
  }
  if (command.type === "ObserveFunding") {
    fundingRule(
      command.processorPaymentReference === state.processorPaymentReference,
      "funding_provider_reference_conflict",
    );
    if (command.outcome === "captured")
      return state.capturedAt ? [] : [{ type: "payments.wallet-funding-captured", data: fact(state, command.at) }];
    if (
      state.capturedAt ||
      state.status === command.outcome ||
      state.status === "failed" ||
      state.status === "cancelled"
    )
      return [];
    if (command.outcome === "authorized")
      return [{ type: "payments.wallet-funding-authorized", data: fact(state, command.at) }];
    if (command.outcome === "failed")
      return [
        {
          type: "payments.wallet-funding-failed",
          data: { ...fact(state, command.at), reason: command.reason ?? "provider_failed" },
        },
      ];
    return [{ type: "payments.wallet-funding-cancelled", data: fact(state, command.at) }];
  }
  if (command.type === "RecordDispute") {
    const prior = state.disputes[command.disputeId];
    if (prior === command.lifecycle || (prior && prior !== "opened" && command.lifecycle === "opened")) return [];
    fundingRule(!prior || prior === "opened", "funding_dispute_outcome_conflict");
    const amount = normalizeMoneyAmount(command.amount, { fieldName: "Dispute principal" });
    const fee = normalizeMoneyAmount(command.feeAmount, { fieldName: "Dispute fee", allowZero: true });
    return [
      {
        type: "payments.wallet-funding-dispute-recorded",
        data: {
          ...fact(state, command.at),
          disputeId: command.disputeId,
          lifecycle: command.lifecycle,
          disputeAmount: amount,
          disputeFeeAmount: fee,
        },
      },
    ];
  }
  if (command.type === "RecordFraudWarning")
    return state.fraudWarningIds.includes(command.warningId)
      ? []
      : [
          {
            type: "payments.wallet-funding-fraud-warning-recorded",
            data: { ...fact(state, command.at), warningId: command.warningId },
          },
        ];
  if (command.type === "RequestRefund") {
    fundingRule(/^wfr_[A-Za-z0-9_-]{1,100}$/.test(command.identity.refundId), "refund_identity_invalid");
    const prior = state.refunds[command.identity.refundId];
    if (prior) {
      fundingRule(matchesPrepaidRefundIdentity(prior, command.identity), "refund_identity_conflict");
      return [];
    }
    fundingRule(
      command.identity.accountId === state.quote.accountId &&
        command.identity.fundingId === state.quote.fundingId &&
        command.identity.currencyCode === state.quote.currencyCode,
      "refund_identity_conflict",
    );
    fundingRule(state.status === "captured" || state.status === "partially-refunded", "funding_not_refundable");
    const amount = normalizeMoneyAmount(command.identity.amount, { fieldName: "Refund amount" });
    fundingRule(amount === command.identity.amount, "refund_amount_invalid");
    // This is only a processor/principal cap. Settlement must separately reserve unspent money.
    const pending = Object.values(state.refunds)
      .filter((r) => r.status !== "released" && r.status !== "refused")
      .reduce((sum, r) => addMoney(sum, r.amount), "0.00");
    fundingRule(
      compareMoney(addMoney(pending, amount), state.quote.requestedAmount) <= 0,
      "funding_refund_exceeds_requested",
    );
    return [
      { type: "payments.wallet-funding-refund-operation-recorded", data: refundIntent(command.identity, command.at) },
    ];
  }
  const attentionEvents = (attention: WalletFundingRefundAttention): readonly WalletFundingEvent[] =>
    (state.refundAttention ?? []).some((entry) => refundAttentionKey(entry) === refundAttentionKey(attention))
      ? []
      : [{ type: "payments.wallet-funding-refund-attention-recorded", data: attention }];
  if (command.type === "RecordRefundAttention") return attentionEvents(command.attention);
  const refundId =
    command.type === "ReserveRefund"
      ? command.reservation.refundId
      : command.type === "ObserveRefund"
        ? command.observation.refundId
        : command.refundId;
  const prior = state.refunds[refundId];
  if (command.type === "ObserveRefund") {
    const reason = prior ? refundObservationConflict(prior, command.observation) : "unknown-refund-identity";
    if (reason) return attentionEvents({ reason, observation: command.observation });
  }
  fundingRule(prior, "refund_not_found");
  if (command.type === "ReserveRefund" && prior.status === "refused") {
    reserveRefund(prior, command.reservation, command.at);
    return attentionEvents({ reason: "reservation-after-refusal", reservation: command.reservation, at: command.at });
  }
  if (
    command.type === "RecordRefundException" &&
    (prior.status === "committed" ||
      prior.status === "released" ||
      prior.status === "refused" ||
      ((command.exception === "authority-refused" || command.exception === "malformed-grant") &&
        prior.status !== "intent"))
  )
    return [];
  const next =
    command.type === "ReserveRefund"
      ? reserveRefund(prior, command.reservation, command.at)
      : command.type === "ClaimRefundSubmission"
        ? claimRefundSubmission(prior, command.at)
        : command.type === "ObserveRefund"
          ? observeRefund(prior, command.observation)
          : command.type === "SettleRefundAuthority"
            ? settleRefundAuthority(prior, command.outcome, command.at)
            : {
                ...prior,
                status:
                  prior.status === "intent" &&
                  (command.exception === "authority-refused" || command.exception === "malformed-grant")
                    ? ("refused" as const)
                    : prior.status === "submitting" && command.exception === "provider-outcome-unknown"
                      ? ("unknown" as const)
                      : prior.status,
                exception: command.exception,
                updatedAt: command.at,
              };
  if (next === prior || JSON.stringify(next) === JSON.stringify(prior)) return [];
  const events: WalletFundingEvent[] = [{ type: "payments.wallet-funding-refund-operation-recorded", data: next }];
  if (next.status === "success-awaiting-commit" && prior.status !== "success-awaiting-commit") {
    fundingRule(next.reservationId && next.processorRefundReference, "refund_success_identity_required");
    events.push({
      type: "payments.wallet-funding-refunded",
      data: {
        ...fact(state, next.updatedAt),
        refundId,
        refundAmount: next.amount,
        reservationId: next.reservationId,
        processorRefundReference: next.processorRefundReference,
        factId: `payments.wallet-funding-refunded:${state.quote.fundingId}:${refundId}`,
      },
    });
  }
  return events;
}
