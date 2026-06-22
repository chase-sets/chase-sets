import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { validateCrossContextFallbackInventory } from "./cross-context-fallback-inventory.mjs";

const tempRoots = [];

function createTempRepo() {
  const root = mkdtempSync(path.join(tmpdir(), "cs-cross-context-fallback-"));
  tempRoots.push(root);
  return root;
}

function commercialTermsFallback(overrides = {}) {
  return {
    id: "commercial-terms.identity-account-source-fresh-account",
    owner: "commercial-terms",
    category: "host-owned bridge",
    sourceContextName: "identity",
    targetContextName: "commercial-terms",
    behaviorOwner: "Commercial Terms owns resolution; Identity owns Account source state.",
    implementation: {
      consumer: "bounded-contexts/commercial-terms/features/resolutions/read-model/resolve.ts",
      hostBridges: ["deployables/platform-api/src/app.ts", "deployables/platform-worker/src/main.ts"],
      providerSurface: "@chase-sets/identity services.accounts.getAccountState",
    },
    actorOwnershipGuard:
      "The host composes the bridge from Identity services inside platform-api and platform-worker only.",
    catalogSourceGuard:
      "Not catalog-scoped. The source guard is the requested account id and the Identity Account source state.",
    freshnessScope:
      "Commercial Terms resolution may recover account type/status for a fresh account while the account projection catches up.",
    projectionWaitedOn: {
      projectionName: "commercial-terms-account-projection",
      readModelTable: "commercial_terms_account_pages",
      sourceContextName: "identity",
    },
    terminationRule:
      "The resolver reads commercial_terms_account_pages first and calls Identity account source only on projection miss.",
    observability:
      "Count projection-hit, fallback-used, and fallback-failed outcomes with context/projection labels only.",
    proof: {
      tests: ["bounded-contexts/commercial-terms/features/resolutions/read-model/resolve.test.ts"],
      testCases: [
        "uses the host account source when the commercial terms account projection has not caught up",
        "fails when the account is not active",
      ],
    },
    ...overrides,
  };
}

function contextManifestsWithCommercialTermsInventory(inventory) {
  return new Map([
    [
      "bounded-contexts/identity",
      {
        root: "bounded-contexts/identity",
        manifest: {
          contextName: "identity",
          packageName: "@chase-sets/identity",
          projectionGroups: [],
        },
        packageName: "@chase-sets/identity",
      },
    ],
    [
      "bounded-contexts/commercial-terms",
      {
        root: "bounded-contexts/commercial-terms",
        manifest: {
          contextName: "commercial-terms",
          packageName: "@chase-sets/commercial-terms",
          projectionGroups: [
            {
              projectionName: "commercial-terms-account-projection",
              sourceContextNames: ["identity"],
              ownedTables: ["commercial_terms_account_pages"],
            },
          ],
          crossContextFallbackInventory: inventory,
        },
        packageName: "@chase-sets/commercial-terms",
      },
    ],
  ]);
}

function validate(root, contextManifests) {
  return validateCrossContextFallbackInventory({
    repoRoot: root,
    contextManifests,
    reportOutputPath: "artifacts/test-cross-context-fallback-inventory.md",
  });
}

afterEach(() => {
  while (tempRoots.length > 0) {
    rmSync(tempRoots.pop(), { recursive: true, force: true });
  }
});

describe("cross-context fallback inventory guard", () => {
  it("accepts a Commercial Terms-style host-owned bridge", () => {
    const root = createTempRepo();

    const result = validate(root, contextManifestsWithCommercialTermsInventory([commercialTermsFallback()]));

    expect(result.violations).toEqual([]);
    expect(result.reportEntries).toEqual([
      expect.objectContaining({
        id: "commercial-terms.identity-account-source-fresh-account",
        category: "host-owned bridge",
        sourceContextName: "identity",
        targetContextName: "commercial-terms",
        projectionName: "commercial-terms-account-projection",
        readModelTable: "commercial_terms_account_pages",
      }),
    ]);
  });

  it("rejects unsupported categories and missing proof tests", () => {
    const root = createTempRepo();

    const result = validate(
      root,
      contextManifestsWithCommercialTermsInventory([
        commercialTermsFallback({
          id: "commercial-terms.identity-account-source-direct-read",
          category: "direct cross-context read",
          proof: { testCases: ["covers the fallback branch"] },
        }),
      ]),
    );

    expect(result.violations).toEqual(
      expect.arrayContaining([
        "bounded-contexts/commercial-terms/context.json crossContextFallbackInventory[0]: category 'direct cross-context read' is unsupported; expected one of host-owned bridge, same-actor post-write recovery, synchronous projection",
        "bounded-contexts/commercial-terms/context.json crossContextFallbackInventory[0]: proof.tests must list at least one test file",
      ]),
    );
  });

  it("rejects missing guards and projection declarations that do not match the target projection group", () => {
    const root = createTempRepo();

    const result = validate(
      root,
      contextManifestsWithCommercialTermsInventory([
        commercialTermsFallback({
          id: "commercial-terms.identity-account-source-misdeclared",
          actorOwnershipGuard: "",
          catalogSourceGuard: "",
          projectionWaitedOn: {
            projectionName: "commercial-terms-account-projection",
            readModelTable: "commercial_terms_unknown_pages",
            sourceContextName: "catalog",
          },
        }),
      ]),
    );

    expect(result.violations).toEqual(
      expect.arrayContaining([
        "bounded-contexts/commercial-terms/context.json crossContextFallbackInventory[0]: actorOwnershipGuard must be a non-empty string",
        "bounded-contexts/commercial-terms/context.json crossContextFallbackInventory[0]: sourceGuard or catalogSourceGuard must be a non-empty string",
        "bounded-contexts/commercial-terms/context.json crossContextFallbackInventory[0]: projectionWaitedOn.sourceContextName must match sourceContextName",
        "bounded-contexts/commercial-terms/context.json crossContextFallbackInventory[0]: projectionWaitedOn.sourceContextName 'catalog' is not declared by projection group 'commercial-terms-account-projection'",
        "bounded-contexts/commercial-terms/context.json crossContextFallbackInventory[0]: projectionWaitedOn.readModelTable 'commercial_terms_unknown_pages' is not owned by projection group 'commercial-terms-account-projection'",
      ]),
    );
  });
});
