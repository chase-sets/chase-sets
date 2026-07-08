import type { AccountId, PayoutId } from "@chase-sets/primitives/typed-ids";

export type CurrencyCode = "usd";
export type PayoutAccountCountryCode = "US";
export type ProviderSetupStatus = "not-started" | "pending" | "complete";
export type ProviderCapabilityStatus = "inactive" | "pending" | "active";
export type ProviderPayoutDestinationStatus = "missing" | "pending" | "ready";
export type ProviderPayoutAccountDashboard = "none" | "express" | "full" | "unknown";
export type ProviderPayoutAccountResponsibility = "application" | "stripe" | "unknown";
export type ProviderPayoutAccountSessionComponent = "payout-setup" | "payout-account-management";

export type ProviderPayoutReadiness = Readonly<{
  providerReference: string;
  contactEmail?: string | null;
  onboardingStatus: ProviderSetupStatus;
  transferCapabilityStatus: ProviderCapabilityStatus;
  payoutCapabilityStatus: ProviderCapabilityStatus;
  payoutDestinationStatus: ProviderPayoutDestinationStatus;
  payoutDestinationFingerprint?: string | null;
  payoutAccountDashboard: ProviderPayoutAccountDashboard;
  lossesCollector: ProviderPayoutAccountResponsibility;
  feesCollector: ProviderPayoutAccountResponsibility;
  requirementsCollector: ProviderPayoutAccountResponsibility;
  missingRequirements: readonly string[];
}>;

export type ProviderPlatformBalance = Readonly<{
  currencyCode: CurrencyCode;
  availableAmount: string;
}>;

export type CreatedPayoutSetupSession = Readonly<{
  providerReference: string;
  clientSecret: string;
  expiresAt: string | null;
  components: readonly ["payout-setup"];
  readiness: ProviderPayoutReadiness;
}>;

export type CreatedPayoutAccountManagementSession = Readonly<{
  providerReference: string;
  clientSecret: string;
  expiresAt: string | null;
  components: readonly ["payout-account-management"];
}>;

export type CreatedPayoutSetupLink = Readonly<{
  providerReference: string;
  url: string;
  expiresAt: string | null;
  readiness: ProviderPayoutReadiness;
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
      countryCode?: PayoutAccountCountryCode | null;
      idempotencyKey: string;
    }>,
  ) => Promise<ProviderPayoutReadiness>;
  createPayoutSetupSession: (
    input: Readonly<{
      accountId: AccountId;
      providerReference: string;
      contactEmail?: string | null;
      idempotencyKey: string;
    }>,
  ) => Promise<CreatedPayoutSetupSession>;
  createPayoutAccountManagementSession: (
    input: Readonly<{
      accountId: AccountId;
      providerReference: string;
      idempotencyKey: string;
    }>,
  ) => Promise<CreatedPayoutAccountManagementSession>;
  createPayoutSetupLink: (
    input: Readonly<{
      accountId: AccountId;
      providerReference: string;
      contactEmail?: string | null;
      returnUrl: string;
      refreshUrl: string;
      idempotencyKey: string;
    }>,
  ) => Promise<CreatedPayoutSetupLink>;
  refreshPayoutReadiness: (
    input: Readonly<{
      accountId: AccountId;
      providerReference: string;
    }>,
  ) => Promise<ProviderPayoutReadiness>;
  retrievePlatformBalance: (input: Readonly<{ currencyCode: CurrencyCode }>) => Promise<ProviderPlatformBalance>;
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
    options?: Readonly<{ signal?: AbortSignal }>,
  ) => Promise<RetrievedProviderPayout>;
  parseMoneyMovementWebhook: (
    input: Readonly<{ rawBody: string; signatureHeader: string | null }>,
  ) => Promise<MoneyMovementWebhookEvent | null>;
}>;
