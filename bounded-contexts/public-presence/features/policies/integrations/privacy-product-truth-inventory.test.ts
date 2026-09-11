import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { privacyExternalClientPackageClassifications } from "../domain/privacy-policy-product-truth";
import {
  classifyPrivacyProductTruthPartitionExclusion,
  collectPrivacyProductTruthInventory,
  derivePrivacyProductTruthInventory,
  isPrivacyProductTruthCandidateModule,
  listPrivacyProductTruthTrackedPaths,
  partitionPrivacyProductTruthPaths,
  privacyProductTruthExclusionReasons,
  readCitedSourceSlice,
  readPrivacyProductTruthSources,
} from "./privacy-product-truth-inventory.mjs";

const integrationsDirectory = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(integrationsDirectory, "../../../../..");

// Real repository discovery is the expensive, load-bearing part of this suite.
// It runs once and every case reads the same derived inventory, so a mutant
// case pays only for its own re-derivation.
const sources = readPrivacyProductTruthSources({ repoRoot });
const inventory = derivePrivacyProductTruthInventory({
  ...sources,
  externalPackageClassifications: privacyExternalClientPackageClassifications,
});

const LONG_DERIVATION_MS = 120_000;

function subjectsOf(factFamily: string): readonly string[] {
  return inventory.facts
    .filter((fact) => fact.factFamily === factFamily)
    .map((fact) => fact.subject)
    .sort();
}

function factFor(factFamily: string, subject: string) {
  const fact = inventory.facts.find((entry) => entry.factFamily === factFamily && entry.subject === subject);
  expect(fact, `${factFamily} subject '${subject}' was not derived`).toBeDefined();
  return fact!;
}

/**
 * Re-runs the exact production derivation over a mutated copy of the real
 * source records. Every one-variable control freezes all other inputs by
 * construction: only the named record's text changes.
 */
function deriveWithMutatedSources(
  mutations: readonly Readonly<{ relativePath: string; mutate: (source: string) => string }>[],
  extraRecords: readonly Readonly<{ relativePath: string; source: string }>[] = [],
) {
  const mutated = sources.records.map((record) => {
    const mutation = mutations.find((entry) => entry.relativePath === record.relativePath);
    if (mutation === undefined || record.source === undefined) return record;
    const next = mutation.mutate(record.source);
    expect(next, `mutation for ${record.relativePath} changed nothing`).not.toBe(record.source);
    return { ...record, source: next };
  });
  for (const mutation of mutations) {
    expect(
      sources.records.some((record) => record.relativePath === mutation.relativePath),
      `mutation target ${mutation.relativePath} is not in the scanned partition`,
    ).toBe(true);
  }
  return derivePrivacyProductTruthInventory({
    ...sources,
    trackedPaths: [...sources.trackedPaths, ...extraRecords.map((record) => record.relativePath)].sort(),
    records: [...mutated, ...extraRecords],
    externalPackageClassifications: privacyExternalClientPackageClassifications,
  });
}

describe("privacy product-truth partition", () => {
  it("classifies every exclusion reason by code shape rather than by owning directory", () => {
    const cases: readonly Readonly<{ path: string; reason: string | null }>[] = [
      { path: "bounded-contexts/checkout/support/request-support/guest-checkout.ts", reason: null },
      { path: "packages/design-system/src/theme/theme-toggle.tsx", reason: null },
      { path: "some/arbitrary/place/in/the/tree/production-module.ts", reason: null },
      { path: "deployables/marketplace/e2e/support/auth.ts", reason: null },
      { path: "contracts/public-docs/generated/privacy-policy-publication.ts", reason: null },
      { path: "README.md", reason: "not-typescript-source" },
      { path: "scripts/lib/repo.mjs", reason: "not-typescript-source" },
      { path: "packages/typescript-compiler-api/index.d.ts", reason: "declaration-module" },
      {
        path: "bounded-contexts/public-presence/features/policies/integrations/privacy-product-truth-inventory.d.mts",
        reason: "declaration-module",
      },
      { path: "bounded-contexts/public-presence/tests/api.test.ts", reason: "test-module" },
      { path: "deployables/marketplace/e2e/privacy-policy.spec.ts", reason: "spec-module" },
      { path: "bounded-contexts/public-presence/tests/vitest-helper.ts", reason: "test-path-segment" },
      { path: "packages/design-system/src/__tests__/panels.tsx", reason: "test-path-segment" },
      { path: "scripts/check-structure/fixtures/anything.ts", reason: "test-path-segment" },
      { path: "a/test-fixtures/anything.ts", reason: "test-path-segment" },
      { path: "a/test-support/anything.ts", reason: "test-path-segment" },
      { path: "contracts/money-movement/money-test-support.ts", reason: "test-support-module" },
    ];
    for (const entry of cases) {
      expect(classifyPrivacyProductTruthPartitionExclusion(entry.path), entry.path).toBe(entry.reason);
      expect(isPrivacyProductTruthCandidateModule(entry.path), entry.path).toBe(entry.reason === null);
    }
  });

  it("publishes candidate, excluded-by-reason, scanned, tracked-generated, and read-failure totals", () => {
    const { partition } = inventory;
    expect(partition.candidateTotal).toBeGreaterThan(1000);
    expect(partition.candidateTotal + partition.excludedTotal).toBe(partition.trackedTotal);
    expect(partition.scannedTotal).toBe(partition.candidateTotal - partition.readFailureTotal);
    expect(partition.readFailureTotal).toBe(0);
    expect(partition.parseFailureTotal).toBe(0);
    expect(Object.keys(partition.excludedByReason).sort()).toEqual([...privacyProductTruthExclusionReasons].sort());
    expect(Object.values(partition.excludedByReason).reduce((total, value) => total + value, 0)).toBe(
      partition.excludedTotal,
    );
    for (const reason of privacyProductTruthExclusionReasons) {
      expect(partition.excludedByReason[reason], reason).toBeGreaterThan(0);
    }
    // Tracked generated modules stay visible in the scanned partition and are
    // marked non-authoritative rather than excluded.
    expect(partition.trackedGeneratedTotal).toBeGreaterThan(0);
    expect(inventory.trackedGeneratedFiles).toContain("contracts/public-docs/generated/privacy-policy-publication.ts");
    expect(inventory.trackedGeneratedFiles.every(isPrivacyProductTruthCandidateModule)).toBe(true);
  });

  it(
    "enumerates the Git index, so ignored build output never enters the partition",
    () => {
      const before = listPrivacyProductTruthTrackedPaths(repoRoot);
      const ignoredDirectory = join(repoRoot, "artifacts", "privacy-product-truth-partition-control");
      const ignoredModule = join(ignoredDirectory, "ignored-build-output.ts");
      try {
        mkdirSync(ignoredDirectory, { recursive: true });
        writeFileSync(
          ignoredModule,
          'export const IGNORED_COOKIE_NAME = "chase_sets_ignored_build_output";\n' +
            'export function write(headers: Headers) {\n  headers.append("Set-Cookie", `${IGNORED_COOKIE_NAME}=x`);\n}\n',
          "utf8",
        );
        const ignoreCheck = execFileSync("git", ["check-ignore", "-q", "artifacts/"], {
          cwd: repoRoot,
          stdio: ["ignore", "pipe", "pipe"],
        });
        expect(ignoreCheck.toString()).toBe("");

        const after = listPrivacyProductTruthTrackedPaths(repoRoot);
        expect(after).toEqual(before);
        expect(after.some((entry) => entry.includes("privacy-product-truth-partition-control"))).toBe(false);

        const rederived = derivePrivacyProductTruthInventory({
          ...readPrivacyProductTruthSources({ repoRoot }),
          externalPackageClassifications: privacyExternalClientPackageClassifications,
        });
        expect(rederived.facts.map((fact) => `${fact.factFamily} ${fact.subject}`)).toEqual(
          inventory.facts.map((fact) => `${fact.factFamily} ${fact.subject}`),
        );
        expect(rederived.sourceDigest).toBe(inventory.sourceDigest);
      } finally {
        rmSync(ignoredDirectory, { recursive: true, force: true });
      }
    },
    LONG_DERIVATION_MS,
  );

  it("partitions a synthetic tracked list without touching the filesystem", () => {
    const { candidates, excluded } = partitionPrivacyProductTruthPaths([
      "a/ordinary.ts",
      "a/ordinary.tsx",
      "a/thing.test.ts",
      "a/thing.spec.tsx",
      "a/thing.d.ts",
      "a/tests/thing.ts",
      "a/thing-test-support.ts",
      "a/notes.md",
    ]);
    expect(candidates).toEqual(["a/ordinary.ts", "a/ordinary.tsx"]);
    expect(excluded.map((entry) => entry.reason)).toEqual([
      "test-module",
      "spec-module",
      "declaration-module",
      "test-path-segment",
      "test-support-module",
      "not-typescript-source",
    ]);
  });
});

describe("privacy product-truth derivation over the real repository", () => {
  it("resolves every derived member: nothing is indeterminate at this head", () => {
    expect(inventory.indeterminate).toEqual([]);
    expect(inventory.readFailures).toEqual([]);
  });

  it("derives every shipped first-party cookie subject and collapses duplicate name aliases", () => {
    expect(subjectsOf("first-party-cookie")).toEqual([
      "chase_sets_account_selection",
      "chase_sets_anonymous_cart",
      "chase_sets_anonymous_listing_drafts",
      "chase_sets_anonymous_product_alerts",
      "chase_sets_anonymous_reports",
      "chase_sets_anonymous_saved_lists",
      "chase_sets_anonymous_sell_list",
      "chase_sets_color_mode",
      "chase_sets_guest_checkout",
      "chase_sets_session",
    ]);

    // Direct template writer, local serializer helper, and a parameterised
    // writer helper whose cookie name only resolves through its call sites.
    expect(factFor("first-party-cookie", "chase_sets_anonymous_saved_lists").derivationShapes).toContain(
      "headers-append",
    );
    expect(factFor("first-party-cookie", "chase_sets_session").derivationShapes).toContain("cookie-writer-helper-call");

    // Two tracked constants declare the same shipped session cookie; the
    // inventory reports one subject with both aliases rather than two subjects.
    expect(factFor("first-party-cookie", "chase_sets_session").detail.aliasCount).toBe(2);
    expect(factFor("first-party-cookie", "chase_sets_session").detail.aliasDeclarations).toEqual([
      "bounded-contexts/auth/support/request-support/cookies.ts:1",
      "contracts/auth-context/index.ts:3",
    ]);
    expect(factFor("first-party-cookie", "chase_sets_guest_checkout").detail.aliasCount).toBe(2);
  });

  it("derives Web Storage subjects through direct, helper, alias, Pick<Storage>, and dynamic-key shapes", () => {
    expect(subjectsOf("web-storage")).toEqual([
      "catalog.primaryWorkbench.observationSelection.*",
      "chase-sets-theme",
      "chase-sets:marketplace:recent-searches",
      "chase-sets:review-draft:*",
      "discovery.search.loader-cache.v1",
      "discovery.search.restoration.v2",
    ]);

    expect(factFor("web-storage", "chase-sets-theme").derivationShapes).toEqual(["direct-member-access"]);
    expect(factFor("web-storage", "chase-sets:marketplace:recent-searches").derivationShapes).toEqual([
      "direct-member-access",
    ]);
    // Indirect `Pick<Storage, ...>` seams on the public /search route.
    expect(factFor("web-storage", "discovery.search.restoration.v2").derivationShapes).toEqual([
      "injected-pick-storage",
    ]);
    expect(factFor("web-storage", "discovery.search.loader-cache.v1").derivationShapes).toEqual([
      "injected-pick-storage",
    ]);
    // Dynamic key families: an order-scoped consumer family and the
    // operator-only workbench family behind a local storage helper.
    expect(factFor("web-storage", "chase-sets:review-draft:*").detail.dynamicKeyFamily).toBe(true);
    const operator = factFor("web-storage", "catalog.primaryWorkbench.observationSelection.*");
    expect(operator.detail.dynamicKeyFamily).toBe(true);
    expect(operator.derivationShapes).toEqual(["local-storage-helper"]);
    expect(operator.detail.storageAreas).toEqual(["sessionStorage"]);

    for (const subject of subjectsOf("web-storage")) {
      expect(factFor("web-storage", subject).detail.operations, subject).toContain("setItem");
    }
  });

  it("derives every provider-injected client-storage surface with loader, dependency, CSP, and route authority", () => {
    expect(subjectsOf("provider-injected-client-storage")).toEqual([
      "@stripe/connect-js@bounded-contexts/settlement/features/payout-readiness/ui/payout-setup-page.tsx",
      "@stripe/connect-js@bounded-contexts/settlement/features/payout-readiness/ui/stripe-connect-notification-banner.tsx",
      "@stripe/stripe-js@bounded-contexts/payments/features/payments/ui/account-payment/stripe-confirmation-card.tsx",
      "@stripe/stripe-js@bounded-contexts/payments/features/payments/ui/account-payment/stripe-setup-card.tsx",
    ]);

    const confirmation = factFor(
      "provider-injected-client-storage",
      "@stripe/stripe-js@bounded-contexts/payments/features/payments/ui/account-payment/stripe-confirmation-card.tsx",
    );
    expect(confirmation.detail.loaderExports).toEqual(["loadStripe"]);
    expect(confirmation.detail.consumerRoutes).toEqual([
      "/account/payments/:paymentId",
      "/checkout/buy/session/:sessionId",
      "/checkout/payments/:paymentId",
    ]);
    expect(confirmation.detail.dependencyOwners).toEqual([
      "@chase-sets/app-marketplace-web@9.9.0",
      "@chase-sets/payments@9.9.0",
    ]);
    expect(confirmation.detail.cspScriptOrigins).toEqual(["https://js.stripe.com"]);

    const setup = factFor(
      "provider-injected-client-storage",
      "@stripe/stripe-js@bounded-contexts/payments/features/payments/ui/account-payment/stripe-setup-card.tsx",
    );
    expect(setup.detail.consumerRoutes).toEqual(["/account/payment-methods"]);

    for (const module of ["payout-setup-page.tsx", "stripe-connect-notification-banner.tsx"]) {
      const connect = factFor(
        "provider-injected-client-storage",
        `@stripe/connect-js@bounded-contexts/settlement/features/payout-readiness/ui/${module}`,
      );
      expect(connect.detail.loaderExports, module).toEqual(["loadConnectAndInitialize"]);
      // /account/payouts/setup is retained only as a redirect to this surface,
      // so it is not derived as a loader-bearing consumer route.
      expect(connect.detail.consumerRoutes, module).toEqual(["/account/desk/settings"]);
      expect(connect.detail.dependencyOwners, module).toEqual(["@chase-sets/settlement@3.4.5"]);
      expect(connect.detail.cspScriptOrigins, module).toEqual([
        "https://connect-js.stripe.com",
        "https://js.stripe.com",
      ]);
    }

    // Every committed CSP script/frame origin is owned by a classified loader.
    expect(inventory.cspScriptOrigins).toEqual(["https://connect-js.stripe.com", "https://js.stripe.com"]);
    // The classification set is the whole derived external surface, not a
    // shortlist of known providers.
    for (const packageName of inventory.observedExternalPackages) {
      expect(privacyExternalClientPackageClassifications[packageName], packageName).toBeDefined();
    }
  });

  it("derives CacheStorage facts from typed ServiceWorkerPolicy literals without parsing the generated worker body", () => {
    expect(subjectsOf("cache-storage")).toEqual(["chase-sets-admin-pwa-v1", "chase-sets-marketplace-pwa-v1"]);

    const marketplace = factFor("cache-storage", "chase-sets-marketplace-pwa-v1");
    expect(marketplace.derivationShapes).toEqual(["root-registration", "typed-service-worker-policy", "worker-route"]);
    expect(marketplace.detail.deployable).toBe("marketplace");
    expect(marketplace.detail.credentialedRequestHandling).toBe("skip");
    expect(marketplace.detail.excludedExactPaths).toEqual([
      "/guest-checkout/exit",
      "/sign-in",
      "/sign-out",
      "/register",
    ]);
    expect(marketplace.detail.excludedPathPrefixes).toEqual([
      "/api/",
      "/account",
      "/checkout",
      "/payment",
      "/payments",
      "/orders",
    ]);
    expect(marketplace.detail.workerRoutePath).toBe("/service-worker.js");
    expect(marketplace.detail.registrationRoot).toBe("deployables/marketplace/app/root.tsx");
    expect(marketplace.detail.registeredOnlyInProductionBuilds).toBe(true);

    const admin = factFor("cache-storage", "chase-sets-admin-pwa-v1");
    expect(admin.detail.deployable).toBe("admin-web");
    expect(admin.detail.registrationRoot).toBe("deployables/admin-web/app/root.tsx");

    // The generated `String.raw` worker body is never an evidence source.
    for (const subject of subjectsOf("cache-storage")) {
      for (const ref of factFor("cache-storage", subject).evidenceRefs) {
        expect(ref, subject).not.toContain("infrastructure/platform-runtime/pwa.ts");
      }
    }
  });

  it("derives executable social-login providers and every mapped profile field", () => {
    expect(subjectsOf("social-provider-profile")).toEqual(["facebook", "google"]);

    const google = factFor("social-provider-profile", "google");
    expect(google.detail.mappedProfileFields).toEqual([
      "displayName",
      "email",
      "emailVerified",
      "familyName",
      "givenName",
      "hostedDomain",
      "providerName",
      "providerSubject",
    ]);
    expect(google.detail.registrationRefs).toEqual(["deployables/platform-api/src/main.ts:203-206"]);

    const facebook = factFor("social-provider-profile", "facebook");
    expect(facebook.detail.mappedProfileFields).not.toContain("hostedDomain");
    expect(facebook.detail.registrationRefs).toEqual(["deployables/platform-api/src/main.ts:211-214"]);
  });

  it("resolves every derived evidence reference to real cited source lines", () => {
    for (const fact of inventory.facts) {
      expect(fact.evidenceRefs.length, `${fact.factFamily} ${fact.subject}`).toBeGreaterThan(0);
      for (const ref of fact.evidenceRefs) {
        const slice = readCitedSourceSlice(repoRoot, ref);
        expect(slice.error, `${fact.subject} -> ${ref}`).toBeUndefined();
        expect(slice.text, `${fact.subject} -> ${ref}`).toBeTypeOf("string");
      }
    }
  });

  it(
    "collects the same inventory through the public repository entrypoint",
    () => {
      const collected = collectPrivacyProductTruthInventory({
        repoRoot,
        externalPackageClassifications: privacyExternalClientPackageClassifications,
      });
      expect(collected.sourceDigest).toBe(inventory.sourceDigest);
      expect(collected.version).toBe(inventory.version);
    },
    LONG_DERIVATION_MS,
  );
});

describe("privacy product-truth one-variable controls", () => {
  it(
    "control 4: deleting only the loadStripe call in stripe-setup-card.tsx makes only that provider surface disappear",
    () => {
      const mutant = deriveWithMutatedSources([
        {
          relativePath: "bounded-contexts/payments/features/payments/ui/account-payment/stripe-setup-card.tsx",
          mutate: (source) => source.replace("void loadStripe(publishableKey)", "void Promise.resolve(publishableKey)"),
        },
      ]);

      expect(
        mutant.facts
          .filter((fact) => fact.factFamily === "provider-injected-client-storage")
          .map((fact) => fact.subject),
      ).toEqual([
        "@stripe/connect-js@bounded-contexts/settlement/features/payout-readiness/ui/payout-setup-page.tsx",
        "@stripe/connect-js@bounded-contexts/settlement/features/payout-readiness/ui/stripe-connect-notification-banner.tsx",
        "@stripe/stripe-js@bounded-contexts/payments/features/payments/ui/account-payment/stripe-confirmation-card.tsx",
      ]);

      // Preserved variables stay green: cookies, Web Storage, CacheStorage, and
      // social providers are byte-identical to the candidate derivation.
      for (const family of ["first-party-cookie", "web-storage", "cache-storage", "social-provider-profile"]) {
        expect(
          mutant.facts.filter((fact) => fact.factFamily === family).map((fact) => fact.subject),
          family,
        ).toEqual(subjectsOf(family));
      }
    },
    LONG_DERIVATION_MS,
  );

  it(
    "control 5: an external client-loader call at an arbitrary tracked production path surfaces instead of disappearing",
    () => {
      const arbitraryPath = "some/arbitrary/tracked/place/provider-widget.tsx";
      const mutant = deriveWithMutatedSources(
        [
          {
            relativePath: "bounded-contexts/payments/routes/marketplace/account-payment-methods.tsx",
            mutate: (source) =>
              `import { ArbitraryProviderWidget } from "../../../../some/arbitrary/tracked/place/provider-widget";\n${source}`,
          },
        ],
        [
          {
            relativePath: arbitraryPath,
            source:
              'import { loadStripe } from "@stripe/stripe-js";\n\n' +
              "export function ArbitraryProviderWidget({ publishableKey }: { publishableKey: string }) {\n" +
              "  void loadStripe(publishableKey);\n" +
              "  return null;\n" +
              "}\n",
          },
        ],
      );

      const surfaces = mutant.facts
        .filter((fact) => fact.factFamily === "provider-injected-client-storage")
        .map((fact) => fact.subject);
      expect(surfaces).toContain(`@stripe/stripe-js@${arbitraryPath}`);
      expect(surfaces).toHaveLength(5);
      const derived = mutant.facts.find((fact) => fact.subject === `@stripe/stripe-js@${arbitraryPath}`);
      expect(derived?.detail.consumerRoutes).toEqual(["/account/payment-methods"]);
    },
    LONG_DERIVATION_MS,
  );

  it(
    "control 5b: an unclassified external package on a consumer-reachable surface fails closed",
    () => {
      const mutant = derivePrivacyProductTruthInventory({
        ...sources,
        externalPackageClassifications: Object.fromEntries(
          Object.entries(privacyExternalClientPackageClassifications).filter(([name]) => name !== "@stripe/stripe-js"),
        ),
      });
      expect(mutant.indeterminate.map((entry) => entry.reason)).toEqual([
        expect.stringContaining("external package '@stripe/stripe-js'"),
      ]);
      // The unclassified package's surfaces disappear from the fact set rather
      // than defaulting to handled.
      expect(
        mutant.facts
          .filter((fact) => fact.factFamily === "provider-injected-client-storage")
          .map((fact) => fact.subject),
      ).toEqual([
        "@stripe/connect-js@bounded-contexts/settlement/features/payout-readiness/ui/payout-setup-page.tsx",
        "@stripe/connect-js@bounded-contexts/settlement/features/payout-readiness/ui/stripe-connect-notification-banner.tsx",
      ]);
    },
    LONG_DERIVATION_MS,
  );

  it(
    "control 5c: a committed CSP script origin with no classified owner fails closed",
    () => {
      const mutant = derivePrivacyProductTruthInventory({
        ...sources,
        externalPackageClassifications: Object.fromEntries(
          Object.entries(privacyExternalClientPackageClassifications).filter(
            ([name]) => name !== "@stripe/stripe-js" && name !== "@stripe/connect-js",
          ),
        ),
      });
      const reasons = mutant.indeterminate.map((entry) => entry.reason);
      for (const origin of ["https://connect-js.stripe.com", "https://js.stripe.com"]) {
        expect(reasons, origin).toEqual(
          expect.arrayContaining([expect.stringContaining(`origin '${origin}' (bounded-contexts/settlement`)]),
        );
      }
      expect(mutant.facts.filter((fact) => fact.factFamily === "provider-injected-client-storage")).toEqual([]);
    },
    LONG_DERIVATION_MS,
  );

  it(
    "control 7: a typed ServiceWorkerPolicy with a new cache name at an arbitrary tracked path fails naming that subject",
    () => {
      const arbitraryPath = "some/arbitrary/tracked/place/rogue-service-worker-source.ts";
      const mutant = deriveWithMutatedSources(
        [],
        [
          {
            relativePath: arbitraryPath,
            source:
              'import { type ServiceWorkerPolicy } from "@chase-sets/platform-runtime/pwa";\n\n' +
              "export const roguePolicy = {\n" +
              '  cacheName: "chase-sets-rogue-cache-v9",\n' +
              '  offlineUrl: "/offline",\n' +
              "  coreAssets: [],\n" +
              "  excludedExactPaths: [],\n" +
              "  excludedPathPrefixes: [],\n" +
              "  staticAssetExactPaths: [],\n" +
              "  staticAssetPathPrefixes: [],\n" +
              "  staticAssetExtensions: [],\n" +
              "} as const satisfies ServiceWorkerPolicy;\n",
          },
        ],
      );

      const reasons = mutant.indeterminate
        .filter((entry) => entry.factFamily === "cache-storage")
        .map((entry) => entry.reason);
      expect(reasons).toHaveLength(1);
      expect(reasons[0]).toContain("chase-sets-rogue-cache-v9");
      expect(reasons[0]).toContain("unclassified");
      // The known cache subjects stay derived and green.
      expect(mutant.facts.filter((fact) => fact.factFamily === "cache-storage").map((fact) => fact.subject)).toEqual([
        "chase-sets-admin-pwa-v1",
        "chase-sets-marketplace-pwa-v1",
      ]);
    },
    LONG_DERIVATION_MS,
  );

  it(
    "a cookie writer whose name cannot be resolved fails closed instead of disappearing",
    () => {
      const mutant = deriveWithMutatedSources([
        {
          relativePath: "bounded-contexts/collections/features/saved-lists/api/anonymous-cookie.ts",
          mutate: (source) =>
            source.replace(
              "`${COLLECTIONS_ANONYMOUS_SAVED_LIST_COOKIE_NAME}=${encodeURIComponent(anonymousOwnerId)}",
              "`${resolveCookieName()}=${encodeURIComponent(anonymousOwnerId)}",
            ),
        },
      ]);
      expect(
        mutant.facts.filter((fact) => fact.factFamily === "first-party-cookie").map((fact) => fact.subject),
      ).not.toContain("chase_sets_anonymous_saved_lists");
      expect(mutant.indeterminate.map((entry) => entry.reason)).toEqual([
        "cookie write at bounded-contexts/collections/features/saved-lists/api/anonymous-cookie.ts:17-20 resolved to an empty cookie name",
      ]);
    },
    LONG_DERIVATION_MS,
  );

  it(
    "an unresolved Storage-shaped receiver fails closed instead of disappearing",
    () => {
      const mutant = deriveWithMutatedSources([
        {
          relativePath: "bounded-contexts/discovery/features/search/ui/search-loader-cache.ts",
          mutate: (source) =>
            source.replace(
              'type SearchLoaderCacheStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;',
              "type SearchLoaderCacheStorage = UnresolvableStorageShape;",
            ),
        },
      ]);
      expect(
        mutant.facts.filter((fact) => fact.factFamily === "web-storage").map((fact) => fact.subject),
      ).not.toContain("discovery.search.loader-cache.v1");
      expect(mutant.indeterminate.map((entry) => entry.reason)).toEqual(
        expect.arrayContaining([expect.stringContaining("Storage-shaped but unresolved receiver")]),
      );
    },
    LONG_DERIVATION_MS,
  );

  it(
    "an unreadable tracked production module fails closed",
    () => {
      const mutant = derivePrivacyProductTruthInventory({
        ...sources,
        records: [
          ...sources.records.filter(
            (record) => record.relativePath !== "bounded-contexts/auth/support/auth-support/http.ts",
          ),
          { relativePath: "bounded-contexts/auth/support/auth-support/http.ts", readError: "simulated read failure" },
        ],
        externalPackageClassifications: privacyExternalClientPackageClassifications,
      });
      expect(mutant.readFailures).toEqual([
        { relativePath: "bounded-contexts/auth/support/auth-support/http.ts", reason: "simulated read failure" },
      ]);
      expect(mutant.indeterminate.map((entry) => entry.reason)).toEqual(
        expect.arrayContaining([expect.stringContaining("simulated read failure")]),
      );
    },
    LONG_DERIVATION_MS,
  );
});
