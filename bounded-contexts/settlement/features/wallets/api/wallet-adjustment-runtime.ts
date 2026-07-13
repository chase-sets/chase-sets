import { createHash } from "node:crypto";
import { createAggregateCommandHandler } from "@chase-sets/event-core/aggregate-command-handler";
import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import type { EventStore } from "@chase-sets/event-core/event-store";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { parseTypedId } from "@chase-sets/primitives/typed-ids";
import type { AccountId, LedgerEntryId, UserId, WalletAdjustmentId } from "@chase-sets/primitives/typed-ids";
import type { SettlementWalletRow } from "../read-model/queries";
import type { WalletServices } from "./runtime";
import {
  availableBalanceBeforePosting,
  decideWalletAdjustment,
  evolveWalletAdjustment,
  initialWalletAdjustmentState,
  WALLET_ADJUSTMENT_CONTROLS_DEFAULT,
  type WalletAdjustmentControls,
  type WalletAdjustmentEvent,
  type WalletAdjustmentReasonCode,
  type WalletAdjustmentState,
} from "../domain/wallet-adjustment";
import {
  buildWalletAdjustmentPreview,
  computeWalletBalanceRevision,
  type WalletAdjustmentPreview,
} from "./wallet-adjustment-preview";
import {
  getWalletAdjustment,
  listIncompleteWalletAdjustments,
  listWalletAdjustments,
  type SettlementWalletAdjustmentRow,
} from "../read-model/wallet-adjustment-queries";
import {
  compareMoney,
  normalizeCurrencyCode,
  normalizeLedgerEntryDirection,
  normalizeMoneyAmount,
  SettlementDomainError,
  subtractMoney,
  type CurrencyCode,
  type LedgerEntryDirection,
} from "../../../support/runtime-support/common";

const MAX_CONCURRENCY_RETRIES = 5;

/**
 * Raised when an operator confirms a Wallet Adjustment against a balance
 * revision that no longer matches the authoritative wallet -- the balance moved
 * between preview and confirmation. The API surface maps this to a 409 so the
 * operator re-previews rather than posting against unseen state.
 */
export class StaleWalletBalanceError extends Error {
  public readonly code = "stale_balance_revision" as const;
  public constructor(
    public readonly expectedBalanceRevision: string,
    public readonly currentBalanceRevision: string,
  ) {
    super("Wallet balance changed since preview; re-preview before confirming this adjustment.");
    this.name = "StaleWalletBalanceError";
  }
}

function isConcurrencyConflict(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "concurrency_conflict";
}

function isLedgerEntryAlreadyPosted(error: unknown): boolean {
  return error instanceof Error && error.message === "Ledger entry has already been posted.";
}

function adjustmentStreamId(adjustmentId: WalletAdjustmentId): string {
  return `settlement.wallet-adjustment-${adjustmentId}`;
}

function digest(prefix: "wad" | "led", value: string): string {
  const hex = createHash("sha256").update(value, "utf8").digest("hex").slice(0, 26);
  return `${prefix}_${hex}`;
}

/**
 * Deterministic, server-scoped adjustment identity. The target account is
 * folded into the hash so the same operator idempotency value used against two
 * different accounts can never collide onto one adjustment.
 */
export function deriveWalletAdjustmentId(idempotencyKey: string, targetAccountId: AccountId): WalletAdjustmentId {
  return parseTypedId(digest("wad", `${targetAccountId}:${idempotencyKey}`), "wad");
}

/** Deterministic ledger-entry identity for an adjustment's single posting. */
function deriveLedgerEntryId(adjustmentId: WalletAdjustmentId): LedgerEntryId {
  return parseTypedId(digest("led", `${adjustmentId}:ledger`), "led");
}

function ledgerDescription(reasonCode: WalletAdjustmentReasonCode, explanation: string | null): string {
  const base = `Wallet adjustment: ${reasonCode}`;
  return explanation ? `${base} -- ${explanation}` : base;
}

export type WalletAdjustmentSnapshot = SettlementWalletAdjustmentRow;

export type RequestWalletAdjustmentInput = Readonly<{
  idempotencyKey: string;
  targetAccountId: AccountId;
  direction: LedgerEntryDirection;
  amount: string;
  currencyCode?: CurrencyCode;
  reasonCode: WalletAdjustmentReasonCode;
  explanation?: string | null;
  evidenceReferences?: readonly string[];
  requestedBy: UserId;
  requestedAt?: string;
  selfBenefiting: boolean;
  reversalOfAdjustmentId?: WalletAdjustmentId | null;
  /** When present, the request is rejected unless the authoritative wallet still matches the previewed balance. */
  expectedBalanceRevision?: string | null;
}>;

export type PreviewWalletAdjustmentInput = Readonly<{
  targetAccountId: AccountId;
  direction: LedgerEntryDirection;
  amount: string;
  currencyCode?: CurrencyCode;
  reasonCode: WalletAdjustmentReasonCode;
  selfBenefiting: boolean;
  controls?: WalletAdjustmentControls;
}>;

export type ApproveWalletAdjustmentInput = Readonly<{
  adjustmentId: WalletAdjustmentId;
  approvedBy: UserId;
  approvedAt?: string;
  controls?: WalletAdjustmentControls;
  elevationApprovedBy?: UserId | null;
}>;

export type RejectWalletAdjustmentInput = Readonly<{
  adjustmentId: WalletAdjustmentId;
  rejectedBy: UserId;
  rejectedAt?: string;
  rejectionReason?: string | null;
}>;

export type PostWalletAdjustmentInput = Readonly<{
  adjustmentId: WalletAdjustmentId;
  postedAt?: string;
}>;

export type ReverseWalletAdjustmentInput = Readonly<{
  adjustmentId: WalletAdjustmentId;
  requestedBy: UserId;
  approvedBy: UserId;
  elevationApprovedBy: UserId;
  controls?: WalletAdjustmentControls;
  explanation?: string | null;
  reversedAt?: string;
}>;

export type WalletAdjustmentServices = Readonly<{
  deriveAdjustmentId: (idempotencyKey: string, targetAccountId: AccountId) => WalletAdjustmentId;
  /** Authoritative, projection-independent preview of a proposed adjustment's balance and governance consequence. */
  preview: (input: PreviewWalletAdjustmentInput) => Promise<WalletAdjustmentPreview>;
  /** The target account's authoritative wallet summary for the operator adjustment surface. */
  getAccountSummary: (accountId: string) => Promise<SettlementWalletRow>;
  request: (input: RequestWalletAdjustmentInput, context: EventStoreContext) => Promise<WalletAdjustmentSnapshot>;
  approve: (input: ApproveWalletAdjustmentInput, context: EventStoreContext) => Promise<WalletAdjustmentSnapshot>;
  reject: (input: RejectWalletAdjustmentInput, context: EventStoreContext) => Promise<WalletAdjustmentSnapshot>;
  post: (input: PostWalletAdjustmentInput, context: EventStoreContext) => Promise<WalletAdjustmentSnapshot>;
  /** Approve, then immediately post: the common operator path with a single durable retry point. */
  approveAndPost: (
    input: ApproveWalletAdjustmentInput,
    context: EventStoreContext,
  ) => Promise<WalletAdjustmentSnapshot>;
  reverse: (
    input: ReverseWalletAdjustmentInput,
    context: EventStoreContext,
  ) => Promise<Readonly<{ original: WalletAdjustmentSnapshot; reversal: WalletAdjustmentSnapshot }>>;
  getAdjustment: (adjustmentId: string) => Promise<SettlementWalletAdjustmentRow | null>;
  listAdjustments: (
    params?: Readonly<{
      targetAccountId?: string;
      status?: SettlementWalletAdjustmentRow["status"];
      limit?: number;
      offset?: number;
    }>,
  ) => Promise<{ items: SettlementWalletAdjustmentRow[]; total: number }>;
  listIncompleteAdjustments: (params?: Readonly<{ limit?: number }>) => Promise<SettlementWalletAdjustmentRow[]>;
}>;

type WalletAdjustmentRuntimeDeps = Readonly<{
  eventStore: EventStore;
  db: PgQueryable;
  wallets: WalletServices;
}>;

/** Command-owned snapshot so immediate UI does not depend on projection convergence. */
function snapshotFromState(state: WalletAdjustmentState): WalletAdjustmentSnapshot {
  if (state.adjustmentId === null || state.status === null) {
    throw new SettlementDomainError("Wallet Adjustment does not exist.");
  }
  return {
    adjustment_id: state.adjustmentId,
    status: state.status,
    target_account_id: state.targetAccountId as AccountId,
    direction: state.direction as LedgerEntryDirection,
    amount: state.amount as string,
    currency_code: state.currencyCode as CurrencyCode,
    reason_code: state.reasonCode as WalletAdjustmentReasonCode,
    explanation: state.explanation,
    evidence_references: state.evidenceReferences,
    reversal_of_adjustment_id: state.reversalOfAdjustmentId,
    reversed_by_adjustment_id: state.reversedByAdjustmentId,
    requested_by: state.requestedBy as UserId,
    requested_at: state.requestedAt as string,
    self_benefiting: state.selfBenefiting,
    approved_by: state.approvedBy,
    approved_at: state.approvedAt,
    elevation_required: state.elevationRequired,
    elevation_reasons: state.elevationReasons,
    elevation_approved_by: state.elevationApprovedBy,
    creates_or_increases_negative_balance: state.createsOrIncreasesNegativeBalance,
    reversal_after_funds_settled: state.reversalAfterFundsSettled,
    high_value_credit_threshold_amount: state.controls?.highValueCreditThresholdAmount ?? null,
    high_value_debit_threshold_amount: state.controls?.highValueDebitThresholdAmount ?? null,
    recent_auth_max_age_minutes: state.controls?.recentAuthMaxAgeMinutes ?? null,
    rejected_by: state.rejectedBy,
    rejected_at: state.rejectedAt,
    rejection_reason: state.rejectionReason,
    posted_ledger_entry_id: state.postedLedgerEntryId,
    posted_at: state.postedAt,
    available_balance_before: state.availableBalanceBefore,
    available_balance_after: state.availableBalanceAfter,
    reversed_at: state.reversedAt,
    updated_at: state.updatedAt as string,
  };
}

export function createWalletAdjustmentRuntime(deps: WalletAdjustmentRuntimeDeps): WalletAdjustmentServices {
  const { commandHandler, repository } = createAggregateCommandHandler({
    eventStore: deps.eventStore,
    codec: createPassthroughDomainEventCodec<WalletAdjustmentEvent>(),
    initialState: () => initialWalletAdjustmentState,
    evolve: evolveWalletAdjustment,
    decide: decideWalletAdjustment,
  });

  async function loadState(adjustmentId: WalletAdjustmentId): Promise<WalletAdjustmentState> {
    const loaded = await repository.load(adjustmentStreamId(adjustmentId));
    return loaded.state;
  }

  async function runCommand(
    adjustmentId: WalletAdjustmentId,
    command: Parameters<typeof decideWalletAdjustment>[1],
    context: EventStoreContext,
  ): Promise<WalletAdjustmentState> {
    for (let attempt = 0; attempt < MAX_CONCURRENCY_RETRIES; attempt += 1) {
      try {
        const result = await commandHandler({
          streamId: adjustmentStreamId(adjustmentId),
          command,
          context,
        });
        return result.state;
      } catch (error) {
        if (!isConcurrencyConflict(error)) {
          throw error;
        }
      }
    }
    throw new SettlementDomainError(
      "Wallet Adjustment command could not be serialized after repeated concurrent writes.",
    );
  }

  async function request(
    input: RequestWalletAdjustmentInput,
    context: EventStoreContext,
  ): Promise<WalletAdjustmentSnapshot> {
    const adjustmentId = deriveWalletAdjustmentId(input.idempotencyKey, input.targetAccountId);
    // Confirm the operator is acting on the balance they previewed. A duplicate
    // retry of an already-recorded adjustment is exempt: the request is an
    // idempotent no-op, so an intervening balance move must not turn a
    // successful retry into a spurious conflict.
    if (input.expectedBalanceRevision) {
      const existing = await loadState(adjustmentId);
      if (existing.status === null) {
        const wallet = await deps.wallets.loadWalletState(input.targetAccountId);
        const currentRevision = computeWalletBalanceRevision(wallet);
        if (currentRevision !== input.expectedBalanceRevision) {
          throw new StaleWalletBalanceError(input.expectedBalanceRevision, currentRevision);
        }
      }
    }
    const state = await runCommand(
      adjustmentId,
      {
        type: "RequestWalletAdjustment",
        adjustmentId,
        targetAccountId: input.targetAccountId,
        direction: normalizeLedgerEntryDirection(input.direction),
        amount: input.amount,
        currencyCode: normalizeCurrencyCode(input.currencyCode ?? "usd"),
        reasonCode: input.reasonCode,
        explanation: input.explanation ?? null,
        evidenceReferences: input.evidenceReferences ?? [],
        requestedBy: input.requestedBy,
        requestedAt: input.requestedAt ?? new Date().toISOString(),
        selfBenefiting: input.selfBenefiting,
        reversalOfAdjustmentId: input.reversalOfAdjustmentId ?? null,
      },
      context,
    );
    return snapshotFromState(state);
  }

  /**
   * Computes whether posting this adjustment as an available entry would create
   * or deepen a negative balance, from the authoritative wallet aggregate state.
   */
  async function projectsNegativeBalance(
    targetAccountId: AccountId,
    direction: LedgerEntryDirection,
    amount: string,
  ): Promise<boolean> {
    if (direction === "credit") {
      return false;
    }
    const wallet = await deps.wallets.loadWalletState(targetAccountId);
    const projectedAvailable = subtractMoney(wallet.availableBalanceAmount, amount);
    return compareMoney(projectedAvailable, "0.00") < 0;
  }

  async function approve(
    input: ApproveWalletAdjustmentInput,
    context: EventStoreContext,
  ): Promise<WalletAdjustmentSnapshot> {
    const current = await loadState(input.adjustmentId);
    if (current.status === null) {
      throw new SettlementDomainError("Wallet Adjustment does not exist.");
    }
    const createsOrIncreasesNegativeBalance = await projectsNegativeBalance(
      current.targetAccountId as AccountId,
      current.direction as LedgerEntryDirection,
      current.amount as string,
    );
    const reversalAfterFundsSettled = current.reversalOfAdjustmentId !== null;
    const state = await runCommand(
      input.adjustmentId,
      {
        type: "ApproveWalletAdjustment",
        approvedBy: input.approvedBy,
        approvedAt: input.approvedAt ?? new Date().toISOString(),
        controls: input.controls ?? WALLET_ADJUSTMENT_CONTROLS_DEFAULT,
        createsOrIncreasesNegativeBalance,
        reversalAfterFundsSettled,
        elevationApprovedBy: input.elevationApprovedBy ?? null,
      },
      context,
    );
    return snapshotFromState(state);
  }

  async function reject(
    input: RejectWalletAdjustmentInput,
    context: EventStoreContext,
  ): Promise<WalletAdjustmentSnapshot> {
    const state = await runCommand(
      input.adjustmentId,
      {
        type: "RejectWalletAdjustment",
        rejectedBy: input.rejectedBy,
        rejectedAt: input.rejectedAt ?? new Date().toISOString(),
        rejectionReason: input.rejectionReason ?? null,
      },
      context,
    );
    return snapshotFromState(state);
  }

  /**
   * Posts the approved adjustment's single wallet ledger entry, then records
   * the adjustment as posted. Deterministic and idempotent end to end: the
   * ledger-entry identity dedupes the balance effect, and a retry after the
   * balance already moved reconstructs the before/after snapshot from the
   * authoritative post-state. An approved-but-unposted adjustment stays visible
   * (see listIncompleteAdjustments) until this completes.
   */
  async function post(input: PostWalletAdjustmentInput, context: EventStoreContext): Promise<WalletAdjustmentSnapshot> {
    const current = await loadState(input.adjustmentId);
    if (current.status === "posted" || current.status === "reversed") {
      return snapshotFromState(current);
    }
    if (current.status !== "approved") {
      throw new SettlementDomainError("Only an approved Wallet Adjustment can be posted.");
    }

    const targetAccountId = current.targetAccountId as AccountId;
    const direction = current.direction as LedgerEntryDirection;
    const amount = current.amount as string;
    const ledgerEntryId = deriveLedgerEntryId(input.adjustmentId);
    const postedAt = input.postedAt ?? new Date().toISOString();

    try {
      await deps.wallets.postEntry(
        {
          accountId: targetAccountId,
          ledgerEntryId,
          kind: "adjustment",
          direction,
          amount,
          currencyCode: current.currencyCode as CurrencyCode,
          fundsStatus: "available",
          description: ledgerDescription(current.reasonCode as WalletAdjustmentReasonCode, current.explanation),
          postedAt,
          allowNegativeBalance: current.createsOrIncreasesNegativeBalance,
        },
        context,
      );
    } catch (error) {
      if (!isLedgerEntryAlreadyPosted(error)) {
        throw error;
      }
      // Idempotent: the deterministic ledger entry was already posted on a prior attempt.
    }

    const walletAfter = await deps.wallets.loadWalletState(targetAccountId);
    const availableBalanceAfter = walletAfter.availableBalanceAmount;
    const availableBalanceBefore = availableBalanceBeforePosting(availableBalanceAfter, direction, amount);

    const state = await runCommand(
      input.adjustmentId,
      {
        type: "PostWalletAdjustment",
        ledgerEntryId,
        postedAt,
        availableBalanceBefore,
        availableBalanceAfter,
      },
      context,
    );
    return snapshotFromState(state);
  }

  async function approveAndPost(
    input: ApproveWalletAdjustmentInput,
    context: EventStoreContext,
  ): Promise<WalletAdjustmentSnapshot> {
    await approve(input, context);
    return post({ adjustmentId: input.adjustmentId }, context);
  }

  async function reverse(
    input: ReverseWalletAdjustmentInput,
    context: EventStoreContext,
  ): Promise<Readonly<{ original: WalletAdjustmentSnapshot; reversal: WalletAdjustmentSnapshot }>> {
    const original = await loadState(input.adjustmentId);
    if (original.status !== "posted" && original.status !== "reversed") {
      throw new SettlementDomainError("Only a posted Wallet Adjustment can be reversed.");
    }

    const targetAccountId = original.targetAccountId as AccountId;
    const reversalIdempotencyKey = `${input.adjustmentId}:reversal`;
    const reversalAdjustmentId =
      original.reversedByAdjustmentId ?? deriveWalletAdjustmentId(reversalIdempotencyKey, targetAccountId);
    const reversedAt = input.reversedAt ?? new Date().toISOString();
    const oppositeDirection: LedgerEntryDirection = original.direction === "credit" ? "debit" : "credit";

    // The linked, opposite-direction Wallet Adjustment runs its own governed
    // request -> approve -> post lifecycle. Reversing an already-settled entry
    // is elevated by construction and may drive the balance negative. Each step
    // is idempotent, so a retried reversal converges without re-posting.
    const reversalState = await loadState(reversalAdjustmentId);
    if (reversalState.status === null || reversalState.status === "requested" || reversalState.status === "approved") {
      await request(
        {
          idempotencyKey: reversalIdempotencyKey,
          targetAccountId,
          direction: oppositeDirection,
          amount: original.amount as string,
          currencyCode: original.currencyCode as CurrencyCode,
          reasonCode: original.reasonCode as WalletAdjustmentReasonCode,
          explanation: input.explanation ?? `Reversal of ${input.adjustmentId}`,
          requestedBy: input.requestedBy,
          selfBenefiting: false,
          reversalOfAdjustmentId: input.adjustmentId,
        },
        context,
      );
      await approve(
        {
          adjustmentId: reversalAdjustmentId,
          approvedBy: input.approvedBy,
          controls: input.controls ?? WALLET_ADJUSTMENT_CONTROLS_DEFAULT,
          elevationApprovedBy: input.elevationApprovedBy,
        },
        context,
      );
    }
    const reversalSnapshot = await post({ adjustmentId: reversalAdjustmentId }, context);

    const originalState = await runCommand(
      input.adjustmentId,
      {
        type: "ReverseWalletAdjustment",
        reversalAdjustmentId,
        reversedBy: input.requestedBy,
        reversedAt,
      },
      context,
    );

    return { original: snapshotFromState(originalState), reversal: reversalSnapshot };
  }

  async function preview(input: PreviewWalletAdjustmentInput): Promise<WalletAdjustmentPreview> {
    const wallet = await deps.wallets.loadWalletState(input.targetAccountId);
    return buildWalletAdjustmentPreview(wallet, {
      direction: normalizeLedgerEntryDirection(input.direction),
      amount: normalizeMoneyAmount(input.amount, { fieldName: "Wallet Adjustment amount" }),
      currencyCode: normalizeCurrencyCode(input.currencyCode ?? "usd"),
      reasonCode: input.reasonCode,
      selfBenefiting: input.selfBenefiting,
      // A first-class adjustment (not a reversal) never carries the
      // reversal-after-settlement elevation reason.
      reversalAfterFundsSettled: false,
      ...(input.controls ? { controls: input.controls } : {}),
    });
  }

  return {
    deriveAdjustmentId: deriveWalletAdjustmentId,
    preview,
    getAccountSummary: (accountId) => deps.wallets.getWallet(accountId),
    request,
    approve,
    reject,
    post,
    approveAndPost,
    reverse,
    getAdjustment: (adjustmentId) => getWalletAdjustment(deps.db, adjustmentId),
    listAdjustments: (params = {}) => listWalletAdjustments(deps.db, params),
    listIncompleteAdjustments: (params = {}) => listIncompleteWalletAdjustments(deps.db, params),
  };
}
