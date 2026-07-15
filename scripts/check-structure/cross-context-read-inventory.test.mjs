import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  collectCrossContextRequestPathReadCalls,
  validateCrossContextReadInventory,
} from "./cross-context-read-inventory.mjs";

const tempRoots = [];

function createTempRepo() {
  const root = mkdtempSync(path.join(tmpdir(), "cs-cross-context-read-"));
  tempRoots.push(root);
  return root;
}

function writeSource(root, relativeFile, content) {
  const absolute = path.join(root, relativeFile);
  mkdirSync(path.dirname(absolute), { recursive: true });
  writeFileSync(absolute, `${content.trim()}\n`, "utf8");
}

function contextManifests() {
  return new Map([
    [
      "bounded-contexts/checkout",
      {
        root: "bounded-contexts/checkout",
        manifest: {
          contextName: "checkout",
          packageName: "@chase-sets/checkout",
        },
        packageName: "@chase-sets/checkout",
      },
    ],
    [
      "bounded-contexts/marketplace",
      {
        root: "bounded-contexts/marketplace",
        manifest: {
          contextName: "marketplace",
          packageName: "@chase-sets/marketplace",
        },
        packageName: "@chase-sets/marketplace",
      },
    ],
    [
      "bounded-contexts/auth",
      {
        root: "bounded-contexts/auth",
        manifest: {
          contextName: "auth",
          packageName: "@chase-sets/auth",
        },
        packageName: "@chase-sets/auth",
      },
    ],
  ]);
}

function writeForeignReadRoute(root) {
  writeSource(
    root,
    "bounded-contexts/checkout/routes/account-sell-list.tsx",
    `
      import { createMarketplaceRequestApiClient } from "@chase-sets/marketplace/server";

      export async function loader({ request }) {
        const marketplaceApi = createMarketplaceRequestApiClient(request);
        return marketplaceApi.listOfferMatches("limit=10");
      }
    `,
  );
}

function baselineEntry(call, overrides = {}) {
  return {
    id: call.id,
    consumerContextName: call.consumerContextName,
    sourceContextName: call.sourceContextName,
    file: call.file,
    line: call.line,
    clientFactory: call.clientFactory,
    methodName: call.methodName,
    classification: "composite-projection-servable",
    sourceWakePosture: "wave-1-listened",
    issue: "#2777",
    migration: "Serve the sell-list overlay from a Checkout-owned composite projection.",
    ...overrides,
  };
}

function writeBaseline(root, entries) {
  writeSource(
    root,
    "scripts/check-structure/cross-context-read-baseline.json",
    JSON.stringify(
      {
        issue: "#2775",
        owner: "bounded context owners",
        reviewBy: "2026-07-31",
        classificationGuide: [
          "composite-projection-servable: migrate to a local view-owned projection.",
          "read-your-writes: use a local mirror plus wake-before-wait, not request-time HTTP.",
          "genuinely-synchronous: justify the synchronous decision.",
        ],
        entries,
      },
      null,
      2,
    ),
  );
}

async function validate(root, options = {}) {
  return validateCrossContextReadInventory({
    repoRoot: root,
    contextManifests: contextManifests(),
    artifactOutputPath: "artifacts/test-cross-context-read-inventory.json",
    ...options,
  });
}

afterEach(() => {
  while (tempRoots.length > 0) {
    rmSync(tempRoots.pop(), { recursive: true, force: true });
  }
});

describe("cross-context request-path read inventory guard", () => {
  it("discovers foreign request-client reads in route loaders", async () => {
    const root = createTempRepo();
    writeForeignReadRoute(root);

    const calls = await collectCrossContextRequestPathReadCalls({
      repoRoot: root,
      contextManifests: contextManifests(),
    });

    expect(calls).toEqual([
      expect.objectContaining({
        consumerContextName: "checkout",
        sourceContextName: "marketplace",
        file: "bounded-contexts/checkout/routes/account-sell-list.tsx",
        clientFactory: "createMarketplaceRequestApiClient",
        methodName: "listOfferMatches",
        occurrence: 1,
      }),
    ]);
  });

  it("accepts current reads represented by the committed baseline and writes the living artifact", async () => {
    const root = createTempRepo();
    writeForeignReadRoute(root);
    const [call] = await collectCrossContextRequestPathReadCalls({
      repoRoot: root,
      contextManifests: contextManifests(),
    });
    writeBaseline(root, [baselineEntry(call)]);

    const result = await validate(root, { failOnNewReads: true });

    expect(result.violations).toEqual([]);
    expect(result.warnings).toEqual([]);
    const artifactPath = path.join(root, "artifacts", "test-cross-context-read-inventory.json");
    expect(existsSync(artifactPath)).toBe(true);
    expect(JSON.parse(readFileSync(artifactPath, "utf8")).entries).toEqual([
      expect.objectContaining({
        id: call.id,
        classification: "composite-projection-servable",
        sourceWakePosture: "wave-1-listened",
      }),
    ]);
  });

  it("warns locally but fails in CI mode for a net-new foreign read", async () => {
    const root = createTempRepo();
    writeForeignReadRoute(root);
    writeBaseline(root, []);

    const localResult = await validate(root, { failOnNewReads: false });
    expect(localResult.violations).toEqual([]);
    expect(localResult.warnings[0]).toContain("net-new foreign request-path read-client call");
    expect(localResult.warnings[0]).toContain("bounded-contexts/checkout/features/cart/integrations/*");
    expect(localResult.warnings[0]).toContain("docs/architecture/cross-context-request-path-read-inventory.md");
    expect(localResult.warnings[0]).toContain("#2774, and #2776");

    const ciResult = await validate(root, { failOnNewReads: true });
    expect(ciResult.warnings).toEqual([]);
    expect(ciResult.violations[0]).toContain("net-new foreign request-path read-client call");
  });

  it("fails when a baseline row no longer maps to discovered code", async () => {
    const root = createTempRepo();
    writeForeignReadRoute(root);
    const [call] = await collectCrossContextRequestPathReadCalls({
      repoRoot: root,
      contextManifests: contextManifests(),
    });
    writeBaseline(root, [baselineEntry(call)]);
    writeSource(
      root,
      "bounded-contexts/checkout/routes/account-sell-list.tsx",
      `
        import { createMarketplaceRequestApiClient } from "@chase-sets/marketplace/server";

        export async function action({ request }) {
          const marketplaceApi = createMarketplaceRequestApiClient(request);
          return marketplaceApi.acceptOfferMatch("offer_1", {});
        }
      `,
    );

    const result = await validate(root, { failOnNewReads: true });

    expect(result.violations).toEqual(
      expect.arrayContaining([expect.stringContaining("stale cross-context read baseline entry")]),
    );
  });

  it("ignores command methods, Auth clients, same-context clients, and tests", async () => {
    const root = createTempRepo();
    writeSource(
      root,
      "bounded-contexts/checkout/routes/checkout-session.tsx",
      `
        import { createCheckoutRequestApiClient } from "@chase-sets/checkout/server";
        import { createMarketplaceRequestApiClient } from "@chase-sets/marketplace/server";
        import { createInternalAuthRequestApiClient } from "@chase-sets/auth/server";

        export async function action({ request }) {
          const checkoutApi = createCheckoutRequestApiClient(request);
          const marketplaceApi = createMarketplaceRequestApiClient(request);
          await checkoutApi.getCheckoutSession("chk_1");
          await marketplaceApi.createListing({});
          await marketplaceApi.reportReview("rev_1", {});
          return createInternalAuthRequestApiClient(request).getSession("ses_1");
        }
      `,
    );
    writeSource(
      root,
      "bounded-contexts/checkout/routes/checkout-session.test.tsx",
      `
        import { createMarketplaceRequestApiClient } from "@chase-sets/marketplace/server";
        export async function loader({ request }) {
          return createMarketplaceRequestApiClient(request).listOfferMatches("limit=10");
        }
      `,
    );

    const calls = await collectCrossContextRequestPathReadCalls({
      repoRoot: root,
      contextManifests: contextManifests(),
    });

    expect(calls).toEqual([]);
  });

  it("requires synchronous classifications to carry a justification", async () => {
    const root = createTempRepo();
    writeForeignReadRoute(root);
    const [call] = await collectCrossContextRequestPathReadCalls({
      repoRoot: root,
      contextManifests: contextManifests(),
    });
    writeBaseline(root, [
      baselineEntry(call, {
        classification: "genuinely-synchronous",
        issue: "#2776",
      }),
    ]);

    const result = await validate(root, { failOnNewReads: true });

    expect(result.violations).toContain(
      "scripts/check-structure/cross-context-read-baseline.json entries[0]: genuinely-synchronous entries require justification",
    );
  });
});
