import type { AggregateDecider, AggregateEvolver, DomainEvent } from "@chase-sets/event-core";
import type { AccountId, LedgerEntryId, OrderId, PaymentId, PayoutId } from "@chase-sets/primitives/typed-ids";
import {
  addMoney,
  assert,
  assertNever,
  compareMoney,
  ensureIsoTimestamp,
  normalizeCurrencyCode,
  normalizeLedgerEntryDirection,
  normalizeLedgerEntryFundsStatus,
  normalizeLedgerEntryKind,
  normalizeMoneyAmount,
  normalizeOptionalText,
  subtractMoney,
  type CurrencyCode,
  type LedgerEntryDirection,
  type LedgerEntryFundsStatus,
  type LedgerEntryKind,
} from "../../../support/runtime-support/common";

export type WalletLedgerEntry = Readonly<{
  ledgerEntryId: LedgerEntryId;
  kind: LedgerEntryKind;
  direction: LedgerEntryDirection;
  amount: string;
  currencyCode: CurrencyCode;
  fundsStatus: LedgerEntryFundsStatus;
  orderId: OrderId | null;
  paymentId: PaymentId | null;
  payoutId: PayoutId | null;
  description: string | null;
  postedAt: string;
  availableAt: string | null;
}>;

export type WalletNegativeBalanceStatus = "in-good-standing" | "negative" | "collections";

/**
 * Why a buyer-spend hold was released. `payment-captured` converts the hold to
 * the final balance-credit debit (the debit ledger entry is what actually moves
 * the money); the other reasons simply return the reserved amount to spendable
 * availability without moving money.
 */
export type WalletSpendHoldReleaseReason = "payment-captured" | "payment-failed" | "payment-cancelled" | "expired";

export type WalletSpendHoldStatus = "active" | "released";

/**
 * A reservation ("spend hold") placed on wallet credit at checkout / payment
 * creation, before the balance-credit debit posts at capture. Holds reduce the
 * balance available to spend (and to pay out) without changing
 * `availableBalanceAmount` -- only ledger entries move real money. The hold
 * exists so two concurrent checkouts cannot both apply the same credit: the
 * decider reserves against `availableBalanceAmount - heldBalanceAmount`, and the
 * runtime commits under optimistic concurrency so a losing concurrent hold
 * re-reads the winner's reservation.
 */
export type WalletSpendHold = Readonly<{
  holdId: string;
  paymentId: PaymentId | null;
  amount: string;
  currencyCode: CurrencyCode;
  status: WalletSpendHoldStatus;
  placedAt: string;
  expiresAt: string | null;
  releasedAt: string | null;
  releaseReason: WalletSpendHoldReleaseReason | null;
}>;

export type WalletState = Readonly<{
  accountId: AccountId | null;
  currencyCode: CurrencyCode | null;
  pendingBalanceAmount: string;
  availableBalanceAmount: string;
  /** Sum of active buyer-spend holds; reduces spendable/payable availability without moving money. */
  heldBalanceAmount: string;
  totalCreditedAmount: string;
  totalDebitedAmount: string;
  negativeBalanceStatus: WalletNegativeBalanceStatus;
  negativeBalanceStartedAt: string | null;
  collectionsEscalatedAt: string | null;
  entries: readonly WalletLedgerEntry[];
  spendHolds: readonly WalletSpendHold[];
  openedAt: string | null;
  updatedAt: string | null;
}>;

export const initialWalletState: WalletState = {
  accountId: null,
  currencyCode: null,
  pendingBalanceAmount: "0.00",
  availableBalanceAmount: "0.00",
  heldBalanceAmount: "0.00",
  totalCreditedAmount: "0.00",
  totalDebitedAmount: "0.00",
  negativeBalanceStatus: "in-good-standing",
  negativeBalanceStartedAt: null,
  collectionsEscalatedAt: null,
  entries: [],
  spendHolds: [],
  openedAt: null,
  updatedAt: null,
};

/** Spendable balance for new buyer-spend holds: available less everything already held, floored at zero. */
export function walletSpendableBalanceAmount(state: WalletState): string {
  const spendable = subtractMoney(state.availableBalanceAmount, state.heldBalanceAmount);
  return compareMoney(spendable, "0.00") > 0 ? spendable : "0.00";
}

function minMoney(left: string, right: string) {
  return compareMoney(left, right) <= 0 ? left : right;
}

export type OpenWalletCommand = Readonly<{
  type: "OpenWallet";
  accountId: AccountId;
  currencyCode: CurrencyCode;
  openedAt: string;
}>;

export type PostLedgerEntryCommand = Readonly<{
  type: "PostLedgerEntry";
  ledgerEntryId: LedgerEntryId;
  kind: LedgerEntryKind;
  direction: LedgerEntryDirection;
  amount: string;
  currencyCode: CurrencyCode;
  fundsStatus: LedgerEntryFundsStatus;
  orderId?: OrderId | null;
  paymentId?: PaymentId | null;
  payoutId?: PayoutId | null;
  description?: string | null;
  postedAt: string;
  allowNegativeBalance?: boolean;
}>;

export type MarkLedgerEntryAvailableCommand = Readonly<{
  type: "MarkLedgerEntryAvailable";
  ledgerEntryId: LedgerEntryId;
  availableAt: string;
}>;

export type CreditSellerCaptureCommand = Readonly<{
  type: "CreditSellerCapture";
  kind: "sale" | "rebate";
  amount: string;
  currencyCode: CurrencyCode;
  orderId: OrderId;
  paymentId: PaymentId;
  postedAt: string;
}>;

export type EvaluateNegativeBalanceCollectionsCommand = Readonly<{
  type: "EvaluateNegativeBalanceCollections";
  collectionsThresholdAmount: string;
  collectionsGracePeriodDays: number;
  evaluatedAt: string;
}>;

export type PlaceSpendHoldCommand = Readonly<{
  type: "PlaceSpendHold";
  holdId: string;
  paymentId?: PaymentId | null;
  amount: string;
  currencyCode: CurrencyCode;
  placedAt: string;
  expiresAt?: string | null;
}>;

export type ReleaseSpendHoldCommand = Readonly<{
  type: "ReleaseSpendHold";
  holdId: string;
  reason: WalletSpendHoldReleaseReason;
  releasedAt: string;
}>;

export type WalletCommand =
  | OpenWalletCommand
  | PostLedgerEntryCommand
  | CreditSellerCaptureCommand
  | MarkLedgerEntryAvailableCommand
  | EvaluateNegativeBalanceCollectionsCommand
  | PlaceSpendHoldCommand
  | ReleaseSpendHoldCommand;

export type WalletOpenedEvent = DomainEvent<
  "settlement.wallet.opened",
  Readonly<{
    accountId: AccountId;
    currencyCode: CurrencyCode;
    openedAt: string;
  }>
>;

export type WalletLedgerEntryPostedEvent = DomainEvent<
  "settlement.wallet.ledger-entry-posted",
  Readonly<{
    accountId: AccountId;
    ledgerEntryId: LedgerEntryId;
    kind: LedgerEntryKind;
    direction: LedgerEntryDirection;
    amount: string;
    currencyCode: CurrencyCode;
    fundsStatus: LedgerEntryFundsStatus;
    orderId: OrderId | null;
    paymentId: PaymentId | null;
    payoutId: PayoutId | null;
    description: string | null;
    postedAt: string;
  }>
>;

export type WalletLedgerEntryAvailableEvent = DomainEvent<
  "settlement.wallet.ledger-entry-available-recorded",
  Readonly<{
    accountId: AccountId;
    ledgerEntryId: LedgerEntryId;
    amount: string;
    availableAt: string;
  }>
>;

export type WalletNegativeBalanceEnteredEvent = DomainEvent<
  "settlement.wallet.negative-balance-entered",
  Readonly<{
    accountId: AccountId;
    balanceAmount: string;
    enteredAt: string;
  }>
>;

export type WalletNegativeBalanceCollectionsOpenedEvent = DomainEvent<
  "settlement.wallet.negative-balance-collections-opened",
  Readonly<{
    accountId: AccountId;
    balanceAmount: string;
    negativeSince: string;
    thresholdAmount: string;
    gracePeriodDays: number;
    openedAt: string;
  }>
>;

export type WalletNegativeBalanceRecoveredEvent = DomainEvent<
  "settlement.wallet.negative-balance-recovered",
  Readonly<{
    accountId: AccountId;
    balanceAmount: string;
    recoveredAt: string;
  }>
>;

export type WalletSpendHoldPlacedEvent = DomainEvent<
  "settlement.wallet.spend-hold-placed",
  Readonly<{
    accountId: AccountId;
    holdId: string;
    paymentId: PaymentId | null;
    amount: string;
    currencyCode: CurrencyCode;
    placedAt: string;
    expiresAt: string | null;
  }>
>;

export type WalletSpendHoldReleasedEvent = DomainEvent<
  "settlement.wallet.spend-hold-released",
  Readonly<{
    accountId: AccountId;
    holdId: string;
    paymentId: PaymentId | null;
    amount: string;
    reason: WalletSpendHoldReleaseReason;
    releasedAt: string;
  }>
>;

export type WalletEvent =
  | WalletOpenedEvent
  | WalletLedgerEntryPostedEvent
  | WalletLedgerEntryAvailableEvent
  | WalletNegativeBalanceEnteredEvent
  | WalletNegativeBalanceCollectionsOpenedEvent
  | WalletNegativeBalanceRecoveredEvent
  | WalletSpendHoldPlacedEvent
  | WalletSpendHoldReleasedEvent;

function hasLedgerEntry(entries: readonly WalletLedgerEntry[], ledgerEntryId: LedgerEntryId) {
  return entries.some((entry) => entry.ledgerEntryId === ledgerEntryId);
}

function negativeBalanceTransitionEvents(
  state: WalletState,
  nextAvailableBalanceAmount: string,
  occurredAt: string,
): WalletNegativeBalanceEnteredEvent[] | WalletNegativeBalanceRecoveredEvent[] {
  if (state.accountId === null) {
    return [];
  }

  const wasNegative = state.negativeBalanceStatus !== "in-good-standing";
  const isNegative = compareMoney(nextAvailableBalanceAmount, "0.00") < 0;

  if (!wasNegative && isNegative) {
    return [
      {
        type: "settlement.wallet.negative-balance-entered",
        data: {
          accountId: state.accountId,
          balanceAmount: nextAvailableBalanceAmount,
          enteredAt: occurredAt,
        },
      },
    ];
  }

  if (wasNegative && !isNegative) {
    return [
      {
        type: "settlement.wallet.negative-balance-recovered",
        data: {
          accountId: state.accountId,
          balanceAmount: nextAvailableBalanceAmount,
          recoveredAt: occurredAt,
        },
      },
    ];
  }

  return [];
}

export const decideWallet: AggregateDecider<WalletState, WalletCommand, WalletEvent> = (state, command) => {
  switch (command.type) {
    case "OpenWallet":
      if (state.accountId !== null) {
        return [];
      }

      return [
        {
          type: "settlement.wallet.opened",
          data: {
            accountId: command.accountId,
            currencyCode: normalizeCurrencyCode(command.currencyCode),
            openedAt: ensureIsoTimestamp(command.openedAt, "Wallet opening must record a timestamp."),
          },
        },
      ];
    case "CreditSellerCapture": {
      assert(state.accountId !== null, "Wallet must be opened first.");
      assert(command.kind === "sale" || command.kind === "rebate", "Seller capture credit must be sale or rebate.");
      const currencyCode = normalizeCurrencyCode(command.currencyCode);
      assert(state.currencyCode === currencyCode, "Seller capture credit must use the wallet currency.");
      const amount = normalizeMoneyAmount(command.amount, {
        fieldName: "Seller capture credit amount",
        allowZero: true,
      });
      const postedAt = ensureIsoTimestamp(command.postedAt, "Seller capture credit must record a timestamp.");
      const prefix = command.kind === "sale" ? "led_sale" : "led_shipping_allowance";
      const baseId = `${prefix}_${command.paymentId}_${command.orderId}` as LedgerEntryId;
      const pendingId = `${baseId}_pending` as LedgerEntryId;
      const entries = state.entries.filter(
        (entry) => entry.ledgerEntryId === baseId || entry.ledgerEntryId === pendingId,
      );
      if (entries.length > 0) {
        const base = entries.find((entry) => entry.ledgerEntryId === baseId);
        const pending = entries.find((entry) => entry.ledgerEntryId === pendingId);
        const matchesFacts = entries.every(
          (entry) =>
            entry.kind === command.kind &&
            entry.direction === "credit" &&
            entry.currencyCode === currencyCode &&
            entry.orderId === command.orderId &&
            entry.paymentId === command.paymentId &&
            entry.payoutId === null &&
            compareMoney(entry.amount, "0.00") > 0,
        );
        // availableAt preserves the distinction between an offset and a released pending leg.
        const completeSingle = entries.length === 1 && base !== undefined && compareMoney(base.amount, amount) === 0;
        const completeSplit =
          entries.length === 2 &&
          base !== undefined &&
          pending !== undefined &&
          base.fundsStatus === "available" &&
          base.availableAt === null &&
          (pending.fundsStatus === "pending" || pending.availableAt !== null) &&
          compareMoney(addMoney(base.amount, pending.amount), amount) === 0;
        assert(
          matchesFacts && (completeSingle || completeSplit),
          `Seller capture credit ${baseId} has incomplete or mismatched ledger evidence; operator review required.`,
        );
        return [];
      }
      if (compareMoney(amount, "0.00") === 0) return [];

      const offset =
        compareMoney(state.availableBalanceAmount, "0.00") < 0
          ? minMoney(amount, subtractMoney("0.00", state.availableBalanceAmount))
          : "0.00";
      const remainder = subtractMoney(amount, offset);
      const events: WalletEvent[] = [];
      let nextState = state;
      const description = command.kind === "sale" ? "Item sale proceeds" : "Shipping allowance";
      for (const leg of [
        {
          amount: remainder,
          ledgerEntryId: compareMoney(offset, "0.00") > 0 ? pendingId : baseId,
          fundsStatus: "pending" as const,
          description: `${description} for order ${command.orderId}`,
        },
        {
          amount: offset,
          ledgerEntryId: baseId,
          fundsStatus: "available" as const,
          description: `Negative balance offset from ${description.toLowerCase()} for order ${command.orderId}`,
        },
      ]) {
        if (compareMoney(leg.amount, "0.00") === 0) continue;
        const posting = decideWallet(nextState, {
          type: "PostLedgerEntry",
          ...leg,
          kind: command.kind,
          direction: "credit",
          currencyCode,
          orderId: command.orderId,
          paymentId: command.paymentId,
          postedAt,
        });
        events.push(...posting);
        nextState = posting.reduce(evolveWallet, nextState);
      }
      return events;
    }
    case "PostLedgerEntry":
      assert(state.accountId !== null, "Wallet must be opened first.");
      assert(!hasLedgerEntry(state.entries, command.ledgerEntryId), "Ledger entry has already been posted.");
      assert(
        state.currencyCode === normalizeCurrencyCode(command.currencyCode),
        "Ledger entries must use the wallet currency.",
      );
      assert(
        command.direction !== "debit" ||
          command.fundsStatus !== "available" ||
          command.allowNegativeBalance === true ||
          compareMoney(state.availableBalanceAmount, command.amount) >= 0,
        "Available balance is too low for this ledger entry.",
      );

      const ledgerAmount = normalizeMoneyAmount(command.amount, {
        fieldName: "Ledger entry amount",
      });
      const signedAmount = command.direction === "credit" ? ledgerAmount : `-${ledgerAmount}`;
      const nextAvailableBalanceAmount =
        command.fundsStatus === "available"
          ? addMoney(state.availableBalanceAmount, signedAmount)
          : state.availableBalanceAmount;

      return [
        {
          type: "settlement.wallet.ledger-entry-posted",
          data: {
            accountId: state.accountId,
            ledgerEntryId: command.ledgerEntryId,
            kind: normalizeLedgerEntryKind(command.kind),
            direction: normalizeLedgerEntryDirection(command.direction),
            amount: ledgerAmount,
            currencyCode: normalizeCurrencyCode(command.currencyCode),
            fundsStatus: normalizeLedgerEntryFundsStatus(command.fundsStatus),
            orderId: command.orderId ?? null,
            paymentId: command.paymentId ?? null,
            payoutId: command.payoutId ?? null,
            description: normalizeOptionalText(command.description),
            postedAt: ensureIsoTimestamp(command.postedAt, "Ledger entry posting must record a timestamp."),
          },
        },
        ...negativeBalanceTransitionEvents(
          state,
          nextAvailableBalanceAmount,
          ensureIsoTimestamp(command.postedAt, "Ledger entry posting must record a timestamp."),
        ),
      ];
    case "MarkLedgerEntryAvailable": {
      assert(state.accountId !== null, "Wallet must be opened first.");
      const entry = state.entries.find((candidate) => candidate.ledgerEntryId === command.ledgerEntryId);
      assert(entry, "Ledger entry was not found.");
      if (entry.fundsStatus === "available") {
        return [];
      }
      assert(entry.direction === "credit", "Only pending credit entries can become available.");

      const availableAt = ensureIsoTimestamp(command.availableAt, "Ledger entry availability must record a timestamp.");
      const nextAvailableBalanceAmount = addMoney(state.availableBalanceAmount, entry.amount);

      return [
        {
          type: "settlement.wallet.ledger-entry-available-recorded",
          data: {
            accountId: state.accountId,
            ledgerEntryId: entry.ledgerEntryId,
            amount: entry.amount,
            availableAt,
          },
        },
        ...negativeBalanceTransitionEvents(state, nextAvailableBalanceAmount, availableAt),
      ];
    }
    case "EvaluateNegativeBalanceCollections": {
      assert(state.accountId !== null, "Wallet must be opened first.");
      const evaluatedAt = ensureIsoTimestamp(command.evaluatedAt, "Collections evaluation must record a timestamp.");
      const thresholdAmount = normalizeMoneyAmount(command.collectionsThresholdAmount, {
        fieldName: "Collections threshold amount",
      });
      assert(
        Number.isInteger(command.collectionsGracePeriodDays) && command.collectionsGracePeriodDays >= 0,
        "Collections grace period must be a whole number of days.",
      );
      if (state.negativeBalanceStatus !== "negative" || state.negativeBalanceStartedAt === null) {
        return [];
      }
      if (compareMoney(state.availableBalanceAmount, `-${thresholdAmount}`) > 0) {
        return [];
      }
      const earliestCollectionsAt =
        Date.parse(state.negativeBalanceStartedAt) + command.collectionsGracePeriodDays * 24 * 60 * 60 * 1000;
      if (Date.parse(evaluatedAt) < earliestCollectionsAt) {
        return [];
      }

      return [
        {
          type: "settlement.wallet.negative-balance-collections-opened",
          data: {
            accountId: state.accountId,
            balanceAmount: state.availableBalanceAmount,
            negativeSince: state.negativeBalanceStartedAt,
            thresholdAmount,
            gracePeriodDays: command.collectionsGracePeriodDays,
            openedAt: evaluatedAt,
          },
        },
      ];
    }
    case "PlaceSpendHold": {
      assert(state.accountId !== null, "Wallet must be opened first.");
      assert(
        state.currencyCode === normalizeCurrencyCode(command.currencyCode),
        "Spend holds must use the wallet currency.",
      );
      // Idempotent: a hold with this id has already been decided (whether it is
      // still active or has since been released/captured). Never re-reserve.
      if (state.spendHolds.some((hold) => hold.holdId === command.holdId)) {
        return [];
      }
      const requestedAmount = normalizeMoneyAmount(command.amount, {
        fieldName: "Spend hold amount",
        allowZero: true,
      });
      // Authoritative reservation against in-aggregate state. `heldBalanceAmount`
      // already reflects every prior committed hold on this wallet stream, so
      // under optimistic concurrency a second concurrent checkout that loses the
      // append race re-loads, sees the winner's hold here, and is capped to the
      // balance still unheld. This -- not the read model -- is what closes the
      // double-spend race.
      const heldAmount = minMoney(requestedAmount, walletSpendableBalanceAmount(state));
      if (compareMoney(heldAmount, "0.00") <= 0) {
        return [];
      }
      return [
        {
          type: "settlement.wallet.spend-hold-placed",
          data: {
            accountId: state.accountId,
            holdId: command.holdId,
            paymentId: command.paymentId ?? null,
            amount: heldAmount,
            currencyCode: normalizeCurrencyCode(command.currencyCode),
            placedAt: ensureIsoTimestamp(command.placedAt, "Spend hold placement must record a timestamp."),
            expiresAt:
              command.expiresAt == null
                ? null
                : ensureIsoTimestamp(command.expiresAt, "Spend hold expiry must be a timestamp."),
          },
        },
      ];
    }
    case "ReleaseSpendHold": {
      assert(state.accountId !== null, "Wallet must be opened first.");
      const hold = state.spendHolds.find((candidate) => candidate.holdId === command.holdId);
      // Idempotent: releasing an unknown or already-released hold is a no-op, so
      // redelivered capture/failure/cancellation events never double-count.
      if (!hold || hold.status !== "active") {
        return [];
      }
      return [
        {
          type: "settlement.wallet.spend-hold-released",
          data: {
            accountId: state.accountId,
            holdId: hold.holdId,
            paymentId: hold.paymentId,
            amount: hold.amount,
            reason: command.reason,
            releasedAt: ensureIsoTimestamp(command.releasedAt, "Spend hold release must record a timestamp."),
          },
        },
      ];
    }
    default:
      return assertNever(command);
  }
};

export const evolveWallet: AggregateEvolver<WalletState, WalletEvent> = (state, event) => {
  switch (event.type) {
    case "settlement.wallet.opened":
      return {
        accountId: event.data.accountId,
        currencyCode: event.data.currencyCode,
        pendingBalanceAmount: "0.00",
        availableBalanceAmount: "0.00",
        heldBalanceAmount: "0.00",
        totalCreditedAmount: "0.00",
        totalDebitedAmount: "0.00",
        negativeBalanceStatus: "in-good-standing",
        negativeBalanceStartedAt: null,
        collectionsEscalatedAt: null,
        entries: [],
        spendHolds: [],
        openedAt: event.data.openedAt,
        updatedAt: event.data.openedAt,
      };
    case "settlement.wallet.ledger-entry-posted": {
      const signedAmount = event.data.direction === "credit" ? event.data.amount : `-${event.data.amount}`;
      const pendingBalanceAmount =
        event.data.fundsStatus === "pending"
          ? addMoney(state.pendingBalanceAmount, signedAmount)
          : state.pendingBalanceAmount;
      const availableBalanceAmount =
        event.data.fundsStatus === "available"
          ? addMoney(state.availableBalanceAmount, signedAmount)
          : state.availableBalanceAmount;

      return {
        ...state,
        pendingBalanceAmount,
        availableBalanceAmount,
        totalCreditedAmount:
          event.data.direction === "credit"
            ? addMoney(state.totalCreditedAmount, event.data.amount)
            : state.totalCreditedAmount,
        totalDebitedAmount:
          event.data.direction === "debit"
            ? addMoney(state.totalDebitedAmount, event.data.amount)
            : state.totalDebitedAmount,
        entries: [
          ...state.entries,
          {
            ledgerEntryId: event.data.ledgerEntryId,
            kind: event.data.kind,
            direction: event.data.direction,
            amount: event.data.amount,
            currencyCode: event.data.currencyCode,
            fundsStatus: event.data.fundsStatus,
            orderId: event.data.orderId,
            paymentId: event.data.paymentId,
            payoutId: event.data.payoutId,
            description: event.data.description,
            postedAt: event.data.postedAt,
            availableAt: null,
          },
        ],
        updatedAt: event.data.postedAt,
      };
    }
    case "settlement.wallet.ledger-entry-available-recorded":
      return {
        ...state,
        pendingBalanceAmount: addMoney(state.pendingBalanceAmount, `-${event.data.amount}`),
        availableBalanceAmount: addMoney(state.availableBalanceAmount, event.data.amount),
        entries: state.entries.map((entry) =>
          entry.ledgerEntryId === event.data.ledgerEntryId
            ? {
                ...entry,
                fundsStatus: "available",
                availableAt: event.data.availableAt,
              }
            : entry,
        ),
        updatedAt: event.data.availableAt,
      };
    case "settlement.wallet.negative-balance-entered":
      return {
        ...state,
        negativeBalanceStatus: "negative",
        negativeBalanceStartedAt: event.data.enteredAt,
        collectionsEscalatedAt: null,
        updatedAt: event.data.enteredAt,
      };
    case "settlement.wallet.negative-balance-collections-opened":
      return {
        ...state,
        negativeBalanceStatus: "collections",
        negativeBalanceStartedAt: event.data.negativeSince,
        collectionsEscalatedAt: event.data.openedAt,
        updatedAt: event.data.openedAt,
      };
    case "settlement.wallet.negative-balance-recovered":
      return {
        ...state,
        negativeBalanceStatus: "in-good-standing",
        negativeBalanceStartedAt: null,
        collectionsEscalatedAt: null,
        updatedAt: event.data.recoveredAt,
      };
    case "settlement.wallet.spend-hold-placed":
      return {
        ...state,
        heldBalanceAmount: addMoney(state.heldBalanceAmount, event.data.amount),
        spendHolds: [
          ...state.spendHolds,
          {
            holdId: event.data.holdId,
            paymentId: event.data.paymentId,
            amount: event.data.amount,
            currencyCode: event.data.currencyCode,
            status: "active",
            placedAt: event.data.placedAt,
            expiresAt: event.data.expiresAt,
            releasedAt: null,
            releaseReason: null,
          },
        ],
        updatedAt: event.data.placedAt,
      };
    case "settlement.wallet.spend-hold-released":
      return {
        ...state,
        heldBalanceAmount: subtractMoney(state.heldBalanceAmount, event.data.amount),
        spendHolds: state.spendHolds.map((hold) =>
          hold.holdId === event.data.holdId
            ? {
                ...hold,
                status: "released",
                releasedAt: event.data.releasedAt,
                releaseReason: event.data.reason,
              }
            : hold,
        ),
        updatedAt: event.data.releasedAt,
      };
    default:
      return assertNever(event);
  }
};
