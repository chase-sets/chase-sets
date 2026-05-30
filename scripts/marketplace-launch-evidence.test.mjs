import { describe, expect, it } from "vitest";
import {
  MARKETPLACE_LAUNCH_EVIDENCE_SCHEMA_VERSION,
  validateMarketplaceLaunchEvidence,
} from "./marketplace-launch-evidence.mjs";

const now = new Date("2026-05-30T12:00:00.000Z");
const checkedAt = "2026-05-30T11:00:00.000Z";

function gate(reference, owner = "Operations") {
  return {
    approved: true,
    reference,
    owner,
    checkedAt,
  };
}

function validPacket(overrides = {}) {
  const packet = {
    schemaVersion: MARKETPLACE_LAUNCH_EVIDENCE_SCHEMA_VERSION,
    environment: "production",
    productionEnvironment: {
      PRODUCTION_MARKETPLACE_PUBLIC_ENABLED: "false",
      PRODUCTION_MARKETPLACE_PROMOTION_APPROVED: "true",
      PRODUCTION_MARKETPLACE_PROMOTION_REFERENCE: "LAUNCH-REVIEW-2026-05-30",
      PRODUCTION_MARKETPLACE_CHECKOUT_FEE_APPROVED: "true",
      PRODUCTION_MARKETPLACE_CHECKOUT_FEE_REFERENCE: "PAYMENTS-FEE-2026-05-30",
      PRODUCTION_STRIPE_MONEY_OPERATIONS_APPROVED: "true",
      PRODUCTION_STRIPE_MONEY_OPERATIONS_REFERENCE: "STRIPE-MONEY-2026-05-30",
      PRODUCTION_SUPPORT_OPERATIONS_APPROVED: "true",
      PRODUCTION_SUPPORT_OPERATIONS_REFERENCE: "SUPPORT-OPS-2026-05-30",
      PRODUCTION_FULFILLMENT_POSTAGE_APPROVED: "true",
      PRODUCTION_FULFILLMENT_POSTAGE_REFERENCE: "FULFILLMENT-POSTAGE-2026-05-30",
      PRODUCTION_TRANSACTIONAL_EMAIL_APPROVED: "true",
      PRODUCTION_TRANSACTIONAL_EMAIL_REFERENCE: "NOTIFICATIONS-SES-2026-05-30",
      PRODUCTION_LAUNCH_SUPPLY_MEASUREMENTS_APPROVED: "true",
      PRODUCTION_LAUNCH_SUPPLY_MEASUREMENTS_REFERENCE: "CATALOG-MEASURES-2026-05-30",
      PRODUCTION_TAX_READINESS_APPROVED: "true",
      PRODUCTION_TAX_READINESS_REFERENCE: "TAX-READINESS-2026-05-30",
      TAX_PROVIDER_BACKED_QUOTES_REQUIRED: "false",
    },
    gates: {
      marketplacePromotion: gate("LAUNCH-REVIEW-2026-05-30", "Platform"),
      marketplaceCheckoutFee: gate("PAYMENTS-FEE-2026-05-30", "Payments"),
      stripeMoneyOperations: gate("STRIPE-MONEY-2026-05-30", "Payments and Settlement"),
      supportOperations: gate("SUPPORT-OPS-2026-05-30", "Support"),
      fulfillmentPostage: gate("FULFILLMENT-POSTAGE-2026-05-30", "Fulfillment"),
      transactionalEmail: gate("NOTIFICATIONS-SES-2026-05-30", "Notifications"),
      launchSupplyMeasurements: {
        ...gate("CATALOG-MEASURES-2026-05-30", "Catalog"),
        activeLaunchListingCount: 42,
        activeLaunchListingsMissingResolvedProductMeasures: 0,
        resolvedProductMeasureCoveragePercent: 100,
        queryReference: "launch-supply-measurement-query-2026-05-30",
      },
      taxReadiness: {
        ...gate("TAX-READINESS-2026-05-30", "Tax"),
        posture: "no_collection_required",
        collectionRequiredJurisdictions: [],
        taxProviderBackedQuotesRequired: false,
        providerBackedResolverComposed: false,
      },
      ucpAp2Marketing: {
        owner: "Checkout and Payments",
        publicLaunchClaimsEnabled: false,
        certificationApproved: false,
        certificationReference: "",
      },
    },
  };

  return {
    ...packet,
    ...overrides,
    productionEnvironment: {
      ...packet.productionEnvironment,
      ...(overrides.productionEnvironment ?? {}),
    },
    gates: {
      ...packet.gates,
      ...(overrides.gates ?? {}),
    },
  };
}

describe("marketplace launch evidence verifier", () => {
  it("accepts a complete launch packet while the public switch remains false", () => {
    const result = validateMarketplaceLaunchEvidence(validPacket(), { now });

    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("fails when launch supply has active listings without resolved product measures", () => {
    const result = validateMarketplaceLaunchEvidence(
      validPacket({
        gates: {
          launchSupplyMeasurements: {
            ...validPacket().gates.launchSupplyMeasurements,
            activeLaunchListingsMissingResolvedProductMeasures: 1,
            resolvedProductMeasureCoveragePercent: 97.5,
          },
        },
      }),
      { now },
    );

    expect(result.ok).toBe(false);
    expect(result.errors).toContain(
      "Launch supply measurements must have activeLaunchListingsMissingResolvedProductMeasures=0.",
    );
    expect(result.errors).toContain("Launch supply measurements must have resolvedProductMeasureCoveragePercent=100.");
  });

  it("fails a no-collection tax posture when a collection-required jurisdiction is present", () => {
    const result = validateMarketplaceLaunchEvidence(
      validPacket({
        gates: {
          taxReadiness: {
            ...validPacket().gates.taxReadiness,
            collectionRequiredJurisdictions: ["MN"],
          },
        },
      }),
      { now },
    );

    expect(result.ok).toBe(false);
    expect(result.errors).toContain(
      "Tax readiness cannot use no_collection_required while collectionRequiredJurisdictions is non-empty.",
    );
  });

  it("requires provider-backed tax composition when collection is required", () => {
    const base = validPacket();
    const result = validateMarketplaceLaunchEvidence(
      validPacket({
        productionEnvironment: {
          TAX_PROVIDER_BACKED_QUOTES_REQUIRED: "true",
        },
        gates: {
          taxReadiness: {
            ...base.gates.taxReadiness,
            posture: "provider_backed_quotes_required",
            collectionRequiredJurisdictions: ["MN"],
            taxProviderBackedQuotesRequired: true,
            providerBackedResolverComposed: false,
          },
        },
      }),
      { now },
    );

    expect(result.ok).toBe(false);
    expect(result.errors).toContain(
      "Tax provider_backed_quotes_required posture requires providerBackedResolverComposed=true.",
    );
  });

  it("rejects UCP/AP2 public claims without certification", () => {
    const result = validateMarketplaceLaunchEvidence(
      validPacket({
        gates: {
          ucpAp2Marketing: {
            owner: "Checkout and Payments",
            publicLaunchClaimsEnabled: true,
            certificationApproved: false,
            certificationReference: "",
          },
        },
      }),
      { now },
    );

    expect(result.ok).toBe(false);
    expect(result.errors).toContain("UCP/AP2 public launch claims require certificationApproved=true.");
  });

  it("requires explicit UCP/AP2 marketing evidence", () => {
    const base = validPacket();
    const { ucpAp2Marketing: _ucpAp2Marketing, ...gates } = base.gates;
    const result = validateMarketplaceLaunchEvidence({ ...base, gates }, { now });

    expect(result.ok).toBe(false);
    expect(result.errors).toContain("UCP/AP2 marketing gate is required so public launch claims remain explicit.");
  });

  it("rejects GitHub Environment reference drift", () => {
    const result = validateMarketplaceLaunchEvidence(
      validPacket({
        productionEnvironment: {
          PRODUCTION_FULFILLMENT_POSTAGE_REFERENCE: "WRONG-REFERENCE-2026-05-30",
        },
      }),
      { now },
    );

    expect(result.ok).toBe(false);
    expect(result.errors).toContain("PRODUCTION_FULFILLMENT_POSTAGE_REFERENCE must match the gate reference.");
  });

  it("requires productionEnvironment for GitHub Environment comparison", () => {
    const packet = validPacket();
    const { productionEnvironment: _productionEnvironment, ...withoutProductionEnvironment } = packet;
    const result = validateMarketplaceLaunchEvidence(withoutProductionEnvironment, { now });

    expect(result.ok).toBe(false);
    expect(result.errors).toContain(
      "productionEnvironment is required so packet gates can be compared to GitHub Environment values.",
    );
  });
});
