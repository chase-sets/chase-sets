import type { AccountId, PayoutId } from "@chase-sets/primitives/typed-ids";
import {
  centsToMoneyAmount,
  compareMoneyAmounts,
  subtractNonNegativeMoneyAmounts,
  tryMoneyToCents,
} from "@chase-sets/primitives/money";
import type {
  CreatedPayoutAccountManagementSession,
  CreatedPayoutSetupLink,
  CreatedPayoutSetupSession,
  CreatedProviderPayout,
  CreatedProviderTransfer,
  CurrencyCode,
  MoneyMovementGateway,
  ProviderPayoutReadiness,
  ProviderPlatformBalance,
  RetrievedProviderPayout,
} from "./index";

export type FakeMoneyMovementGatewayOptions = Readonly<{
  availableAmount?: string;
  failTransfer?: boolean;
  failPayout?: boolean;
  initialReadinessStatus?: "pending" | "ready";
}>;

export type FakeMoneyMovementGateway = MoneyMovementGateway & Readonly<{ usedIdempotencyKeys: readonly string[] }>;

function normalizeMoneyAmount(value: string, fieldName: string) {
  const cents = tryMoneyToCents(value);
  if (cents === null) {
    throw new Error(`${fieldName} must be a non-negative amount.`);
  }
  return centsToMoneyAmount(cents);
}

function compareMoney(left: string, right: string) {
  return compareMoneyAmounts(left, right);
}

function subtractMoney(left: string, right: string) {
  return subtractNonNegativeMoneyAmounts(left, right);
}

function normalizeCurrencyCode(value: string): CurrencyCode {
  const normalized = value.trim().toLowerCase();
  if (normalized !== "usd") {
    throw new Error("Currency must be USD.");
  }
  return normalized;
}

function readyReadiness(providerReference: string): ProviderPayoutReadiness {
  return {
    providerReference,
    onboardingStatus: "complete",
    transferCapabilityStatus: "active",
    payoutCapabilityStatus: "active",
    payoutDestinationStatus: "ready",
    payoutAccountDashboard: "none",
    lossesCollector: "application",
    feesCollector: "application",
    requirementsCollector: "application",
    blockingRequirements: [],
    advisoryRequirements: [],
    disabledReason: null,
    requirementsDeadline: null,
  };
}

function pendingReadiness(providerReference: string): ProviderPayoutReadiness {
  return {
    providerReference,
    onboardingStatus: "pending",
    transferCapabilityStatus: "pending",
    payoutCapabilityStatus: "pending",
    payoutDestinationStatus: "missing",
    payoutAccountDashboard: "none",
    lossesCollector: "application",
    feesCollector: "application",
    requirementsCollector: "application",
    blockingRequirements: ["provider-onboarding"],
    advisoryRequirements: [],
    disabledReason: null,
    requirementsDeadline: null,
  };
}

export function createFakeMoneyMovementGateway(
  options: FakeMoneyMovementGatewayOptions = {},
): FakeMoneyMovementGateway {
  const accounts = new Map<AccountId, ProviderPayoutReadiness>();
  const payouts = new Map<string, RetrievedProviderPayout>();
  const usedIdempotencyKeys: string[] = [];
  let availableAmount = normalizeMoneyAmount(options.availableAmount ?? "999999.00", "Platform balance");

  function readinessFor(accountId: AccountId) {
    const existing = accounts.get(accountId);
    if (existing) {
      return existing;
    }

    const providerReference = `acct_fake_${accountId}`;
    const readiness =
      options.initialReadinessStatus === "pending"
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
    async createPayoutSetupSession(input): Promise<CreatedPayoutSetupSession> {
      usedIdempotencyKeys.push(input.idempotencyKey);
      const readiness = readyReadiness(input.providerReference);
      accounts.set(input.accountId, readiness);
      return {
        providerReference: input.providerReference,
        clientSecret: `fake_payout_setup_secret_${input.providerReference}`,
        expiresAt: null,
        components: ["payout-setup"],
        readiness,
      };
    },
    async createPayoutAccountManagementSession(input): Promise<CreatedPayoutAccountManagementSession> {
      usedIdempotencyKeys.push(input.idempotencyKey);
      return {
        providerReference: input.providerReference,
        clientSecret: `fake_payout_account_management_secret_${input.providerReference}`,
        expiresAt: null,
        components: ["payout-account-management"],
      };
    },
    async createPayoutNotificationBannerSession(input) {
      usedIdempotencyKeys.push(input.idempotencyKey);
      return {
        providerReference: input.providerReference,
        clientSecret: `fake_payout_notification_banner_secret_${input.providerReference}`,
        expiresAt: null,
        components: ["notification-banner"],
      };
    },
    async createPayoutSetupLink(input): Promise<CreatedPayoutSetupLink> {
      usedIdempotencyKeys.push(input.idempotencyKey);
      const readiness = pendingReadiness(input.providerReference);
      accounts.set(input.accountId, readiness);
      return {
        providerReference: input.providerReference,
        url: `https://connect.stripe.test/setup/${encodeURIComponent(input.providerReference)}`,
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
    async transferPlatformBalanceToConnectedAccount(input): Promise<CreatedProviderTransfer> {
      usedIdempotencyKeys.push(input.idempotencyKey);
      if (options.failTransfer) {
        throw new Error("Provider transfer failed.");
      }
      const amount = normalizeMoneyAmount(input.amount, "Transfer amount");
      if (compareMoney(availableAmount, amount) < 0) {
        throw new Error("Platform balance is too low for this payout.");
      }
      availableAmount = subtractMoney(availableAmount, amount);
      return {
        providerTransferReference: `tr_${input.payoutId}`,
        providerStatus: "paid",
      };
    },
    async createConnectedAccountPayout(input): Promise<CreatedProviderPayout> {
      usedIdempotencyKeys.push(input.idempotencyKey);
      if (options.failPayout) {
        throw new Error("Provider payout failed.");
      }
      const providerPayoutReference = `po_${input.payoutId}`;
      payouts.set(providerPayoutReference, {
        providerPayoutReference,
        providerStatus: "pending",
        failureCode: null,
        failureMessage: null,
      });
      return {
        providerPayoutReference,
        providerStatus: "pending",
      };
    },
    async retrieveConnectedAccountPayout(input): Promise<RetrievedProviderPayout> {
      return (
        payouts.get(input.providerPayoutReference) ?? {
          providerPayoutReference: input.providerPayoutReference,
          providerStatus: "pending",
          failureCode: null,
          failureMessage: null,
        }
      );
    },
    async parseMoneyMovementWebhook(input) {
      const event = JSON.parse(input.rawBody) as {
        kind?: string;
        providerEventId?: string;
        payoutId?: string;
        providerPayoutReference?: string;
        providerReference?: string;
        providerStatus?: string;
      };
      const providerEventId = event.providerEventId ?? `evt_fake_${event.kind ?? "unknown"}`;
      if (event.kind === "payout-completed" && event.providerPayoutReference) {
        payouts.set(event.providerPayoutReference, {
          providerPayoutReference: event.providerPayoutReference,
          providerStatus: event.providerStatus ?? "paid",
          failureCode: null,
          failureMessage: null,
        });
        return {
          kind: "payout-completed",
          providerEventId,
          payoutId: (event.payoutId as PayoutId | undefined) ?? null,
          providerPayoutReference: event.providerPayoutReference,
          providerStatus: event.providerStatus ?? "paid",
          occurredAt: new Date().toISOString(),
        };
      }
      if (event.kind === "payout-failed" && event.providerPayoutReference) {
        payouts.set(event.providerPayoutReference, {
          providerPayoutReference: event.providerPayoutReference,
          providerStatus: "failed",
          failureCode: "fake_failure",
          failureMessage: "Fake payout failure.",
        });
        return {
          kind: "payout-failed",
          providerEventId,
          payoutId: (event.payoutId as PayoutId | undefined) ?? null,
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
          providerEventId,
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
  } satisfies FakeMoneyMovementGateway;
}
