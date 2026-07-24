import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  batchE2eSuiteIds,
  e2eNoSuiteExclusionForChangedFile,
  e2eSuiteIdsForChangedFile,
  isRouteFile,
} from "./e2e-suites.mjs";
import { buildSuiteGrep, parseSuiteArgs } from "./run-e2e-suite.mjs";

function walkFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = join(dir, entry.name);
    return entry.isDirectory() ? walkFiles(entryPath) : [entryPath.replace(/\\/g, "/")];
  });
}

describe("run e2e suite", () => {
  it("accepts comma-separated and positional suite ids", () => {
    const suites = parseSuiteArgs([
      "marketplace_browse,marketplace_account",
      "marketplace_checkout marketplace_seller",
      "catalog_admin_integrations",
      "catalog_admin_modeling",
      "admin_growth",
      "admin_commerce",
      "admin_support",
      "admin_platform",
      "admin_auth",
      "admin_access",
    ]);

    expect(suites.map((suite) => suite.id)).toEqual([
      "marketplace_browse",
      "marketplace_account",
      "marketplace_checkout",
      "marketplace_seller",
      "catalog_admin_integrations",
      "catalog_admin_modeling",
      "admin_growth",
      "admin_commerce",
      "admin_support",
      "admin_platform",
      "admin_auth",
      "admin_access",
    ]);
  });

  it("builds one Playwright grep expression for selected suites", () => {
    const suites = parseSuiteArgs(["marketplace_checkout,marketplace_seller"]);

    expect(buildSuiteGrep(suites)).toBe("@marketplace-checkout|@marketplace-seller");
  });

  it("balances selected suites for CI by estimated duration", () => {
    expect(
      batchE2eSuiteIds([
        "catalog_admin_integrations",
        "marketplace_seller",
        "marketplace_browse",
        "marketplace_checkout",
        "marketplace_account",
        "catalog_admin_modeling",
        "admin_growth",
        "admin_commerce",
        "admin_support",
        "admin_platform",
        "admin_auth",
        "admin_access",
      ]),
    ).toEqual([
      "catalog_admin_integrations,admin_auth",
      "catalog_admin_modeling,admin_platform",
      "marketplace_checkout,admin_support",
      "marketplace_browse,marketplace_account",
      "admin_commerce,admin_access",
      "marketplace_seller,admin_growth",
    ]);
  });

  it("routes the marketplace index route to browse coverage", () => {
    expect(e2eSuiteIdsForChangedFile("deployables/marketplace/app/routes/index.tsx")).toEqual(["marketplace_browse"]);
  });

  it("routes deployable Playwright spec changes to their owning suites", () => {
    expect(e2eSuiteIdsForChangedFile("deployables/marketplace/e2e/item-detail.spec.ts")).toEqual([
      "marketplace_browse",
    ]);
    expect(e2eSuiteIdsForChangedFile("deployables/marketplace/e2e/critical-flows.spec.ts")).toEqual([
      "marketplace_browse",
      "marketplace_account",
      "marketplace_checkout",
      "marketplace_seller",
    ]);
    expect(e2eSuiteIdsForChangedFile("deployables/admin-web/e2e/access-api-keys.spec.ts")).toEqual(["admin_access"]);
    expect(e2eSuiteIdsForChangedFile("deployables/admin-web/e2e/catalog-scopes.spec.ts")).toEqual([
      "catalog_admin_integrations",
    ]);
    expect(e2eSuiteIdsForChangedFile("deployables/marketplace/e2e/responsive-evidence-contract.spec.ts")).toEqual([
      "marketplace_browse",
    ]);
    expect(e2eSuiteIdsForChangedFile("deployables/admin-web/e2e/catalog-staging-provider-sync.uat.spec.ts")).toEqual(
      [],
    );
    expect(
      e2eNoSuiteExclusionForChangedFile("deployables/admin-web/e2e/catalog-staging-provider-sync.uat.spec.ts"),
    ).toMatchObject({ reason: expect.stringContaining("Manual staging UAT") });
    expect(e2eSuiteIdsForChangedFile("deployables/marketplace/e2e/account-payment-stripe-embed.uat.spec.ts")).toEqual(
      [],
    );
    expect(
      e2eNoSuiteExclusionForChangedFile("deployables/marketplace/e2e/account-payment-stripe-embed.uat.spec.ts"),
    ).toMatchObject({ reason: expect.stringContaining("Manual staging UAT") });
  });

  it("routes shared auth changes to marketplace and admin auth coverage", () => {
    expect(e2eSuiteIdsForChangedFile("bounded-contexts/auth/features/sign-in/ui/sign-in-page.tsx")).toEqual([
      "marketplace_account",
      "admin_auth",
    ]);
  });

  it("routes shared responsive evidence contract changes to every browser suite", () => {
    const expected = [
      "marketplace_browse",
      "marketplace_account",
      "marketplace_checkout",
      "marketplace_seller",
      "catalog_admin_integrations",
      "catalog_admin_modeling",
      "admin_growth",
      "admin_commerce",
      "admin_support",
      "admin_platform",
      "admin_auth",
      "admin_access",
    ];

    expect(e2eSuiteIdsForChangedFile("infrastructure/playwright-evidence/index.ts")).toEqual(expected);
    expect(e2eSuiteIdsForChangedFile("infrastructure/playwright-evidence/package.json")).toEqual(expected);
    expect(e2eSuiteIdsForChangedFile("infrastructure/playwright-evidence/responsive-evidence-manifest.json")).toEqual(
      expected,
    );
    expect(e2eSuiteIdsForChangedFile("scripts/validate-responsive-evidence-artifacts.mjs")).toEqual(expected);
  });

  it("routes catalog admin integration routes to admin coverage", () => {
    expect(e2eSuiteIdsForChangedFile("bounded-contexts/catalog/routes/admin/integrations.tsx")).toEqual([
      "catalog_admin_integrations",
    ]);
  });

  it("routes catalog admin modeling routes to modeling admin coverage", () => {
    expect(e2eSuiteIdsForChangedFile("bounded-contexts/catalog/routes/admin/dimensions.tsx")).toEqual([
      "catalog_admin_modeling",
    ]);
    expect(e2eSuiteIdsForChangedFile("bounded-contexts/catalog/routes/admin/dimensions-detail.tsx")).toEqual([
      "catalog_admin_modeling",
    ]);
    expect(
      e2eSuiteIdsForChangedFile("bounded-contexts/catalog/features/dimensions/ui/dimension-list-page.tsx"),
    ).toEqual(["catalog_admin_modeling"]);
  });

  it("routes promo bar admin routes to growth admin coverage", () => {
    expect(e2eSuiteIdsForChangedFile("bounded-contexts/public-presence/routes/admin/promo-bar.tsx")).toEqual([
      "admin_growth",
    ]);
  });

  it("routes Google Shopping and waitlist admin routes to growth admin coverage", () => {
    expect(e2eSuiteIdsForChangedFile("bounded-contexts/discovery/routes/admin/google-shopping.tsx")).toEqual([
      "admin_growth",
    ]);
    expect(
      e2eSuiteIdsForChangedFile(
        "bounded-contexts/discovery/features/google-shopping-operations/ui/google-shopping-operations-page.tsx",
      ),
    ).toEqual(["admin_growth"]);
    expect(e2eSuiteIdsForChangedFile("bounded-contexts/public-presence/routes/admin/waitlist.tsx")).toEqual([
      "admin_growth",
    ]);
    expect(e2eSuiteIdsForChangedFile("bounded-contexts/public-presence/features/waitlist/ui/admin-pages.tsx")).toEqual([
      "admin_growth",
    ]);
  });

  it("routes postage policy admin routes to commerce admin coverage", () => {
    expect(e2eSuiteIdsForChangedFile("bounded-contexts/ordering/routes/admin/postage-policies.tsx")).toEqual([
      "admin_commerce",
    ]);
    expect(
      e2eSuiteIdsForChangedFile(
        "bounded-contexts/ordering/features/postage-policies/ui/postage-policy-detail-drawer.tsx",
      ),
    ).toEqual(["admin_commerce"]);
  });

  it("routes facility return intake to commerce admin coverage", () => {
    expect(e2eSuiteIdsForChangedFile("bounded-contexts/fulfillment/routes/admin/return-intake.tsx")).toEqual([
      "admin_commerce",
    ]);
    expect(
      e2eSuiteIdsForChangedFile("bounded-contexts/fulfillment/features/return-shipments/ui/facility-intake-page.tsx"),
    ).toEqual(["admin_commerce"]);
  });

  it("routes recovered inventory admin routes to commerce admin coverage", () => {
    expect(e2eSuiteIdsForChangedFile("bounded-contexts/inventory/routes/admin/recovered-items.tsx")).toEqual([
      "admin_commerce",
    ]);
    expect(
      e2eSuiteIdsForChangedFile("bounded-contexts/inventory/features/recovered-items/ui/recovered-items-page.tsx"),
    ).toEqual(["admin_commerce"]);
  });

  it("routes commercial terms admin routes to commerce admin coverage", () => {
    expect(e2eSuiteIdsForChangedFile("bounded-contexts/commercial-terms/routes/admin/schedules.tsx")).toEqual([
      "admin_commerce",
    ]);
    expect(e2eSuiteIdsForChangedFile("bounded-contexts/commercial-terms/routes/admin/agreements.tsx")).toEqual([
      "admin_commerce",
    ]);
    expect(
      e2eSuiteIdsForChangedFile("bounded-contexts/commercial-terms/features/schedules/ui/schedule-list-page.tsx"),
    ).toEqual(["admin_commerce"]);
    expect(e2eSuiteIdsForChangedFile("bounded-contexts/commercial-terms/features/agreements/api/runtime.ts")).toEqual([
      "admin_commerce",
    ]);
  });

  it("routes platform feedback admin routes to support admin coverage", () => {
    expect(
      e2eSuiteIdsForChangedFile("bounded-contexts/platform-operations/routes/admin/platform-feedback.tsx"),
    ).toEqual(["admin_support"]);
  });

  it("routes support request admin routes to support admin coverage", () => {
    expect(e2eSuiteIdsForChangedFile("bounded-contexts/platform-operations/routes/admin/requests.tsx")).toEqual([
      "admin_support",
    ]);
    expect(e2eSuiteIdsForChangedFile("bounded-contexts/platform-operations/routes/admin/request-detail.tsx")).toEqual([
      "admin_support",
    ]);
    expect(
      e2eSuiteIdsForChangedFile(
        "bounded-contexts/platform-operations/features/support-requests/ui/support-operations-page.tsx",
      ),
    ).toEqual(["admin_support"]);
  });

  it("routes projection operations admin routes to platform admin coverage", () => {
    expect(
      e2eSuiteIdsForChangedFile("bounded-contexts/platform-operations/routes/admin/projection-operations.tsx"),
    ).toEqual(["admin_platform"]);
  });

  it("routes Listing Evidence Policy administration to platform admin coverage", () => {
    expect(e2eSuiteIdsForChangedFile("bounded-contexts/marketplace/routes/admin/listing-evidence-policy.tsx")).toEqual([
      "admin_platform",
    ]);
    expect(e2eSuiteIdsForChangedFile("bounded-contexts/marketplace/routes/account-desk.tsx")).toEqual([
      "marketplace_account",
      "marketplace_seller",
    ]);
    expect(
      e2eSuiteIdsForChangedFile(
        "bounded-contexts/marketplace/features/listing-evidence-policy/ui/listing-evidence-policy-page.tsx",
      ),
    ).toEqual(["admin_platform"]);
  });

  it("routes account admin routes to access admin coverage", () => {
    expect(e2eSuiteIdsForChangedFile("bounded-contexts/identity/routes/admin/accounts-detail.tsx")).toEqual([
      "admin_access",
    ]);
    expect(e2eSuiteIdsForChangedFile("bounded-contexts/identity/features/accounts/ui/account-detail-page.tsx")).toEqual(
      ["admin_access"],
    );
  });

  it("routes invitation admin routes to access admin coverage", () => {
    expect(e2eSuiteIdsForChangedFile("bounded-contexts/identity/routes/admin/invitations.tsx")).toEqual([
      "admin_access",
    ]);
    expect(
      e2eSuiteIdsForChangedFile("bounded-contexts/identity/features/invitations/ui/invitation-detail-page.tsx"),
    ).toEqual(["admin_access"]);
  });

  it("routes API key admin routes to access admin coverage", () => {
    expect(e2eSuiteIdsForChangedFile("bounded-contexts/identity/routes/admin/api-keys.tsx")).toEqual(["admin_access"]);
    expect(e2eSuiteIdsForChangedFile("bounded-contexts/identity/routes/admin/api-keys-detail.tsx")).toEqual([
      "admin_access",
    ]);
    expect(e2eSuiteIdsForChangedFile("bounded-contexts/identity/features/api-keys/ui/api-key-detail-page.tsx")).toEqual(
      ["admin_access"],
    );
  });

  it("keeps route E2E ownership complete or explicitly excluded", () => {
    const routeFiles = [
      ...walkFiles("bounded-contexts"),
      ...walkFiles("deployables/marketplace/app/routes"),
      ...walkFiles("deployables/admin-web/app/routes"),
    ]
      .filter(isRouteFile)
      .sort();

    const unownedRoutes = routeFiles.filter(
      (filePath) => e2eSuiteIdsForChangedFile(filePath).length === 0 && !e2eNoSuiteExclusionForChangedFile(filePath),
    );

    expect(unownedRoutes).toEqual([]);
  });
});
