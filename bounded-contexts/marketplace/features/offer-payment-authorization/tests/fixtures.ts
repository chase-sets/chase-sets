import { Hono } from "hono";
import { createInMemoryEventStore, buildTransportEvent } from "@chase-sets/event-core/test-support";
import { toTransportEvent } from "@chase-sets/event-core/transport";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { createPolicyRuntime } from "@chase-sets/platform-policy/runtime";
import type { MarketplaceApiEnv } from "../../../api";
import { createMarketplaceMutationLookup } from "../../mutation-recovery/api/lookup";
import { createMarketplaceMutationRecoveryRoutes } from "../../mutation-recovery/api/route";
import { createOfferPaymentConsentActivationRoutes } from "../../offer-payment-consent/api/activation-route";
import {
  OFFER_AUTOMATIC_CHARGE_V1,
  offerPaymentConsentPublications,
} from "../../offer-payment-consent/domain/consent-text";
import { marketplaceOfferPaymentConsentPolicy } from "../../offer-payment-consent/domain/policy";
import { createOfferPaymentAuthorizationRoutes } from "../api/route";
import { createOfferPaymentAuthorization } from "../api/runtime";
import { buildAuthorizationProjection } from "../read-model/projection";

export const now = new Date("2026-11-23T12:00:00Z");
export const card = { useBalance: false, instrumentId: "card_one" } as const;
export const bank = { useBalance: false, instrumentId: "bank_one" } as const;
export const balance = { useBalance: true, instrumentId: null } as const;
export const context: EventStoreContext = {
  tenantId: "tnt_test" as never,
  audit: { forAccountId: "acc_buyer" as never, performedByUserId: "usr_buyer" as never },
};
export const path = "/account/offer-payment";
export const publication = offerPaymentConsentPublications[OFFER_AUTOMATIC_CHARGE_V1]!;
export const nextPublication = {
  ...publication,
  version: "offer-automatic-charge-v2",
  contentFingerprint: `sha256:${"2".repeat(64)}`,
};
export const publications = { ...offerPaymentConsentPublications, [nextPublication.version]: nextPublication };
export const post = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

export function withActor(requestContext = context) {
  const app = new Hono<MarketplaceApiEnv>();
  app.use("*", async (c, next) => {
    c.set("context", requestContext);
    c.set("actor", {
      tenantId: requestContext.tenantId,
      accountId: requestContext.audit.forAccountId,
      userId: requestContext.audit.performedByUserId,
      permissions: ["platform-policy.manage"],
      roleKey: "platform-admin",
      sessionId: "ses_test",
      membershipId: "mbr_test",
      authenticatedAt: now.toISOString(),
    });
    await next();
  });
  return app;
}

export function instrument(instrumentId: string = card.instrumentId, category = "card", readiness = "ready") {
  return {
    instrumentId,
    paymentMethodCategory: category,
    readiness,
    displayLabel: `Label ${instrumentId}`,
    checkoutEligible: true,
    removedAt: null,
    confirmationExperience: "off-session-token",
    instrumentRiskClusterKey: null,
    isDefault: false,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
}

export function snapshot(streamVersion: number, instruments: readonly ReturnType<typeof instrument>[]) {
  return buildTransportEvent(
    "payments.checkout-affordances-published",
    {
      accountId: context.audit.forAccountId,
      savedCheckoutInstruments: instruments,
      publishedAt: now.toISOString(),
    },
    { streamVersion, audit: context.audit, tenantId: context.tenantId },
  );
}

export function fakeProjectionDb() {
  const authorizations = new Map<unknown, Record<string, unknown>>();
  const instruments = new Map<unknown, Record<string, unknown>[]>();
  const versions = new Map<unknown, number>();
  const query = async (sql: string, args: readonly unknown[] = []) => {
    const account = args[0];
    if (sql.includes("INSERT INTO marketplace_buyer_payment_instrument_snapshots")) {
      const version = Number(args[2]);
      if ((versions.get(account) ?? 0) >= version) return { rows: [], rowCount: 0 };
      versions.set(account, version);
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("DELETE FROM marketplace_buyer_payment_instruments")) instruments.set(account, []);
    else if (sql.includes("INSERT INTO marketplace_buyer_payment_instruments")) {
      instruments.get(account)!.push({
        instrument_id: args[1],
        category: args[2],
        readiness: args[3],
        checkout_eligible: args[4],
        display_label: args[5],
        removed_at: args[6],
      });
    } else if (sql.includes("INSERT INTO marketplace_offer_payment_authorizations")) {
      if (Number(authorizations.get(account)?.stream_version ?? 0) < Number(args[8])) {
        const keys = [
          "account_id",
          "state",
          "generation",
          "use_balance",
          "instrument_id",
          "instrument_category",
          "consent_version",
          "latest_held_order_id",
          "stream_version",
        ];
        authorizations.set(account, Object.fromEntries(keys.map((key, index) => [key, args[index]])));
      }
    } else if (sql.includes("FROM marketplace_buyer_payment_instruments"))
      return {
        rows: (instruments.get(account) ?? [])
          .filter((row) => args.length < 2 || row.instrument_id === args[1])
          .sort((a, b) => String(a.instrument_id).localeCompare(String(b.instrument_id))),
      };
    else if (sql.includes("FROM marketplace_offer_payment_authorizations")) {
      const row = authorizations.get(account);
      return { rows: row ? [row] : [] };
    }
    return { rows: [], rowCount: 1 };
  };
  return { db: { query } as PgQueryable, authorizations, instruments, versions };
}

export async function activatePolicy(
  app: Hono<MarketplaceApiEnv>,
  policies: ReturnType<typeof createPolicyRuntime>,
  version = publication,
  buyer = context,
  activate = true,
) {
  const { documentId } = await policies.createPolicyDocument(
    marketplaceOfferPaymentConsentPolicy,
    {
      value: { approvedConsentVersion: version.version },
      status: "active",
      effectiveFrom: "2026-11-23T00:00:00Z",
      effectiveUntil: "2026-11-24T00:00:00Z",
      actorUserId: buyer.audit.performedByUserId,
    },
    buyer,
  );
  if (!activate) return;
  const response = await app.request(
    "/policies/offer-payment-consent/activate",
    post({ documentId, version: version.version, contentFingerprint: version.contentFingerprint }),
  );
  if (!response.ok) throw new Error(`Fixture activation failed: ${await response.text()}`);
}

export function fixture() {
  const { eventStore: store } = createInMemoryEventStore();
  const model = fakeProjectionDb();
  const policies = createPolicyRuntime({ eventStore: store, db: model.db, now: () => now });
  const runtime = createOfferPaymentAuthorization({ eventStore: store, db: model.db, now: () => now });
  const app = withActor();
  app.route(path, createOfferPaymentAuthorizationRoutes(runtime));
  app.route("/", createMarketplaceMutationRecoveryRoutes(createMarketplaceMutationLookup(store)));
  app.route(
    "/",
    createOfferPaymentConsentActivationRoutes(policies, {
      deploymentEnvironment: "test",
      publications,
      now: () => now,
    }),
  );
  const handlers = buildAuthorizationProjection(model.db);
  async function project() {
    for (const event of await store.readAll()) await handlers[event.eventType]?.(toTransportEvent(event));
  }
  return { ...model, policies, runtime, app, store, project, activate: () => activatePolicy(app, policies) };
}

let operation = 0;
export function identity(expectedVersion: number) {
  operation++;
  return { operationId: `operation_${operation}`, attemptId: `test_attempt_identity_${operation}`, expectedVersion };
}
