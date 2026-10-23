import { describe, expect, it } from "vitest";
import {
  classifyScrydexCoordinatePreviewRouteRequest,
  coordinatePreviewRunnerIdentity,
} from "./catalog-staging-scrydex-coordinate-preview.mjs";

const origin = "https://admin.staging.chasesets.com";

describe("Scrydex coordinate preview hosted wrapper", () => {
  it("requires the exact admitted runner identity", () => {
    expect(() =>
      coordinatePreviewRunnerIdentity({
        GITHUB_ACTIONS: "true",
        ADMIN_WEB_URL: origin,
        GITHUB_SHA: "a".repeat(40),
        EXPECTED_SHA: "a".repeat(40),
        GITHUB_RUN_ID: "123",
        GITHUB_RUN_ATTEMPT: "1",
        CATALOG_STAGING_PROVIDER_UAT_SCOPE: "scrydex-coordinate-preview",
        RUNNER_TEMP: "C:/runner-temp",
      }),
    ).not.toThrow();
    expect(() => coordinatePreviewRunnerIdentity({})).toThrow(/runner-identity/);
  });

  it("refuses confirmation and provider traffic at the route fence", () => {
    expect(
      classifyScrydexCoordinatePreviewRouteRequest(
        { method: "POST", url: `${origin}/api/catalog/scope-sync-batches/confirm`, isNavigationRequest: () => false },
        "pre-confirm",
      ).allowed,
    ).toBe(false);
    expect(
      classifyScrydexCoordinatePreviewRouteRequest(
        { method: "GET", url: "https://api.scrydex.com/onepiece/v1/sets", isNavigationRequest: () => false },
        "capture",
      ),
    ).toMatchObject({ allowed: false, reason: "cross-origin" });
  });

  it("admits exactly one daily usage read", () => {
    expect(
      classifyScrydexCoordinatePreviewRouteRequest(
        {
          method: "GET",
          url: `${origin}/api/catalog/source-observations/integration-control-plane/overview?audience=daily`,
          isNavigationRequest: () => false,
        },
        "capture",
      ),
    ).toMatchObject({ allowed: true, requestClass: "usage-read" });
    expect(
      classifyScrydexCoordinatePreviewRouteRequest(
        {
          method: "GET",
          url: `${origin}/api/catalog/source-observations/integration-control-plane/overview?audience=all`,
          isNavigationRequest: () => false,
        },
        "capture",
      ).allowed,
    ).toBe(false);
  });
});
