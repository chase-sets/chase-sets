import { createHmac, timingSafeEqual } from "node:crypto";
import type {
  MoneyMovementGateway,
  MoneyMovementWebhookEvent,
  ProviderPayoutReadiness,
} from "@chase-sets/money-movement";
import {
  ProviderAdapterError,
  providerFailureCategoryFromHttpStatus,
  providerFailureCategoryFromText,
} from "@chase-sets/http/provider-errors";

export type StripeConnectMoneyMovementOptions = Readonly<{
  secretKey: string;
  webhookSecret: string;
  accountsApi?: StripeConnectAccountsApi;
  apiBaseUrl?: string;
  webhookToleranceSeconds?: number;
}>;

export type StripeConnectAccountsApi = "v1" | "v2";

type StripeConnectAccountApiStrategy = Readonly<{
  retrieveAccount: (providerReference: string) => Promise<StripeAccountResponse>;
  ensurePayoutAccount: (
    input: Parameters<MoneyMovementGateway["ensurePayoutAccount"]>[0],
  ) => Promise<ProviderPayoutReadiness>;
  updateAccountContactEmail: (
    providerReference: string,
    contactEmail: string | null | undefined,
    idempotencyKey: string,
  ) => Promise<void>;
  handlesReadinessWebhook: (eventType: string) => boolean;
}>;

type StripeAccountResponse = Readonly<{
  id?: string;
  dashboard?: string | null;
  email?: string | null;
  payouts_enabled?: boolean | null;
  external_accounts?: Readonly<{
    data?:
      | readonly Readonly<{
          id?: string | null;
          object?: string | null;
          bank_name?: string | null;
          last4?: string | null;
          currency?: string | null;
          country?: string | null;
          default_for_currency?: boolean | null;
          status?: string | null;
        }>[]
      | null;
  }> | null;
  capabilities?: Readonly<{
    payouts?: string | null;
    transfers?: string | null;
  }> | null;
  controller?: Readonly<{
    fees?: Readonly<{
      payer?: string | null;
    }> | null;
    losses?: Readonly<{
      payments?: string | null;
    }> | null;
    requirement_collection?: string | null;
    stripe_dashboard?: Readonly<{
      type?: string | null;
    }> | null;
  }> | null;
  defaults?: Readonly<{
    responsibilities?: Readonly<{
      losses_collector?: string | null;
      fees_collector?: string | null;
      requirements_collector?: string | null;
    }> | null;
  }> | null;
  requirements?: Readonly<{
    currently_due?: readonly string[];
    eventually_due?: readonly string[];
    past_due?: readonly string[];
    disabled_reason?: string | null;
    entries?: readonly StripeRequirementEntry[];
  }> | null;
  configuration?: Readonly<{
    recipient?: Readonly<{
      capabilities?: Readonly<{
        stripe_balance?: Readonly<{
          stripe_transfers?: Readonly<{
            status?: string | null;
            status_details?: StripeCapabilityStatusDetail | readonly StripeCapabilityStatusDetail[] | null;
          }> | null;
          payouts?: Readonly<{
            status?: string | null;
            status_details?: StripeCapabilityStatusDetail | readonly StripeCapabilityStatusDetail[] | null;
          }> | null;
        }> | null;
      }> | null;
    }> | null;
  }> | null;
  launchPostureRequirements?: readonly string[];
}>;

type StripeRequirementDeadline = Readonly<{
  status?: string | null;
}>;

type StripeRequirementEntry = Readonly<{
  errors?: readonly Readonly<{ code?: string | null; description?: string | null }>[];
  impact?: Readonly<{
    restricts_capabilities?: readonly Readonly<{
      capability?: string | null;
      configuration?: string | null;
      deadline?: StripeRequirementDeadline | null;
    }>[];
  }> | null;
  minimum_deadline?: StripeRequirementDeadline | null;
  reference?: Readonly<{
    inquiry?: string | null;
    resource?: string | null;
    type?: string | null;
  }> | null;
  requested_reasons?: readonly Readonly<{ code?: string | null }>[];
}>;

type StripeCapabilityStatusDetail = Readonly<{
  code?: string | null;
  resolution?: string | null;
}>;

type StripeAccountSessionResponse = Readonly<{
  client_secret?: string | null;
  expires_at?: number | string | null;
}>;

type StripeAccountLinkResponse = Readonly<{
  url?: string | null;
  expires_at?: number | string | null;
}>;

type StripeErrorResponse = Readonly<{
  error?: Readonly<{
    code?: string | null;
    message?: string | null;
  }> | null;
}>;

type StripeBalanceResponse = Readonly<{
  available?: readonly Readonly<{ amount?: number; currency?: string }>[];
}>;

type StripeTransferResponse = Readonly<{
  id?: string;
  status?: string | null;
}>;

type StripePayoutResponse = Readonly<{
  id?: string;
  status?: string | null;
  failure_code?: string | null;
  failure_message?: string | null;
}>;

type StripeEventEnvelope = Readonly<{
  id?: string;
  type?: string;
  created?: number | string;
  data?: Readonly<{
    object?: Record<string, unknown>;
  }>;
  account?: string;
  related_object?: Readonly<{
    id?: string;
  }>;
}>;

const STRIPE_API_VERSION = "2026-03-25.dahlia";

function encodeBasicAuth(secretKey: string) {
  return Buffer.from(`${secretKey}:`).toString("base64");
}

function toFormBody(entries: Record<string, string | readonly string[] | null | undefined>) {
  const params = new URLSearchParams();

  for (const [key, value] of Object.entries(entries)) {
    if (value === null || value === undefined) {
      continue;
    }
    if (typeof value === "string") {
      params.set(key, value);
      continue;
    }
    for (const item of value) {
      params.append(key, item);
    }
  }

  return params;
}

function moneyToMinorUnits(amount: string) {
  return Math.round(Number.parseFloat(amount) * 100);
}

function moneyFromMinorUnits(amount: number) {
  return (amount / 100).toFixed(2);
}

function parseStripeSignature(signatureHeader: string | null) {
  if (!signatureHeader) {
    throw new Error("Stripe-Signature header is required.");
  }

  const parts = signatureHeader.split(",");
  const timestamp = parts
    .find((part) => part.trim().startsWith("t="))
    ?.split("=")[1]
    ?.trim();
  const signature = parts
    .find((part) => part.trim().startsWith("v1="))
    ?.split("=")[1]
    ?.trim();

  if (!timestamp || !signature) {
    throw new Error("Stripe webhook signature is malformed.");
  }

  return { timestamp, signature };
}

function verifyStripeSignature(
  rawBody: string,
  signatureHeader: string | null,
  webhookSecret: string,
  toleranceSeconds: number,
) {
  const parsed = parseStripeSignature(signatureHeader);
  const timestampSeconds = Number.parseInt(parsed.timestamp, 10);
  if (!Number.isFinite(timestampSeconds)) {
    throw new Error("Stripe webhook signature timestamp is malformed.");
  }
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSeconds - timestampSeconds) > toleranceSeconds) {
    throw new Error("Stripe webhook signature timestamp is outside tolerance.");
  }

  const payload = `${parsed.timestamp}.${rawBody}`;
  const expected = createHmac("sha256", webhookSecret).update(payload).digest("hex");
  const expectedBuffer = Buffer.from(expected, "hex");
  const receivedBuffer = Buffer.from(parsed.signature, "hex");

  if (expectedBuffer.length !== receivedBuffer.length || !timingSafeEqual(expectedBuffer, receivedBuffer)) {
    throw new Error("Stripe webhook signature verification failed.");
  }
}

function statusToCapabilityStatus(status: string | null | undefined) {
  switch (status) {
    case "active":
    case "enabled":
      return "active";
    case "pending":
      return "pending";
    case "restricted":
    case "disabled":
    case "inactive":
    case "rejected":
    case "revoked":
      return "inactive";
    default:
      return "inactive";
  }
}

function dashboardToPayoutAccountDashboard(status: string | null | undefined) {
  switch (status) {
    case "none":
    case "express":
    case "full":
      return status;
    default:
      return "unknown";
  }
}

function collectorToPayoutAccountResponsibility(status: string | null | undefined) {
  switch (status) {
    case "application":
    case "stripe":
      return status;
    default:
      return "unknown";
  }
}

function normalizedRequirementStatus(value: string | null | undefined) {
  const normalized = value?.trim();
  return normalized === "currently_due" || normalized === "past_due" || normalized === "eventually_due"
    ? normalized
    : null;
}

function requirementEntryStatuses(entry: StripeRequirementEntry) {
  return [
    normalizedRequirementStatus(entry.minimum_deadline?.status),
    ...(entry.impact?.restricts_capabilities ?? []).map((restriction) =>
      normalizedRequirementStatus(restriction.deadline?.status),
    ),
  ].filter((status): status is NonNullable<ReturnType<typeof normalizedRequirementStatus>> => Boolean(status));
}

function requirementEntryIsActionable(entry: StripeRequirementEntry) {
  const statuses = requirementEntryStatuses(entry);
  return statuses.length === 0 || statuses.some((status) => status === "currently_due" || status === "past_due");
}

function requirementEntryKey(entry: StripeRequirementEntry) {
  const text = [
    entry.reference?.type,
    entry.reference?.resource,
    entry.reference?.inquiry,
    ...(entry.impact?.restricts_capabilities ?? []).flatMap((restriction) => [
      restriction.configuration,
      restriction.capability,
    ]),
    ...(entry.requested_reasons ?? []).map((reason) => reason.code),
    ...(entry.errors ?? []).flatMap((error) => [error.code, error.description]),
  ]
    .filter((value): value is string => Boolean(value?.trim()))
    .join(" ")
    .toLowerCase();

  if (
    text.includes("external_account") ||
    text.includes("payment_method") ||
    text.includes("bank_account") ||
    text.includes("payout") ||
    text.includes("stripe_balance.payouts")
  ) {
    return "payout_account";
  }

  if (text.includes("tos") || text.includes("terms") || text.includes("agreement")) {
    return "account_terms";
  }

  if (
    text.includes("individual") ||
    text.includes("representative") ||
    text.includes("owner") ||
    text.includes("person") ||
    text.includes("identity") ||
    text.includes("business") ||
    text.includes("company") ||
    text.includes("profile") ||
    text.includes("mcc") ||
    text.includes("url")
  ) {
    return "identity_and_business";
  }

  return "verification_review";
}

function collectRequirementEntries(account: StripeAccountResponse) {
  return (account.requirements?.entries ?? []).filter(requirementEntryIsActionable).map(requirementEntryKey);
}

function statusDetailsArray(
  statusDetails: StripeCapabilityStatusDetail | readonly StripeCapabilityStatusDetail[] | null | undefined,
) {
  if (!statusDetails) {
    return [];
  }

  return Array.isArray(statusDetails) ? statusDetails : [statusDetails];
}

function collectCapabilityRequirements(
  capability: "stripe_balance.stripe_transfers" | "stripe_balance.payouts",
  statusDetails: StripeCapabilityStatusDetail | readonly StripeCapabilityStatusDetail[] | null | undefined,
) {
  return statusDetailsArray(statusDetails).flatMap((detail) => {
    const resolution = detail.resolution?.trim();
    const code = detail.code?.trim();
    if (resolution !== "provide_info" && code !== "requirements_past_due") {
      return [];
    }

    return capability === "stripe_balance.payouts" ? ["payout_account"] : ["identity_and_business"];
  });
}

function collectRequirements(account: StripeAccountResponse) {
  return [
    ...(account.requirements?.currently_due ?? []),
    ...(account.requirements?.past_due ?? []),
    ...(account.requirements?.eventually_due ?? []),
    ...collectRequirementEntries(account),
    ...(account.launchPostureRequirements ?? []),
    ...collectCapabilityRequirements(
      "stripe_balance.stripe_transfers",
      account.configuration?.recipient?.capabilities?.stripe_balance?.stripe_transfers?.status_details,
    ),
    ...collectCapabilityRequirements(
      "stripe_balance.payouts",
      account.configuration?.recipient?.capabilities?.stripe_balance?.payouts?.status_details,
    ),
  ]
    .map((item) => item.trim())
    .filter(Boolean);
}

function mapAccountReadiness(account: StripeAccountResponse): ProviderPayoutReadiness {
  const providerReference = account.id?.trim();
  if (!providerReference) {
    throw new Error("Stripe account response did not include an id.");
  }

  const stripeBalance = account.configuration?.recipient?.capabilities?.stripe_balance;
  const transferCapabilityStatus = statusToCapabilityStatus(
    stripeBalance?.stripe_transfers?.status ?? account.capabilities?.transfers,
  );
  const payoutCapabilityStatus = statusToCapabilityStatus(
    stripeBalance?.payouts?.status ??
      account.capabilities?.payouts ??
      (account.payouts_enabled === true ? "active" : account.payouts_enabled === false ? "inactive" : undefined),
  );
  const missingRequirements = [...new Set(collectRequirements(account))].sort((left, right) =>
    left.localeCompare(right),
  );
  const payoutDestinationStatus =
    payoutCapabilityStatus === "active" && missingRequirements.length === 0
      ? "ready"
      : missingRequirements.some(
            (requirement) => requirement.includes("external_account") || requirement.includes("payout"),
          )
        ? "missing"
        : "pending";

  return {
    providerReference,
    contactEmail: normalizeContactEmail(account.email),
    onboardingStatus: missingRequirements.length === 0 ? "complete" : "pending",
    transferCapabilityStatus,
    payoutCapabilityStatus,
    payoutDestinationStatus,
    payoutDestinationFingerprint: payoutDestinationFingerprint(account),
    payoutAccountDashboard: dashboardToPayoutAccountDashboard(
      account.dashboard ?? account.controller?.stripe_dashboard?.type,
    ),
    lossesCollector: collectorToPayoutAccountResponsibility(
      account.defaults?.responsibilities?.losses_collector ?? account.controller?.losses?.payments,
    ),
    feesCollector: collectorToPayoutAccountResponsibility(
      account.defaults?.responsibilities?.fees_collector ?? account.controller?.fees?.payer,
    ),
    requirementsCollector: collectorToPayoutAccountResponsibility(
      account.defaults?.responsibilities?.requirements_collector ?? account.controller?.requirement_collection,
    ),
    missingRequirements,
  };
}

function payoutDestinationFingerprint(account: StripeAccountResponse) {
  const destinations = [...(account.external_accounts?.data ?? [])]
    .filter((destination) => destination.object === "bank_account" || destination.object === "card")
    .sort((left, right) => {
      const leftDefault = left.default_for_currency === true ? 0 : 1;
      const rightDefault = right.default_for_currency === true ? 0 : 1;
      return leftDefault - rightDefault || String(left.id ?? "").localeCompare(String(right.id ?? ""));
    });
  const destination = destinations[0];
  const id = destination?.id?.trim();
  if (!id) {
    return null;
  }

  return [
    id,
    destination.object ?? "unknown",
    destination.country ?? "unknown",
    destination.currency ?? "unknown",
    destination.last4 ?? "unknown",
    destination.status ?? "unknown",
  ].join(":");
}

function occurredAtFromEvent(event: StripeEventEnvelope) {
  const created = event.created;
  const timestamp =
    typeof created === "number"
      ? created * 1000
      : typeof created === "string" && /^\d+$/.test(created.trim())
        ? Number.parseInt(created.trim(), 10) * 1000
        : typeof created === "string"
          ? Date.parse(created)
          : Date.now();

  return new Date(Number.isFinite(timestamp) ? timestamp : Date.now()).toISOString();
}

function expiresAtFromStripeTimestamp(value: number | string | null | undefined) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const timestamp =
    typeof value === "number"
      ? value * 1000
      : /^\d+$/.test(value)
        ? Number.parseInt(value, 10) * 1000
        : Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    return null;
  }

  return new Date(timestamp).toISOString();
}

function providerEventIdFromEvent(event: StripeEventEnvelope, fallbackReference: string) {
  return event.id?.trim() || `stripe:${event.type ?? "event"}:${fallbackReference}`;
}

function accountReferenceFromReadinessWebhook(
  event: StripeEventEnvelope,
  object: Record<string, unknown> | null | undefined,
) {
  const references = [object?.id, event.related_object?.id, event.account];

  for (const reference of references) {
    const normalized = typeof reference === "string" ? reference.trim() : "";
    if (normalized) {
      return normalized;
    }
  }

  return null;
}

function providerFailureCategoryFromStripeError(message: string, status: number, code?: string | null) {
  const classifiedText = [code, message].filter(Boolean).join(" ");
  if (classifiedText.toLowerCase().includes("rejected")) {
    return "provider_declined";
  }

  return providerFailureCategoryFromText(classifiedText, providerFailureCategoryFromHttpStatus(status));
}

function normalizeContactEmail(value: string | null | undefined) {
  const contactEmail = value?.trim();
  return contactEmail ? contactEmail : null;
}

function v1AccountLaunchPostureRequirements(account: StripeAccountResponse) {
  const requirements: string[] = [];
  if (dashboardToPayoutAccountDashboard(account.controller?.stripe_dashboard?.type) !== "none") {
    requirements.push("provider_dashboard_posture");
  }
  if (collectorToPayoutAccountResponsibility(account.controller?.losses?.payments) !== "application") {
    requirements.push("provider_loss_liability_posture");
  }
  if (collectorToPayoutAccountResponsibility(account.controller?.fees?.payer) !== "application") {
    requirements.push("provider_fee_payer_posture");
  }
  if (collectorToPayoutAccountResponsibility(account.controller?.requirement_collection) !== "application") {
    requirements.push("provider_requirement_collection_posture");
  }

  return requirements;
}

function normalizeV1Account(account: StripeAccountResponse): StripeAccountResponse {
  return {
    ...account,
    launchPostureRequirements: v1AccountLaunchPostureRequirements(account),
  };
}

export function createStripeConnectMoneyMovementGateway(
  options: StripeConnectMoneyMovementOptions,
): MoneyMovementGateway {
  const apiBaseUrl = options.apiBaseUrl?.trim() || "https://api.stripe.com";
  const accountsApi = options.accountsApi ?? "v2";
  const authorization = `Basic ${encodeBasicAuth(options.secretKey)}`;
  const webhookToleranceSeconds = options.webhookToleranceSeconds ?? 300;

  async function stripeRequest<T>(
    path: string,
    init: RequestInit & Readonly<{ idempotencyKey?: string; stripeAccount?: string }> = {},
  ) {
    const headers = new Headers(init.headers);
    headers.set("Authorization", authorization);
    headers.set("Stripe-Version", STRIPE_API_VERSION);
    if (init.idempotencyKey) {
      headers.set("Idempotency-Key", init.idempotencyKey);
    }
    if (init.stripeAccount) {
      headers.set("Stripe-Account", init.stripeAccount);
    }

    const response = await fetch(`${apiBaseUrl}${path}`, {
      ...init,
      headers,
    });
    const body = await response.json().catch(() => null);

    if (!response.ok) {
      const stripeError =
        typeof body === "object" && body !== null && "error" in body ? (body as StripeErrorResponse).error : null;
      const message =
        stripeError && typeof stripeError.message === "string"
          ? stripeError.message
          : `Stripe request failed with status ${response.status}.`;

      throw new ProviderAdapterError(
        providerFailureCategoryFromStripeError(message, response.status, stripeError?.code),
        message,
        response.status,
      );
    }

    return body as T;
  }

  function createAccountsV1Strategy(): StripeConnectAccountApiStrategy {
    async function retrieveAccount(providerReference: string) {
      const account = await stripeRequest<StripeAccountResponse>(`/v1/accounts/${providerReference}`, {
        method: "GET",
      });
      return normalizeV1Account(account);
    }

    return {
      retrieveAccount,
      async ensurePayoutAccount(input) {
        const contactEmail = normalizeContactEmail(input.contactEmail);
        const createdAccount = await stripeRequest<StripeAccountResponse>("/v1/accounts", {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: toFormBody({
            country: input.countryCode ?? "US",
            email: contactEmail,
            "capabilities[transfers][requested]": "true",
            "controller[stripe_dashboard][type]": "none",
            "controller[losses][payments]": "application",
            "controller[fees][payer]": "application",
            "controller[requirement_collection]": "application",
            "metadata[chase_sets_account_id]": input.accountId,
            "metadata[funds_strategy]": "platform-held-on-demand-payout",
          }),
          idempotencyKey: input.idempotencyKey,
        });

        const providerReference = createdAccount.id?.trim();
        if (!providerReference) {
          throw new Error("Stripe account response did not include an id.");
        }

        return mapAccountReadiness(await retrieveAccount(providerReference));
      },
      async updateAccountContactEmail(providerReference, contactEmail, idempotencyKey) {
        const normalizedContactEmail = normalizeContactEmail(contactEmail);
        if (!normalizedContactEmail) {
          return;
        }

        await stripeRequest<StripeAccountResponse>(`/v1/accounts/${providerReference}`, {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: toFormBody({
            email: normalizedContactEmail,
          }),
          idempotencyKey,
        });
      },
      handlesReadinessWebhook: (eventType) => eventType === "account.updated",
    };
  }

  function createAccountsV2Strategy(): StripeConnectAccountApiStrategy {
    async function retrieveAccount(providerReference: string) {
      const include = new URLSearchParams();
      include.set("include[0]", "configuration.recipient");
      include.set("include[1]", "requirements");
      include.set("include[2]", "defaults");

      return stripeRequest<StripeAccountResponse>(`/v2/core/accounts/${providerReference}?${include.toString()}`, {
        method: "GET",
      });
    }

    async function updateAccountContactEmail(
      providerReference: string,
      contactEmail: string | null | undefined,
      idempotencyKey: string,
    ) {
      const normalizedContactEmail = normalizeContactEmail(contactEmail);
      if (!normalizedContactEmail) {
        return;
      }

      await stripeRequest<StripeAccountResponse>(`/v2/core/accounts/${providerReference}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ contact_email: normalizedContactEmail }),
        idempotencyKey,
      });
    }

    return {
      retrieveAccount,
      async ensurePayoutAccount(input) {
        const contactEmail = normalizeContactEmail(input.contactEmail);
        const createdAccount = await stripeRequest<StripeAccountResponse>("/v2/core/accounts", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            ...(contactEmail ? { contact_email: contactEmail } : {}),
            identity: {
              country: input.countryCode ?? "US",
            },
            metadata: {
              chase_sets_account_id: input.accountId,
            },
            configuration: {
              recipient: {
                capabilities: {
                  stripe_balance: {
                    stripe_transfers: {
                      requested: true,
                    },
                  },
                },
              },
            },
            defaults: {
              responsibilities: {
                losses_collector: "application",
                fees_collector: "application",
              },
            },
            dashboard: "none",
          }),
          idempotencyKey: input.idempotencyKey,
        });

        const providerReference = createdAccount.id?.trim();
        if (!providerReference) {
          throw new Error("Stripe account response did not include an id.");
        }

        return mapAccountReadiness(await retrieveAccount(providerReference));
      },
      updateAccountContactEmail,
      handlesReadinessWebhook: (eventType) =>
        eventType === "v2.core.account[requirements].updated" || eventType === "v2.core.account.updated",
    };
  }

  const accountStrategy = accountsApi === "v1" ? createAccountsV1Strategy() : createAccountsV2Strategy();

  async function configureOnDemandPayouts(providerReference: string, idempotencyKey: string) {
    await stripeRequest<unknown>("/v1/balance_settings", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: toFormBody({
        "payments[payouts][schedule][interval]": "manual",
      }),
      idempotencyKey,
      stripeAccount: providerReference,
    });
  }

  async function createEmbeddedAccountSession(
    providerReference: string,
    component: "account_onboarding" | "account_management",
    idempotencyKey: string,
    readiness: ProviderPayoutReadiness,
  ) {
    const disableStripeUserAuthentication = readiness.requirementsCollector === "application";
    const accountSession = await stripeRequest<StripeAccountSessionResponse>("/v1/account_sessions", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: toFormBody({
        account: providerReference,
        [`components[${component}][enabled]`]: "true",
        [`components[${component}][features][external_account_collection]`]: "true",
        [`components[${component}][features][disable_stripe_user_authentication]`]: disableStripeUserAuthentication
          ? "true"
          : "false",
      }),
      idempotencyKey,
    });

    if (!accountSession.client_secret?.trim()) {
      throw new Error("Stripe did not return an account session client secret.");
    }

    return {
      clientSecret: accountSession.client_secret,
      expiresAt: expiresAtFromStripeTimestamp(accountSession.expires_at),
    };
  }

  return {
    providerName: "stripe",
    async ensurePayoutAccount(input) {
      const readiness = await accountStrategy.ensurePayoutAccount(input);
      await configureOnDemandPayouts(readiness.providerReference, `${input.idempotencyKey}:manual-payouts`);

      return readiness;
    },
    async createPayoutSetupSession(input) {
      await accountStrategy.updateAccountContactEmail(
        input.providerReference,
        input.contactEmail,
        `${input.idempotencyKey}:contact-email`,
      );
      const readiness = mapAccountReadiness(await accountStrategy.retrieveAccount(input.providerReference));
      const session = await createEmbeddedAccountSession(
        input.providerReference,
        "account_onboarding",
        input.idempotencyKey,
        readiness,
      );

      return {
        providerReference: input.providerReference,
        clientSecret: session.clientSecret,
        expiresAt: session.expiresAt,
        components: ["payout-setup"],
        readiness,
      };
    },
    async createPayoutAccountManagementSession(input) {
      const readiness = mapAccountReadiness(await accountStrategy.retrieveAccount(input.providerReference));
      const session = await createEmbeddedAccountSession(
        input.providerReference,
        "account_management",
        input.idempotencyKey,
        readiness,
      );

      return {
        providerReference: input.providerReference,
        clientSecret: session.clientSecret,
        expiresAt: session.expiresAt,
        components: ["payout-account-management"],
      };
    },
    async createPayoutSetupLink(input) {
      await accountStrategy.updateAccountContactEmail(
        input.providerReference,
        input.contactEmail,
        `${input.idempotencyKey}:contact-email`,
      );
      const readiness = mapAccountReadiness(await accountStrategy.retrieveAccount(input.providerReference));
      const accountLink = await stripeRequest<StripeAccountLinkResponse>("/v1/account_links", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: toFormBody({
          account: input.providerReference,
          type: "account_onboarding",
          return_url: input.returnUrl,
          refresh_url: input.refreshUrl,
        }),
        idempotencyKey: input.idempotencyKey,
      });
      const url = accountLink.url?.trim();
      if (!url) {
        throw new Error("Stripe did not return an account link URL.");
      }

      return {
        providerReference: input.providerReference,
        url,
        expiresAt: expiresAtFromStripeTimestamp(accountLink.expires_at),
        readiness,
      };
    },
    async refreshPayoutReadiness(input) {
      return mapAccountReadiness(await accountStrategy.retrieveAccount(input.providerReference));
    },
    async retrievePlatformBalance(input) {
      const balance = await stripeRequest<StripeBalanceResponse>("/v1/balance", {
        method: "GET",
      });
      const availableAmount = (balance.available ?? [])
        .filter((entry) => entry.currency === input.currencyCode)
        .reduce((sum, entry) => sum + (entry.amount ?? 0), 0);

      return {
        currencyCode: input.currencyCode,
        availableAmount: moneyFromMinorUnits(availableAmount),
      };
    },
    async transferPlatformBalanceToConnectedAccount(input) {
      const transfer = await stripeRequest<StripeTransferResponse>("/v1/transfers", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: toFormBody({
          amount: String(moneyToMinorUnits(input.amount)),
          currency: input.currencyCode,
          destination: input.providerReference,
          transfer_group: `payout:${input.payoutId}`,
          "metadata[funds_strategy]": "platform-held-on-demand-payout",
          "metadata[payout_id]": input.payoutId,
          "metadata[account_id]": input.accountId,
          "metadata[source_balance]": "platform",
        }),
        idempotencyKey: input.idempotencyKey,
      });

      if (!transfer.id?.trim()) {
        throw new Error("Stripe did not return a transfer id.");
      }

      return {
        providerTransferReference: transfer.id,
        providerStatus: transfer.status?.trim() || "created",
      };
    },
    async createConnectedAccountPayout(input) {
      await configureOnDemandPayouts(input.providerReference, `${input.idempotencyKey}:manual-payouts`);
      const payout = await stripeRequest<StripePayoutResponse>("/v1/payouts", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: toFormBody({
          amount: String(moneyToMinorUnits(input.amount)),
          currency: input.currencyCode,
          "metadata[funds_strategy]": "platform-held-on-demand-payout",
          "metadata[transfer_group]": `payout:${input.payoutId}`,
          "metadata[payout_id]": input.payoutId,
          "metadata[account_id]": input.accountId,
        }),
        idempotencyKey: input.idempotencyKey,
        stripeAccount: input.providerReference,
      });

      if (!payout.id?.trim()) {
        throw new Error("Stripe did not return a payout id.");
      }

      return {
        providerPayoutReference: payout.id,
        providerStatus: payout.status?.trim() || "pending",
      };
    },
    async retrieveConnectedAccountPayout(input, options = {}) {
      const payout = await stripeRequest<StripePayoutResponse>(
        `/v1/payouts/${encodeURIComponent(input.providerPayoutReference)}`,
        {
          method: "GET",
          stripeAccount: input.providerReference,
          signal: options.signal,
        },
      );

      if (!payout.id?.trim()) {
        throw new Error("Stripe did not return a payout id.");
      }

      return {
        providerPayoutReference: payout.id,
        providerStatus: payout.status?.trim() || "pending",
        failureCode: payout.failure_code?.trim() || null,
        failureMessage: payout.failure_message?.trim() || null,
      };
    },
    async parseMoneyMovementWebhook(input) {
      verifyStripeSignature(input.rawBody, input.signatureHeader, options.webhookSecret, webhookToleranceSeconds);
      const event = JSON.parse(input.rawBody) as StripeEventEnvelope;
      const object = event.data?.object;

      if (event.type && accountStrategy.handlesReadinessWebhook(event.type)) {
        const providerReference = accountReferenceFromReadinessWebhook(event, object);
        if (!providerReference) {
          return null;
        }
        const readiness = mapAccountReadiness(await accountStrategy.retrieveAccount(providerReference));

        return {
          kind: "payout-readiness-updated",
          providerEventId: providerEventIdFromEvent(event, providerReference),
          providerReference,
          readiness,
          occurredAt: occurredAtFromEvent(event),
        } satisfies MoneyMovementWebhookEvent;
      }

      if (!object || typeof object !== "object") {
        return null;
      }

      const occurredAt = occurredAtFromEvent(event);

      if (event.type === "payout.paid") {
        const providerPayoutReference = String(object.id ?? "").trim();
        if (!providerPayoutReference) {
          return null;
        }
        return {
          kind: "payout-completed",
          providerEventId: providerEventIdFromEvent(event, providerPayoutReference),
          providerPayoutReference,
          providerStatus: String(object.status ?? "paid"),
          occurredAt,
        } satisfies MoneyMovementWebhookEvent;
      }

      if (event.type === "payout.failed") {
        const providerPayoutReference = String(object.id ?? "").trim();
        if (!providerPayoutReference) {
          return null;
        }
        return {
          kind: "payout-failed",
          providerEventId: providerEventIdFromEvent(event, providerPayoutReference),
          providerPayoutReference,
          providerStatus: String(object.status ?? "failed"),
          failureCode: typeof object.failure_code === "string" ? object.failure_code : null,
          failureMessage: typeof object.failure_message === "string" ? object.failure_message : null,
          occurredAt,
        } satisfies MoneyMovementWebhookEvent;
      }

      return null;
    },
  };
}
