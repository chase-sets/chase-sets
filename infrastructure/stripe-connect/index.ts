import { createHmac, timingSafeEqual } from "node:crypto";
import type {
  MoneyMovementGateway,
  MoneyMovementWebhookEvent,
  ProviderPayoutReadiness,
} from "@chase-sets/money-movement";

export type StripeConnectMoneyMovementOptions = Readonly<{
  secretKey: string;
  webhookSecret: string;
  apiBaseUrl?: string;
  onboardingReturnUrl?: string;
  onboardingRefreshUrl?: string;
}>;

type StripeAccountResponse = Readonly<{
  id?: string;
  requirements?: Readonly<{
    currently_due?: readonly string[];
    eventually_due?: readonly string[];
    past_due?: readonly string[];
    disabled_reason?: string | null;
  }> | null;
  configuration?: Readonly<{
    recipient?: Readonly<{
      capabilities?: Readonly<{
        stripe_balance?: Readonly<{
          stripe_transfers?: Readonly<{
            status?: string | null;
            status_details?: Readonly<{ code?: string | null }> | null;
          }> | null;
          payouts?: Readonly<{
            status?: string | null;
            status_details?: Readonly<{ code?: string | null }> | null;
          }> | null;
        }> | null;
      }> | null;
    }> | null;
  }> | null;
}>;

type StripeAccountLinkResponse = Readonly<{
  url?: string | null;
  expires_at?: number | null;
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
  created?: number;
  data?: Readonly<{
    object?: Record<string, unknown>;
  }>;
}>;

const STRIPE_API_VERSION = "2026-02-25.clover";

function encodeBasicAuth(secretKey: string) {
  return Buffer.from(`${secretKey}:`).toString("base64");
}

function toFormBody(
  entries: Record<string, string | readonly string[] | null | undefined>,
) {
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
) {
  const parsed = parseStripeSignature(signatureHeader);
  const payload = `${parsed.timestamp}.${rawBody}`;
  const expected = createHmac("sha256", webhookSecret).update(payload).digest("hex");
  const expectedBuffer = Buffer.from(expected, "hex");
  const receivedBuffer = Buffer.from(parsed.signature, "hex");

  if (
    expectedBuffer.length !== receivedBuffer.length ||
    !timingSafeEqual(expectedBuffer, receivedBuffer)
  ) {
    throw new Error("Stripe webhook signature verification failed.");
  }
}

function statusToCapabilityStatus(status: string | null | undefined) {
  switch (status) {
    case "active":
    case "enabled":
      return "active";
    case "pending":
    case "restricted":
      return "pending";
    default:
      return "inactive";
  }
}

function collectRequirements(account: StripeAccountResponse) {
  return [
    ...(account.requirements?.currently_due ?? []),
    ...(account.requirements?.past_due ?? []),
    ...(account.requirements?.eventually_due ?? []),
  ].map((item) => item.trim()).filter(Boolean);
}

function mapAccountReadiness(account: StripeAccountResponse): ProviderPayoutReadiness {
  const providerReference = account.id?.trim();
  if (!providerReference) {
    throw new Error("Stripe account response did not include an id.");
  }

  const stripeBalance =
    account.configuration?.recipient?.capabilities?.stripe_balance;
  const transferCapabilityStatus = statusToCapabilityStatus(
    stripeBalance?.stripe_transfers?.status,
  );
  const payoutCapabilityStatus = statusToCapabilityStatus(
    stripeBalance?.payouts?.status,
  );
  const missingRequirements = [...new Set(collectRequirements(account))].sort(
    (left, right) => left.localeCompare(right),
  );
  const payoutDestinationStatus =
    payoutCapabilityStatus === "active" && missingRequirements.length === 0
      ? "ready"
      : missingRequirements.some((requirement) =>
          requirement.includes("external_account") ||
          requirement.includes("payout")
        )
      ? "missing"
      : "pending";

  return {
    providerReference,
    onboardingStatus: missingRequirements.length === 0 ? "complete" : "pending",
    transferCapabilityStatus,
    payoutCapabilityStatus,
    payoutDestinationStatus,
    missingRequirements,
  };
}

function occurredAtFromEvent(event: StripeEventEnvelope) {
  return new Date((event.created ?? Math.floor(Date.now() / 1000)) * 1000)
    .toISOString();
}

function providerEventIdFromEvent(event: StripeEventEnvelope, fallbackReference: string) {
  return event.id?.trim() || `stripe:${event.type ?? "event"}:${fallbackReference}`;
}

export function createStripeConnectMoneyMovementGateway(
  options: StripeConnectMoneyMovementOptions,
): MoneyMovementGateway {
  const apiBaseUrl = options.apiBaseUrl?.trim() || "https://api.stripe.com";
  const authorization = `Basic ${encodeBasicAuth(options.secretKey)}`;

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
      const message =
        typeof body === "object" &&
        body !== null &&
        "error" in body &&
        typeof (body as { error?: { message?: unknown } }).error?.message ===
          "string"
          ? (body as { error: { message: string } }).error.message
          : `Stripe request failed with status ${response.status}.`;

      throw new Error(message);
    }

    return body as T;
  }

  async function retrieveAccount(providerReference: string) {
    const include = new URLSearchParams();
    include.append("include[]", "configuration.recipient");
    include.append("include[]", "requirements");

    return stripeRequest<StripeAccountResponse>(
      `/v2/core/accounts/${providerReference}?${include.toString()}`,
      { method: "GET" },
    );
  }

  return {
    providerName: "stripe",
    async ensurePayoutAccount(input) {
      const account = await stripeRequest<StripeAccountResponse>(
        "/v2/core/accounts",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: toFormBody({
            "metadata[chase_sets_account_id]": input.accountId,
            "configuration[recipient][capabilities][stripe_balance][stripe_transfers][requested]":
              "true",
            "configuration[recipient][capabilities][stripe_balance][payouts][requested]":
              "true",
            "defaults[responsibilities][losses_collector]": "application",
            "dashboard[type]": "express",
          }),
          idempotencyKey: input.idempotencyKey,
        },
      );

      return mapAccountReadiness(account);
    },
    async createOnboardingSession(input) {
      const returnUrl = input.returnUrl ?? options.onboardingReturnUrl;
      const refreshUrl = input.refreshUrl ?? options.onboardingRefreshUrl;
      if (!returnUrl || !refreshUrl) {
        throw new Error("Payout setup return and refresh URLs are required.");
      }

      const accountLink = await stripeRequest<StripeAccountLinkResponse>(
        "/v2/core/account_links",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: toFormBody({
            account: input.providerReference,
            "use_case[type]": "account_onboarding",
            "use_case[account_onboarding][configurations][]": ["recipient"],
            "use_case[account_onboarding][return_url]": returnUrl,
            "use_case[account_onboarding][refresh_url]": refreshUrl,
            "use_case[account_onboarding][collection_options][fields]":
              "eventually_due",
            "use_case[account_onboarding][collection_options][future_requirements]":
              "include",
          }),
          idempotencyKey: input.idempotencyKey,
        },
      );

      if (!accountLink.url?.trim()) {
        throw new Error("Stripe did not return an onboarding URL.");
      }

      const readiness = mapAccountReadiness(
        await retrieveAccount(input.providerReference),
      );

      return {
        providerReference: input.providerReference,
        url: accountLink.url,
        expiresAt: accountLink.expires_at
          ? new Date(accountLink.expires_at * 1000).toISOString()
          : null,
        readiness,
      };
    },
    async refreshPayoutReadiness(input) {
      return mapAccountReadiness(await retrieveAccount(input.providerReference));
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
          "metadata[payout_id]": input.payoutId,
          "metadata[account_id]": input.accountId,
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
      const payout = await stripeRequest<StripePayoutResponse>("/v1/payouts", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: toFormBody({
          amount: String(moneyToMinorUnits(input.amount)),
          currency: input.currencyCode,
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
    async retrieveConnectedAccountPayout(input) {
      const payout = await stripeRequest<StripePayoutResponse>(
        `/v1/payouts/${encodeURIComponent(input.providerPayoutReference)}`,
        {
          method: "GET",
          stripeAccount: input.providerReference,
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
      verifyStripeSignature(input.rawBody, input.signatureHeader, options.webhookSecret);
      const event = JSON.parse(input.rawBody) as StripeEventEnvelope;
      const object = event.data?.object;
      const occurredAt = occurredAtFromEvent(event);

      if (!object || typeof object !== "object") {
        return null;
      }

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
          failureCode:
            typeof object.failure_code === "string" ? object.failure_code : null,
          failureMessage:
            typeof object.failure_message === "string"
              ? object.failure_message
              : null,
          occurredAt,
        } satisfies MoneyMovementWebhookEvent;
      }

      if (
        event.type === "v2.core.account[requirements].updated" ||
        event.type === "v2.core.account.updated"
      ) {
        const providerReference = String(object.id ?? "").trim();
        return {
          kind: "payout-readiness-updated",
          providerEventId: providerEventIdFromEvent(event, providerReference),
          providerReference,
          readiness: mapAccountReadiness(object as StripeAccountResponse),
          occurredAt,
        } satisfies MoneyMovementWebhookEvent;
      }

      return null;
    },
  };
}
