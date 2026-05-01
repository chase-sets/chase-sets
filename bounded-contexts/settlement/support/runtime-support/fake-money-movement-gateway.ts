import type { AccountId } from "@chase-sets/primitives/typed-ids";
import type {
  CreatedOnboardingSession,
  CreatedProviderPayout,
  CreatedProviderTransfer,
  MoneyMovementGateway,
  ProviderPayoutReadiness,
  ProviderPlatformBalance,
} from "@chase-sets/money-movement";
import {
  compareMoney,
  normalizeCurrencyCode,
  normalizeMoneyAmount,
  SettlementDomainError,
  type CurrencyCode,
} from "./common";

export type FakeMoneyMovementGatewayOptions = Readonly<{
  availableAmount?: string;
  failTransfer?: boolean;
  failPayout?: boolean;
  initialReadinessStatus?: "pending" | "ready";
}>;

export type FakeMoneyMovementGateway = MoneyMovementGateway &
  Readonly<{ usedIdempotencyKeys: readonly string[] }>;

function readyReadiness(providerReference: string): ProviderPayoutReadiness {
  return {
    providerReference,
    onboardingStatus: "complete",
    transferCapabilityStatus: "active",
    payoutCapabilityStatus: "active",
    payoutDestinationStatus: "ready",
    missingRequirements: [],
  };
}

function pendingReadiness(providerReference: string): ProviderPayoutReadiness {
  return {
    providerReference,
    onboardingStatus: "pending",
    transferCapabilityStatus: "pending",
    payoutCapabilityStatus: "pending",
    payoutDestinationStatus: "missing",
    missingRequirements: ["provider-onboarding"],
  };
}

export function createFakeMoneyMovementGateway(
  options: FakeMoneyMovementGatewayOptions = {},
): FakeMoneyMovementGateway {
  const accounts = new Map<AccountId, ProviderPayoutReadiness>();
  const usedIdempotencyKeys: string[] = [];
  let availableAmount = normalizeMoneyAmount(options.availableAmount ?? "999999.00", {
    fieldName: "Platform balance",
  });

  function readinessFor(accountId: AccountId) {
    const existing = accounts.get(accountId);
    if (existing) {
      return existing;
    }

    const providerReference = `acct_fake_${accountId}`;
    const readiness = options.initialReadinessStatus === "pending"
      ? pendingReadiness(providerReference)
      : readyReadiness(providerReference);
    accounts.set(accountId, readiness);
    return readiness;
  }

  return {
    providerName: "fake",
    async ensurePayoutAccount(input) {
      usedIdempotencyKeys.push(input.idempotencyKey);
      return readinessFor(input.accountId);
    },
    async createOnboardingSession(input): Promise<CreatedOnboardingSession> {
      usedIdempotencyKeys.push(input.idempotencyKey);
      const readiness = readyReadiness(input.providerReference);
      accounts.set(input.accountId, readiness);
      return {
        providerReference: input.providerReference,
        url: `https://example.test/payout-setup/${input.providerReference}`,
        expiresAt: null,
        readiness,
      };
    },
    async refreshPayoutReadiness(input) {
      return accounts.get(input.accountId) ?? readyReadiness(input.providerReference);
    },
    async retrievePlatformBalance(input): Promise<ProviderPlatformBalance> {
      return {
        currencyCode: normalizeCurrencyCode(input.currencyCode),
        availableAmount,
      };
    },
    async transferPlatformBalanceToConnectedAccount(
      input,
    ): Promise<CreatedProviderTransfer> {
      usedIdempotencyKeys.push(input.idempotencyKey);
      if (options.failTransfer) {
        throw new SettlementDomainError("Provider transfer failed.");
      }
      const amount = normalizeMoneyAmount(input.amount, {
        fieldName: "Transfer amount",
      });
      if (compareMoney(availableAmount, amount) < 0) {
        throw new SettlementDomainError("Platform balance is too low for this payout.");
      }
      availableAmount = (Number.parseFloat(availableAmount) - Number.parseFloat(amount))
        .toFixed(2);
      return {
        providerTransferReference: `tr_${input.payoutId}`,
        providerStatus: "paid",
      };
    },
    async createConnectedAccountPayout(input): Promise<CreatedProviderPayout> {
      usedIdempotencyKeys.push(input.idempotencyKey);
      if (options.failPayout) {
        throw new SettlementDomainError("Provider payout failed.");
      }
      return {
        providerPayoutReference: `po_${input.payoutId}`,
        providerStatus: "pending",
      };
    },
    async parseMoneyMovementWebhook(input) {
      const event = JSON.parse(input.rawBody) as {
        kind?: string;
        providerPayoutReference?: string;
        providerReference?: string;
      };
      if (event.kind === "payout-completed" && event.providerPayoutReference) {
        return {
          kind: "payout-completed",
          providerPayoutReference: event.providerPayoutReference,
          providerStatus: "paid",
          occurredAt: new Date().toISOString(),
        };
      }
      if (event.kind === "payout-failed" && event.providerPayoutReference) {
        return {
          kind: "payout-failed",
          providerPayoutReference: event.providerPayoutReference,
          providerStatus: "failed",
          failureCode: "fake_failure",
          failureMessage: "Fake payout failure.",
          occurredAt: new Date().toISOString(),
        };
      }
      if (event.kind === "payout-readiness-updated" && event.providerReference) {
        return {
          kind: "payout-readiness-updated",
          providerReference: event.providerReference,
          readiness: readyReadiness(event.providerReference),
          occurredAt: new Date().toISOString(),
        };
      }
      return null;
    },
    get usedIdempotencyKeys() {
      return usedIdempotencyKeys;
    },
  } as FakeMoneyMovementGateway;
}
