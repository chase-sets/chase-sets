import { describe, expect, it } from "vitest";
import { batchE2eSuiteIds, e2eSuiteIdsForChangedFile } from "./e2e-suites.mjs";
import { buildSuiteGrep, parseSuiteArgs } from "./run-e2e-suite.mjs";

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
      "admin_access",
    ]);
  });

  it("builds one Playwright grep expression for selected suites", () => {
    const suites = parseSuiteArgs(["marketplace_checkout,marketplace_seller"]);

    expect(buildSuiteGrep(suites)).toBe("@marketplace-checkout|@marketplace-seller");
  });

  it("batches selected suites for CI without changing suite order", () => {
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
        "admin_access",
      ]),
    ).toEqual([
      "marketplace_browse,marketplace_account",
      "marketplace_checkout,marketplace_seller",
      "catalog_admin_integrations,catalog_admin_modeling",
      "admin_growth,admin_commerce",
      "admin_support,admin_platform",
      "admin_access",
    ]);
  });

  it("routes the marketplace index route to browse coverage", () => {
    expect(e2eSuiteIdsForChangedFile("deployables/marketplace/app/routes/index.tsx")).toEqual(["marketplace_browse"]);
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

  it("routes postage policy admin routes to commerce admin coverage", () => {
    expect(e2eSuiteIdsForChangedFile("bounded-contexts/ordering/routes/admin/postage-policies.tsx")).toEqual([
      "admin_commerce",
    ]);
    expect(
      e2eSuiteIdsForChangedFile(
        "bounded-contexts/ordering/features/postage-policies/ui/postage-policy-detail-page.tsx",
      ),
    ).toEqual(["admin_commerce"]);
  });

  it("routes platform feedback admin routes to support admin coverage", () => {
    expect(
      e2eSuiteIdsForChangedFile("bounded-contexts/platform-operations/routes/admin/platform-feedback.tsx"),
    ).toEqual(["admin_support"]);
  });

  it("routes projection operations admin routes to platform admin coverage", () => {
    expect(
      e2eSuiteIdsForChangedFile("bounded-contexts/platform-operations/routes/admin/projection-operations.tsx"),
    ).toEqual(["admin_platform"]);
  });

  it("routes invitation admin routes to access admin coverage", () => {
    expect(e2eSuiteIdsForChangedFile("bounded-contexts/identity/routes/admin/invitations.tsx")).toEqual([
      "admin_access",
    ]);
    expect(
      e2eSuiteIdsForChangedFile("bounded-contexts/identity/features/invitations/ui/invitation-detail-page.tsx"),
    ).toEqual(["admin_access"]);
  });
});
