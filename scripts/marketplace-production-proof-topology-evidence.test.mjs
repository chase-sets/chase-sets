import { describe, expect, it } from "vitest";
import {
  PRIVATE_PROOF_API_PATHS,
  PRIVATE_PROOF_WEB_PATHS,
  PROVIDER_CALLBACK_PATHS,
  PRODUCTION_PROOF_TOPOLOGY_EVIDENCE_VERSION,
  buildProductionProofTopologyEvidence,
  collectProductionProofTopologyEvidence,
  parseProductionProofTopologyArgs,
} from "./marketplace-production-proof-topology-evidence.mjs";

function passingPrivateProofWebRoutes(baseUrl) {
  return PRIVATE_PROOF_WEB_PATHS.map((check) => ({
    ...check,
    url: `${baseUrl}${check.path}`,
    responseUrl: `${baseUrl}${check.path}`,
    status: 302,
    ok: false,
    contentType: "text/html",
    location: "/sign-in?returnTo=%2Faccount%2Fpayouts%2Fsetup",
    reachable: true,
  }));
}

describe("marketplace production proof topology evidence", () => {
  it("passes when proof mode is enabled, public launch is closed, health, callbacks, and private APIs are routed", async () => {
    const evidence = await collectProductionProofTopologyEvidence(
      {
        baseUrl: "https://chasesets.com",
        reference: "PRODUCTION-PROOF-2026-05-30",
        operator: "ops@chasesets.com",
        checkedAt: "2026-05-30T12:00:00.000Z",
        productionMarketplaceProofEnabled: "true",
        productionMarketplacePublicEnabled: "false",
      },
      async (url) => ({
        status:
          url.pathname === "/api/health/ready"
            ? 200
            : PROVIDER_CALLBACK_PATHS.includes(url.pathname)
              ? 400
              : url.pathname === "/account/payouts/setup"
                ? 302
                : 401,
        ok: url.pathname === "/api/health/ready",
        url: url.toString(),
        redirected: false,
        headers: new Headers({
          "content-type": url.pathname === "/account/payouts/setup" ? "text/html" : "application/json",
          location: url.pathname === "/account/payouts/setup" ? "/sign-in?returnTo=%2Faccount%2Fpayouts%2Fsetup" : "",
        }),
      }),
    );

    expect(evidence.schemaVersion).toBe(PRODUCTION_PROOF_TOPOLOGY_EVIDENCE_VERSION);
    expect(evidence.providerCallbacks.map((row) => row.path)).toEqual(PROVIDER_CALLBACK_PATHS);
    expect(evidence.privateProofApis.map((row) => ({ method: row.method, path: row.path }))).toEqual(
      PRIVATE_PROOF_API_PATHS,
    );
    expect(evidence.privateProofWebRoutes.map((row) => ({ method: row.method, path: row.path }))).toEqual(
      PRIVATE_PROOF_WEB_PATHS,
    );
    expect(evidence.passesProductionProofTopologyGate).toBe(true);
    expect(evidence.errors).toEqual([]);
  });

  it("fails when provider callback paths still return 404", () => {
    const evidence = buildProductionProofTopologyEvidence({
      baseUrl: "https://chasesets.com",
      reference: "PRODUCTION-PROOF-2026-05-30",
      operator: "ops@chasesets.com",
      checkedAt: "2026-05-30T12:00:00.000Z",
      productionMarketplaceProofEnabled: "true",
      productionMarketplacePublicEnabled: "false",
      health: {
        url: "https://chasesets.com/api/health/ready",
        responseUrl: "https://chasesets.com/api/health/ready",
        status: 200,
        ok: true,
        contentType: "application/json",
      },
      providerCallbacks: PROVIDER_CALLBACK_PATHS.map((path) => ({
        path,
        url: `https://chasesets.com${path}`,
        responseUrl: `https://chasesets.com${path}`,
        status: 404,
        ok: false,
        contentType: "application/json",
        reachable: false,
      })),
      privateProofApis: PRIVATE_PROOF_API_PATHS.map((check) => ({
        ...check,
        url: `https://chasesets.com${check.path}`,
        responseUrl: `https://chasesets.com${check.path}`,
        status: 401,
        ok: false,
        contentType: "application/json",
        reachable: true,
      })),
      privateProofWebRoutes: passingPrivateProofWebRoutes("https://chasesets.com"),
    });

    expect(evidence.passesProductionProofTopologyGate).toBe(false);
    expect(evidence.errors).toContain(
      "Production proof topology callback /api/payments/provider/webhooks must not return 404.",
    );
    expect(evidence.errors).toContain(
      "Production proof topology callback /api/settlement/provider/money-movement/webhooks must not return 404.",
    );
    expect(evidence.errors).toContain(
      "Production proof topology callback /api/notifications/provider/email/webhooks must not return 404.",
    );
    expect(evidence.errors).toContain(
      "Production proof topology callback /api/fulfillment/provider/postage/webhooks must not return 404.",
    );
  });

  it("fails when proof mode is missing or public launch is enabled", () => {
    const evidence = buildProductionProofTopologyEvidence({
      baseUrl: "https://chasesets.com",
      reference: "PRODUCTION-PROOF-2026-05-30",
      operator: "ops@chasesets.com",
      checkedAt: "2026-05-30T12:00:00.000Z",
      productionMarketplaceProofEnabled: "false",
      productionMarketplacePublicEnabled: "true",
      health: {
        url: "https://chasesets.com/api/health/ready",
        responseUrl: "https://chasesets.com/api/health/ready",
        status: 200,
        ok: true,
        contentType: "application/json",
      },
      providerCallbacks: PROVIDER_CALLBACK_PATHS.map((path) => ({
        path,
        url: `https://chasesets.com${path}`,
        responseUrl: `https://chasesets.com${path}`,
        status: 400,
        ok: false,
        contentType: "application/json",
        reachable: true,
      })),
      privateProofApis: PRIVATE_PROOF_API_PATHS.map((check) => ({
        ...check,
        url: `https://chasesets.com${check.path}`,
        responseUrl: `https://chasesets.com${check.path}`,
        status: 401,
        ok: false,
        contentType: "application/json",
        reachable: true,
      })),
      privateProofWebRoutes: passingPrivateProofWebRoutes("https://chasesets.com"),
    });

    expect(evidence.passesProductionProofTopologyGate).toBe(false);
    expect(evidence.errors).toContain(
      "PRODUCTION_MARKETPLACE_PROOF_ENABLED must be true for production proof topology evidence.",
    );
    expect(evidence.errors).toContain(
      "PRODUCTION_MARKETPLACE_PUBLIC_ENABLED must remain false for production proof topology evidence.",
    );
  });

  it("fails when proof reference is a placeholder or too short", () => {
    const placeholderReference = buildProductionProofTopologyEvidence({
      baseUrl: "https://chasesets.com",
      reference: "launch-000",
      operator: "ops@chasesets.com",
      checkedAt: "2026-05-30T12:00:00.000Z",
      productionMarketplaceProofEnabled: "true",
      productionMarketplacePublicEnabled: "false",
      health: {
        url: "https://chasesets.com/api/health/ready",
        responseUrl: "https://chasesets.com/api/health/ready",
        status: 200,
        ok: true,
        contentType: "application/json",
      },
      providerCallbacks: PROVIDER_CALLBACK_PATHS.map((path) => ({
        path,
        url: `https://chasesets.com${path}`,
        responseUrl: `https://chasesets.com${path}`,
        status: 400,
        ok: false,
        contentType: "application/json",
        reachable: true,
      })),
      privateProofApis: PRIVATE_PROOF_API_PATHS.map((check) => ({
        ...check,
        url: `https://chasesets.com${check.path}`,
        responseUrl: `https://chasesets.com${check.path}`,
        status: 401,
        ok: false,
        contentType: "application/json",
        reachable: true,
      })),
      privateProofWebRoutes: passingPrivateProofWebRoutes("https://chasesets.com"),
    });

    const shortReference = buildProductionProofTopologyEvidence({
      ...placeholderReference,
      reference: "abc",
    });

    expect(placeholderReference.passesProductionProofTopologyGate).toBe(false);
    expect(placeholderReference.errors).toContain(
      "Production proof reference must point to a real external evidence record, not a placeholder.",
    );
    expect(shortReference.passesProductionProofTopologyGate).toBe(false);
    expect(shortReference.errors).toContain(
      "Production proof reference must point to a real external evidence record, not a placeholder.",
    );
  });

  it("fails when private proof API paths still return 404", () => {
    const evidence = buildProductionProofTopologyEvidence({
      baseUrl: "https://chasesets.com",
      reference: "PRODUCTION-PROOF-2026-05-30",
      operator: "ops@chasesets.com",
      checkedAt: "2026-05-30T12:00:00.000Z",
      productionMarketplaceProofEnabled: "true",
      productionMarketplacePublicEnabled: "false",
      health: {
        url: "https://chasesets.com/api/health/ready",
        responseUrl: "https://chasesets.com/api/health/ready",
        status: 200,
        ok: true,
        contentType: "application/json",
      },
      providerCallbacks: PROVIDER_CALLBACK_PATHS.map((path) => ({
        path,
        url: `https://chasesets.com${path}`,
        responseUrl: `https://chasesets.com${path}`,
        status: 400,
        ok: false,
        contentType: "application/json",
        reachable: true,
      })),
      privateProofApis: PRIVATE_PROOF_API_PATHS.map((check) => ({
        ...check,
        url: `https://chasesets.com${check.path}`,
        responseUrl: `https://chasesets.com${check.path}`,
        status: 404,
        ok: false,
        contentType: "application/json",
        reachable: false,
      })),
      privateProofWebRoutes: passingPrivateProofWebRoutes("https://chasesets.com"),
    });

    expect(evidence.passesProductionProofTopologyGate).toBe(false);
    expect(evidence.errors).toContain(
      "Production proof topology private API GET /api/marketplace/account/marketplace-checkout-fee-policy must not return 404.",
    );
    expect(evidence.errors).toContain(
      "Production proof topology private API GET /api/settlement/payout-setup/progress must not return 404.",
    );
    expect(evidence.errors).toContain(
      "Production proof topology private API POST /api/settlement/payouts/preview must not return 404.",
    );
    expect(evidence.errors).toContain(
      "Production proof topology private API GET /api/marketplace/account/checkout/status must not return 404.",
    );
    expect(evidence.errors).toContain(
      "Production proof topology private API POST /api/inventory/items/listing-stock/ensure must not return 404.",
    );
    expect(evidence.errors).toContain(
      "Production proof topology private API POST /api/marketplace/account/sales/shipments/topology-proof-shipment/label/purchase must not return 404.",
    );
    expect(evidence.errors).toContain(
      "Production proof topology private API POST /api/marketplace/account/listings/topology-proof-listing/publish must not return 404.",
    );
    expect(evidence.errors).toContain(
      "Production proof topology private API POST /api/marketplace/account/checkout-sessions/topology-proof-session/confirm must not return 404.",
    );
  });

  it("resolves inputs from flags and environment", () => {
    expect(
      parseProductionProofTopologyArgs(
        [
          "--base-url",
          "https://example.test",
          "--reference",
          "PROOF-REF",
          "--operator",
          "Ops",
          "--proof-enabled",
          "true",
          "--public-enabled",
          "false",
        ],
        {},
      ),
    ).toMatchObject({
      baseUrl: "https://example.test",
      reference: "PROOF-REF",
      operator: "Ops",
      productionMarketplaceProofEnabled: "true",
      productionMarketplacePublicEnabled: "false",
    });

    expect(
      parseProductionProofTopologyArgs([], {
        PRODUCTION_MARKETPLACE_PROOF_REFERENCE: "PROOF-ENV",
        PRODUCTION_PROOF_OPERATOR: "ops@chasesets.com",
        PRODUCTION_MARKETPLACE_PROOF_ENABLED: "true",
        PRODUCTION_MARKETPLACE_PUBLIC_ENABLED: "false",
      }),
    ).toMatchObject({
      baseUrl: "https://marketplace.chasesets.com",
      reference: "PROOF-ENV",
      operator: "ops@chasesets.com",
      productionMarketplaceProofEnabled: "true",
      productionMarketplacePublicEnabled: "false",
    });
  });

  it("fails when a private proof API returns public content instead of an unauthenticated JSON challenge", () => {
    const evidence = buildProductionProofTopologyEvidence({
      baseUrl: "https://chasesets.com",
      reference: "PRODUCTION-PROOF-2026-05-30",
      operator: "ops@chasesets.com",
      checkedAt: "2026-05-30T12:00:00.000Z",
      productionMarketplaceProofEnabled: "true",
      productionMarketplacePublicEnabled: "false",
      health: {
        url: "https://chasesets.com/api/health/ready",
        responseUrl: "https://chasesets.com/api/health/ready",
        status: 200,
        ok: true,
        contentType: "application/json",
      },
      providerCallbacks: PROVIDER_CALLBACK_PATHS.map((path) => ({
        path,
        url: `https://chasesets.com${path}`,
        responseUrl: `https://chasesets.com${path}`,
        status: 400,
        ok: false,
        contentType: "application/json",
        reachable: true,
      })),
      privateProofApis: PRIVATE_PROOF_API_PATHS.map((check) => ({
        ...check,
        url: `https://chasesets.com${check.path}`,
        responseUrl: `https://chasesets.com${check.path}`,
        status: 200,
        ok: true,
        contentType: "text/html",
        reachable: true,
      })),
      privateProofWebRoutes: passingPrivateProofWebRoutes("https://chasesets.com"),
    });

    expect(evidence.passesProductionProofTopologyGate).toBe(false);
    expect(evidence.errors).toContain(
      "Production proof topology private API GET /api/settlement/provider-health must return one of 401; received 200.",
    );
    expect(evidence.errors).toContain(
      "Production proof topology private API GET /api/settlement/provider-health must return a JSON API response.",
    );
  });

  it("fails when the private proof web route still returns 404", () => {
    const evidence = buildProductionProofTopologyEvidence({
      baseUrl: "https://chasesets.com",
      reference: "PRODUCTION-PROOF-2026-05-30",
      operator: "ops@chasesets.com",
      checkedAt: "2026-05-30T12:00:00.000Z",
      productionMarketplaceProofEnabled: "true",
      productionMarketplacePublicEnabled: "false",
      health: {
        url: "https://chasesets.com/api/health/ready",
        responseUrl: "https://chasesets.com/api/health/ready",
        status: 200,
        ok: true,
        contentType: "application/json",
      },
      providerCallbacks: PROVIDER_CALLBACK_PATHS.map((path) => ({
        path,
        url: `https://chasesets.com${path}`,
        responseUrl: `https://chasesets.com${path}`,
        status: 400,
        ok: false,
        contentType: "application/json",
        reachable: true,
      })),
      privateProofApis: PRIVATE_PROOF_API_PATHS.map((check) => ({
        ...check,
        url: `https://chasesets.com${check.path}`,
        responseUrl: `https://chasesets.com${check.path}`,
        status: 401,
        ok: false,
        contentType: "application/json",
        reachable: true,
      })),
      privateProofWebRoutes: PRIVATE_PROOF_WEB_PATHS.map((check) => ({
        ...check,
        url: `https://chasesets.com${check.path}`,
        responseUrl: `https://chasesets.com${check.path}`,
        status: 404,
        ok: false,
        contentType: "text/html",
        reachable: false,
      })),
    });

    expect(evidence.passesProductionProofTopologyGate).toBe(false);
    expect(evidence.errors).toContain(
      "Production proof topology private web route GET /account/payouts/setup must not return 404.",
    );
  });

  it("fails when the private proof web route redirects away from same-origin sign-in", () => {
    const evidence = buildProductionProofTopologyEvidence({
      baseUrl: "https://chasesets.com",
      reference: "PRODUCTION-PROOF-2026-05-30",
      operator: "ops@chasesets.com",
      checkedAt: "2026-05-30T12:00:00.000Z",
      productionMarketplaceProofEnabled: "true",
      productionMarketplacePublicEnabled: "false",
      health: {
        url: "https://chasesets.com/api/health/ready",
        responseUrl: "https://chasesets.com/api/health/ready",
        status: 200,
        ok: true,
        contentType: "application/json",
      },
      providerCallbacks: PROVIDER_CALLBACK_PATHS.map((path) => ({
        path,
        url: `https://chasesets.com${path}`,
        responseUrl: `https://chasesets.com${path}`,
        status: 400,
        ok: false,
        contentType: "application/json",
        reachable: true,
      })),
      privateProofApis: PRIVATE_PROOF_API_PATHS.map((check) => ({
        ...check,
        url: `https://chasesets.com${check.path}`,
        responseUrl: `https://chasesets.com${check.path}`,
        status: 401,
        ok: false,
        contentType: "application/json",
        reachable: true,
      })),
      privateProofWebRoutes: PRIVATE_PROOF_WEB_PATHS.map((check) => ({
        ...check,
        url: `https://chasesets.com${check.path}`,
        responseUrl: `https://chasesets.com${check.path}`,
        status: 302,
        ok: false,
        contentType: "text/html",
        location: "https://admin.chasesets.com/",
        reachable: true,
      })),
    });

    expect(evidence.passesProductionProofTopologyGate).toBe(false);
    expect(evidence.errors).toContain(
      "Production proof topology private web route GET /account/payouts/setup may only redirect unauthenticated users to the same-origin /sign-in route.",
    );
  });

  it("fails when topology probes redirect or respond from a fallback URL", () => {
    const evidence = buildProductionProofTopologyEvidence({
      baseUrl: "https://chasesets.com",
      reference: "PRODUCTION-PROOF-2026-05-30",
      operator: "ops@chasesets.com",
      checkedAt: "2026-05-30T12:00:00.000Z",
      productionMarketplaceProofEnabled: "true",
      productionMarketplacePublicEnabled: "false",
      health: {
        url: "https://chasesets.com/api/health/ready",
        responseUrl: "https://chasesets.com/api/health/ready",
        status: 200,
        ok: true,
        contentType: "application/json",
      },
      providerCallbacks: PROVIDER_CALLBACK_PATHS.map((path) => ({
        path,
        url: `https://chasesets.com${path}`,
        responseUrl: "https://chasesets.com/",
        status: 302,
        ok: false,
        contentType: "application/json",
        redirected: true,
        reachable: true,
      })),
      privateProofApis: PRIVATE_PROOF_API_PATHS.map((check) => ({
        ...check,
        url: `https://chasesets.com${check.path}`,
        responseUrl: `https://chasesets.com${check.path}`,
        status: 401,
        ok: false,
        contentType: "application/json",
        reachable: true,
      })),
      privateProofWebRoutes: passingPrivateProofWebRoutes("https://chasesets.com"),
    });

    expect(evidence.passesProductionProofTopologyGate).toBe(false);
    expect(evidence.errors).toContain(
      "Production proof topology callback /api/payments/provider/webhooks must not redirect.",
    );
    expect(evidence.errors).toContain(
      "Production proof topology callback /api/payments/provider/webhooks must respond from the requested URL without following a fallback route.",
    );
  });

  it("fails when base URL or checkedAt are not production proof values", () => {
    const evidence = buildProductionProofTopologyEvidence({
      baseUrl: "https://staging.chasesets.com/api",
      reference: "PRODUCTION-PROOF-2026-05-30",
      operator: "ops@chasesets.com",
      checkedAt: "2026-05-30",
      productionMarketplaceProofEnabled: "true",
      productionMarketplacePublicEnabled: "false",
      health: {
        url: "https://staging.chasesets.com/api/health/ready",
        responseUrl: "https://staging.chasesets.com/api/health/ready",
        status: 200,
        ok: true,
        contentType: "application/json",
      },
      providerCallbacks: PROVIDER_CALLBACK_PATHS.map((path) => ({
        path,
        url: `https://staging.chasesets.com${path}`,
        responseUrl: `https://staging.chasesets.com${path}`,
        status: 400,
        ok: false,
        contentType: "application/json",
        reachable: true,
      })),
      privateProofApis: PRIVATE_PROOF_API_PATHS.map((check) => ({
        ...check,
        url: `https://staging.chasesets.com${check.path}`,
        responseUrl: `https://staging.chasesets.com${check.path}`,
        status: 401,
        ok: false,
        contentType: "application/json",
        reachable: true,
      })),
      privateProofWebRoutes: passingPrivateProofWebRoutes("https://staging.chasesets.com"),
    });

    expect(evidence.passesProductionProofTopologyGate).toBe(false);
    expect(evidence.errors).toContain("Production proof topology checkedAt must be an ISO timestamp.");
    expect(evidence.errors).toContain(
      "Production proof topology baseUrl must be one of https://chasesets.com, https://admin.chasesets.com, https://marketplace.chasesets.com.",
    );
    expect(evidence.errors).toContain("Production proof topology baseUrl must not include a path, query, or fragment.");
  });
});
