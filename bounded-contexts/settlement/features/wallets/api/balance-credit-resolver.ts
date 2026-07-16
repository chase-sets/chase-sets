import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { AccountId, PaymentId } from "@chase-sets/primitives/typed-ids";
import {
  compareMoney,
  normalizeCurrencyCode,
  normalizeMoneyAmount,
  subtractMoney,
  type CurrencyCode,
} from "../../../support/runtime-support/common";
import { getAccountActiveSpendHoldAmount, getWallet } from "../read-model/queries";
import type { WalletSpendHoldReleaseReason } from "../domain/domain";
import type { WalletServices } from "./runtime";

export type SettlementBalanceCreditResolution = Readonly<{
  requestedAmount: string;
  appliedAmount: string;
  remainingExternalAmount: string;
  /** Set when a positive balance would otherwise have applied but was withheld -- see `blockedReason` docs below. */
  blockedReason: "wallet-terms-not-accepted" | null;
}>;

/**
 * The write side of the wallet the resolver reserves against. Injected (rather
 * than imported as a full runtime) so Settlement remains the only writer of its
 * own wallet streams while Payments only ever sees the cross-context resolver
 * port. Absent in read-only/preview wirings, in which case no reservation is
 * placed and behavior matches the pre-hold path.
 */
export type WalletSpendHoldPort = Pick<WalletServices, "placeSpendHold" | "releaseSpendHold">;

/** Default life of a buyer-spend hold before the stale-hold sweep may release it (72h -- far beyond any checkout/session TTL). */
const DEFAULT_SPEND_HOLD_TTL_MS = 72 * 60 * 60 * 1000;

export function balanceCreditHoldId(paymentId: string): string {
  return `hold_balance_credit_${paymentId}`;
}

export type SettlementBalanceCreditResolver = Readonly<{
  resolveBalanceCredit(
    input: Readonly<{
      buyerAccountId: AccountId;
      currencyCode: CurrencyCode | string;
      requestedAmount: string;
      orderTotalAmount: string;
    }>,
  ): Promise<SettlementBalanceCreditResolution>;
  /**
   * Reserves the applied wallet credit for a payment at creation time. Returns
   * the amount actually held, which may be less than requested under concurrent
   * checkout contention (or "0.00" when a rival reserved it all). A no-op
   * returning the requested amount when no wallet write port is wired.
   */
  placeSpendHold(
    input: Readonly<{
      paymentId: PaymentId;
      buyerAccountId: AccountId;
      currencyCode: CurrencyCode | string;
      requestedAmount: string;
    }>,
    context: EventStoreContext,
  ): Promise<{ heldAmount: string }>;
  /** Releases a payment's spend hold (payment failed/cancelled or a rejected concurrent checkout). Idempotent no-op when unwired or absent. */
  releaseSpendHold(
    input: Readonly<{
      paymentId: PaymentId;
      buyerAccountId: AccountId;
      reason: WalletSpendHoldReleaseReason;
    }>,
    context: EventStoreContext,
  ): Promise<void>;
}>;

/**
 * The buyer-facing side of wallet-adjustment-enabled marketplace access:
 * spending a wallet balance built up (in part) from wallet adjustments as
 * checkout credit. Resolved cross-context, not imported, so Settlement stays
 * the only reader of its own wallet storage -- see
 * `bounded-contexts/settlement/context.json` `hostPorts` and
 * `deployables/platform-api/src/app.ts` for how this is wired from Identity.
 */
export type TermsAcceptanceResolver = Readonly<{
  resolveTermsAcceptanceStatus(
    subject: Readonly<{ accountId: AccountId }>,
  ): Promise<Readonly<{ accepted: boolean; requiredVersion: string }>>;
}>;

export type SettlementBalanceCreditResolverDeps = Readonly<{
  /**
   * Absent or unresolved counts as NOT accepted -- fail closed. A buyer can
   * never draw down wallet balance as checkout credit unless a wired
   * resolver affirmatively proves they hold the active Terms of Service
   * version. This is deliberate defense-in-depth: it holds even if a caller
   * forgets to surface the resulting `blockedReason` in its own UI.
   */
  termsAcceptanceResolver?: TermsAcceptanceResolver;
  /**
   * The wallet write port used to place/release buyer-spend holds. When wired,
   * the resolver authoritatively reserves applied credit at payment creation so
   * concurrent checkouts cannot double-spend it. When absent, no reservation is
   * placed (read-only / preview wirings).
   */
  walletSpendHolds?: WalletSpendHoldPort;
  /** Overrides the default buyer-spend hold TTL; the stale-hold sweep releases holds past this age. */
  spendHoldTtlMs?: number;
}>;

function minMoney(...values: readonly string[]) {
  return values.reduce((minimum, value) => (compareMoney(value, minimum) < 0 ? value : minimum));
}

function maxMoney(...values: readonly string[]) {
  return values.reduce((maximum, value) => (compareMoney(value, maximum) > 0 ? value : maximum));
}

export function createSettlementBalanceCreditResolver(
  db: PgQueryable,
  deps: SettlementBalanceCreditResolverDeps = {},
): SettlementBalanceCreditResolver {
  const spendHoldTtlMs = deps.spendHoldTtlMs ?? DEFAULT_SPEND_HOLD_TTL_MS;

  return {
    async resolveBalanceCredit(input) {
      normalizeCurrencyCode(String(input.currencyCode));
      const [wallet, activeHoldAmount] = await Promise.all([
        getWallet(db, input.buyerAccountId),
        getAccountActiveSpendHoldAmount(db, input.buyerAccountId),
      ]);
      const requestedAmount = normalizeMoneyAmount(input.requestedAmount, {
        fieldName: "Balance credit amount",
        allowZero: true,
      });
      const orderTotalAmount = normalizeMoneyAmount(input.orderTotalAmount, {
        fieldName: "Order total",
        allowZero: true,
      });
      // Spendable availability nets out balance already reserved by other
      // in-flight checkouts, so a preview/quote never offers held funds a second
      // time. The authoritative cap still lives in the wallet aggregate at
      // `placeSpendHold`; this read-model subtraction keeps quotes accurate and
      // avoids a re-quote loop once a rival's hold has projected.
      const spendableAmount = maxMoney(
        "0.00",
        subtractMoney(
          normalizeMoneyAmount(wallet.available_balance_amount, {
            fieldName: "Available balance",
            allowZero: true,
          }),
          normalizeMoneyAmount(activeHoldAmount, { fieldName: "Held balance", allowZero: true }),
        ),
      );
      const eligibleAmount = minMoney(requestedAmount, spendableAmount, orderTotalAmount);

      if (compareMoney(eligibleAmount, "0.00") <= 0) {
        return {
          requestedAmount,
          appliedAmount: "0.00",
          remainingExternalAmount: subtractMoney(orderTotalAmount, "0.00"),
          blockedReason: null,
        };
      }

      const termsStatus = await deps.termsAcceptanceResolver?.resolveTermsAcceptanceStatus({
        accountId: input.buyerAccountId,
      });
      if (!termsStatus?.accepted) {
        return {
          requestedAmount,
          appliedAmount: "0.00",
          remainingExternalAmount: orderTotalAmount,
          blockedReason: "wallet-terms-not-accepted",
        };
      }

      return {
        requestedAmount,
        appliedAmount: eligibleAmount,
        remainingExternalAmount: subtractMoney(orderTotalAmount, eligibleAmount),
        blockedReason: null,
      };
    },
    async placeSpendHold(input, context) {
      const requestedAmount = normalizeMoneyAmount(input.requestedAmount, {
        fieldName: "Balance credit amount",
        allowZero: true,
      });
      // No write port wired: preserve the pre-hold behavior (apply what was
      // resolved). Production always wires the port, closing the race.
      if (!deps.walletSpendHolds || compareMoney(requestedAmount, "0.00") <= 0) {
        return { heldAmount: requestedAmount };
      }
      const placedAt = new Date().toISOString();
      const result = await deps.walletSpendHolds.placeSpendHold(
        {
          accountId: input.buyerAccountId,
          holdId: balanceCreditHoldId(input.paymentId),
          paymentId: input.paymentId,
          amount: requestedAmount,
          currencyCode: normalizeCurrencyCode(String(input.currencyCode)),
          placedAt,
          expiresAt: new Date(Date.parse(placedAt) + spendHoldTtlMs).toISOString(),
        },
        context,
      );
      return { heldAmount: result.heldAmount };
    },
    async releaseSpendHold(input, context) {
      if (!deps.walletSpendHolds) {
        return;
      }
      await deps.walletSpendHolds.releaseSpendHold(
        {
          accountId: input.buyerAccountId,
          holdId: balanceCreditHoldId(input.paymentId),
          reason: input.reason,
        },
        context,
      );
    },
  };
}
