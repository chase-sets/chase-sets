import type {
  AggregateDecider,
  AggregateEvolver,
  DomainEvent,
} from "@chase-sets/event-core";
import type {
  AccountId,
  LedgerEntryId,
  OrderId,
  PaymentId,
  PayoutId,
} from "@chase-sets/primitives/typed-ids";
import {
  addMoney,
  assert,
  assertNever,
  ensureIsoTimestamp,
  normalizeCurrencyCode,
  normalizeLedgerEntryDirection,
  normalizeLedgerEntryFundsStatus,
  normalizeLedgerEntryKind,
  normalizeMoneyAmount,
  normalizeOptionalText,
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

export type WalletState = Readonly<{
  accountId: AccountId | null;
  currencyCode: CurrencyCode | null;
  pendingBalanceAmount: string;
  availableBalanceAmount: string;
  totalCreditedAmount: string;
  totalDebitedAmount: string;
  entries: readonly WalletLedgerEntry[];
  openedAt: string | null;
  updatedAt: string | null;
}>;

export const initialWalletState: WalletState = {
  accountId: null,
  currencyCode: null,
  pendingBalanceAmount: "0.00",
  availableBalanceAmount: "0.00",
  totalCreditedAmount: "0.00",
  totalDebitedAmount: "0.00",
  entries: [],
  openedAt: null,
  updatedAt: null,
};

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
}>;

export type MarkLedgerEntryAvailableCommand = Readonly<{
  type: "MarkLedgerEntryAvailable";
  ledgerEntryId: LedgerEntryId;
  availableAt: string;
}>;

export type WalletCommand =
  | OpenWalletCommand
  | PostLedgerEntryCommand
  | MarkLedgerEntryAvailableCommand;

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

export type WalletEvent =
  | WalletOpenedEvent
  | WalletLedgerEntryPostedEvent
  | WalletLedgerEntryAvailableEvent;

function hasLedgerEntry(
  entries: readonly WalletLedgerEntry[],
  ledgerEntryId: LedgerEntryId,
) {
  return entries.some((entry) => entry.ledgerEntryId === ledgerEntryId);
}

export const decideWallet: AggregateDecider<
  WalletState,
  WalletCommand,
  WalletEvent
> = (state, command) => {
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
            openedAt: ensureIsoTimestamp(
              command.openedAt,
              "Wallet opening must record a timestamp.",
            ),
          },
        },
      ];
    case "PostLedgerEntry":
      assert(state.accountId !== null, "Wallet must be opened first.");
      assert(
        !hasLedgerEntry(state.entries, command.ledgerEntryId),
        "Ledger entry has already been posted.",
      );
      assert(
        state.currencyCode === normalizeCurrencyCode(command.currencyCode),
        "Ledger entries must use the wallet currency.",
      );

      return [
        {
          type: "settlement.wallet.ledger-entry-posted",
          data: {
            accountId: state.accountId,
            ledgerEntryId: command.ledgerEntryId,
            kind: normalizeLedgerEntryKind(command.kind),
            direction: normalizeLedgerEntryDirection(command.direction),
            amount: normalizeMoneyAmount(command.amount, {
              fieldName: "Ledger entry amount",
            }),
            currencyCode: normalizeCurrencyCode(command.currencyCode),
            fundsStatus: normalizeLedgerEntryFundsStatus(command.fundsStatus),
            orderId: command.orderId ?? null,
            paymentId: command.paymentId ?? null,
            payoutId: command.payoutId ?? null,
            description: normalizeOptionalText(command.description),
            postedAt: ensureIsoTimestamp(
              command.postedAt,
              "Ledger entry posting must record a timestamp.",
            ),
          },
        },
      ];
    case "MarkLedgerEntryAvailable": {
      assert(state.accountId !== null, "Wallet must be opened first.");
      const entry = state.entries.find((candidate) =>
        candidate.ledgerEntryId === command.ledgerEntryId
      );
      assert(entry, "Ledger entry was not found.");
      if (entry.fundsStatus === "available") {
        return [];
      }
      assert(
        entry.direction === "credit",
        "Only pending credit entries can become available.",
      );

      return [
        {
          type: "settlement.wallet.ledger-entry-available-recorded",
          data: {
            accountId: state.accountId,
            ledgerEntryId: entry.ledgerEntryId,
            amount: entry.amount,
            availableAt: ensureIsoTimestamp(
              command.availableAt,
              "Ledger entry availability must record a timestamp.",
            ),
          },
        },
      ];
    }
    default:
      return assertNever(command);
  }
};

export const evolveWallet: AggregateEvolver<
  WalletState,
  WalletEvent
> = (state, event) => {
  switch (event.type) {
    case "settlement.wallet.opened":
      return {
        accountId: event.data.accountId,
        currencyCode: event.data.currencyCode,
        pendingBalanceAmount: "0.00",
        availableBalanceAmount: "0.00",
        totalCreditedAmount: "0.00",
        totalDebitedAmount: "0.00",
        entries: [],
        openedAt: event.data.openedAt,
        updatedAt: event.data.openedAt,
      };
    case "settlement.wallet.ledger-entry-posted": {
      const signedAmount =
        event.data.direction === "credit"
          ? event.data.amount
          : `-${event.data.amount}`;
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
        pendingBalanceAmount: addMoney(
          state.pendingBalanceAmount,
          `-${event.data.amount}`,
        ),
        availableBalanceAmount: addMoney(
          state.availableBalanceAmount,
          event.data.amount,
        ),
        entries: state.entries.map((entry) =>
          entry.ledgerEntryId === event.data.ledgerEntryId
            ? {
                ...entry,
                fundsStatus: "available",
                availableAt: event.data.availableAt,
              }
            : entry
        ),
        updatedAt: event.data.availableAt,
      };
    default:
      return assertNever(event);
  }
};
