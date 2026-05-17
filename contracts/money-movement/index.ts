import type { AccountId, PayoutId } from "@chase-sets/primitives/typed-ids";

export type CurrencyCode = "usd";
export type ProviderSetupStatus = "not-started" | "pending" | "complete";
export type ProviderCapabilityStatus = "inactive" | "pending" | "active";
export type ProviderPayoutDestinationStatus = "missing" | "pending" | "ready";

export type ProviderPayoutReadiness = Readonly<{
  providerReference: string;
  onboardingStatus: ProviderSetupStatus;
  transferCapabilityStatus: ProviderCapabilityStatus;
  payoutCapabilityStatus: ProviderCapabilityStatus;
  payoutDestinationStatus: ProviderPayoutDestinationStatus;
  missingRequirements: readonly string[];
}>;

export type ProviderPlatformBalance = Readonly<{
  currencyCode: CurrencyCode;
  availableAmount: string;
}>;

export type CreatedOnboardingSession = Readonly<{
  providerReference: string;
  url: string;
  expiresAt: string | null;
  readiness: ProviderPayoutReadiness;
}>;

export type CreatedAccountManagementSession = Readonly<{
  providerReference: string;
  url: string;
  expiresAt: string | null;
}>;

export type CreatedProviderTransfer = Readonly<{
  providerTransferReference: string;
  providerStatus: string;
}>;

export type CreatedProviderPayout = Readonly<{
  providerPayoutReference: string;
  providerStatus: string;
}>;

export type RetrievedProviderPayout = Readonly<{
  providerPayoutReference: string;
  providerStatus: string;
  failureCode: string | null;
  failureMessage: string | null;
}>;

export type MoneyMovementWebhookEvent =
  | Readonly<{
      kind: "payout-completed";
      providerEventId: string;
      providerPayoutReference: string;
      providerStatus: string;
      occurredAt: string;
    }>
  | Readonly<{
      kind: "payout-failed";
      providerEventId: string;
      providerPayoutReference: string;
      providerStatus: string;
      failureCode: string | null;
      failureMessage: string | null;
      occurredAt: string;
    }>
  | Readonly<{
      kind: "payout-readiness-updated";
      providerEventId: string;
      providerReference: string;
      readiness: ProviderPayoutReadiness;
      occurredAt: string;
    }>;

export type MoneyMovementGateway = Readonly<{
  providerName: string;
  ensurePayoutAccount: (
    input: Readonly<{
      accountId: AccountId;
      currencyCode: CurrencyCode;
      contactEmail?: string | null;
      idempotencyKey: string;
    }>,
  ) => Promise<ProviderPayoutReadiness>;
  createOnboardingSession: (
    input: Readonly<{
      accountId: AccountId;
      providerReference: string;
      returnUrl?: string | null;
      refreshUrl?: string | null;
      idempotencyKey: string;
    }>,
  ) => Promise<CreatedOnboardingSession>;
  createAccountManagementSession: (
    input: Readonly<{
      accountId: AccountId;
      providerReference: string;
      returnUrl?: string | null;
      idempotencyKey: string;
    }>,
  ) => Promise<CreatedAccountManagementSession>;
  refreshPayoutReadiness: (
    input: Readonly<{
      accountId: AccountId;
      providerReference: string;
    }>,
  ) => Promise<ProviderPayoutReadiness>;
  retrievePlatformBalance: (
    input: Readonly<{ currencyCode: CurrencyCode }>,
  ) => Promise<ProviderPlatformBalance>;
  transferPlatformBalanceToConnectedAccount: (
    input: Readonly<{
      payoutId: PayoutId;
      accountId: AccountId;
      providerReference: string;
      amount: string;
      currencyCode: CurrencyCode;
      idempotencyKey: string;
    }>,
  ) => Promise<CreatedProviderTransfer>;
  createConnectedAccountPayout: (
    input: Readonly<{
      payoutId: PayoutId;
      accountId: AccountId;
      providerReference: string;
      amount: string;
      currencyCode: CurrencyCode;
      idempotencyKey: string;
    }>,
  ) => Promise<CreatedProviderPayout>;
  retrieveConnectedAccountPayout: (
    input: Readonly<{
      providerReference: string;
      providerPayoutReference: string;
    }>,
  ) => Promise<RetrievedProviderPayout>;
  parseMoneyMovementWebhook: (
    input: Readonly<{ rawBody: string; signatureHeader: string | null }>,
  ) => Promise<MoneyMovementWebhookEvent | null>;
}>;
