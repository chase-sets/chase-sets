import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import * as channelsClient from "../bounded-contexts/channels/client.ts";
import {
  batchE2eSuiteIds,
  chromiumProbeCallerViolations,
  e2eNoSuiteExclusionForChangedFile,
  e2eSuiteIdsForChangedFile,
  e2eSuites,
  isE2eSpecFile,
  isRouteFile,
} from "./e2e-suites.mjs";
import { buildSuiteGrep, commandSuiteInvocation, parseSuiteArgs } from "./run-e2e-suite.mjs";
import * as renderedCopyRunner from "./run-e2e-suite.mjs";
import * as suiteRegistry from "./e2e-suites.mjs";
import {
  attributeRenderedCopy,
  buildCapturePart,
  classifyRenderedCopy,
  finalRenderedCopyObservations,
  renderedCopyClasses,
  renderedCopyTupleKey,
  renderedCopyTuples,
  sweepRenderedCopy,
  validateCapturePart,
} from "../infrastructure/playwright-evidence/rendered-copy.ts";
import {
  TCGPLAYER_CONNECTOR_EXTENSION_ID,
  TCGPLAYER_CONNECTOR_EXTENSION_KEY,
  TCGPLAYER_CONNECTOR_REDIRECT_URI,
} from "../bounded-contexts/channels/features/connector-client/domain/identity.ts";

describe("dedicated rendered-copy substrate", () => {
  it("isolates the dedicated entry without changing ordinary batching", () => {
    const ordinary = ["marketplace_account", "admin_access", "marketplace_browse"];
    expect(suiteRegistry.batchBrowserE2eSuiteIds([...ordinary, "rendered_copy"])).toEqual([
      ...batchE2eSuiteIds(ordinary),
      "rendered_copy",
    ]);
    expect(() => parseSuiteArgs(["rendered_copy,admin_access"])).toThrow("unpaired");
  });

  it("rejects missing, extra, duplicate, owning-tagged, filtered and reordered listings", () => {
    const order = renderedCopyRunner.expectedRenderedCopyListing();
    expect(order).toHaveLength(32);
    expect(() => renderedCopyRunner.assertRenderedCopyListing(order)).not.toThrow();
    const owning = structuredClone(order);
    owning[0].title = owning[0].title.replace("@rendered-copy", "@marketplace-account");
    for (const mutant of [
      order.slice(1),
      [...order, order[0]],
      [...order.slice(0, -1), order[0]],
      owning,
      order.filter((_, index) => index % 2),
      [...order].reverse(),
    ]) {
      expect(() => renderedCopyRunner.assertRenderedCopyListing(mutant)).toThrow("exact listed set");
    }
    const owningGrep = new RegExp(buildSuiteGrep(e2eSuites.filter((suite) => suite.id !== "rendered_copy")));
    for (const entry of order) expect(owningGrep.test(entry.title), entry.title).toBe(false);
    for (const spec of new Set(order.map((entry) => entry.path))) {
      const source = readFileSync(spec, "utf8");
      expect(source).toContain("@rendered-copy @browser-e2e-seed");
      expect(source).not.toContain("${tuple.tag}");
    }
  });

  const observations = () =>
    renderedCopyTuples.map((tuple) => ({
      schema: "rendered-copy-observation/v1",
      tuple,
      retry: 0,
      durationMs: 10,
      witness: "populated",
      counts: Object.fromEntries(renderedCopyClasses.map((kind) => [kind, 0])),
      fields: [],
    }));
  const attempts = () =>
    renderedCopyTuples.map((tuple) => ({ key: renderedCopyTupleKey(tuple), retry: 0, status: "passed" }));
  const input = () => ({
    candidate: { commit: "a".repeat(40), tree: "b".repeat(40), sourceHead: "c".repeat(40) },
    run: {
      workflow: "platform-pr.yml",
      event: "pull_request",
      id: 1,
      attempt: 2,
      jobIndex: 3,
      batch: "rendered_copy",
      capturedAt: "2026-10-19T00:00:00.000Z",
    },
    observations: observations(),
    attempts: attempts(),
  });

  it("records a classified unattributed occurrence without a baseline or toggle", async () => {
    expect(classifyRenderedCopy("ord_seed_visible")).toEqual([{ class: "seed-id", text: "ord_seed_visible" }]);
    const data = input();
    const { fields, violations } = attributeRenderedCopy(
      data.observations[0].tuple.page,
      [
        {
          class: "seed-id",
          text: "ord_seed_visible",
          region: "main",
          label: null,
          path: "body > main",
          within: [],
        },
      ],
      [],
    );
    expect(violations).toEqual([]);
    data.observations[0].fields = fields;
    data.observations[0].counts["seed-id"] = 1;
    const part = buildCapturePart(data);
    expect(part.observations[0].fields[0]).toMatchObject({ token: null, count: 1, samples: ["ord_seed_visible"] });
    expect(validateCapturePart(part)).toEqual([]);
    expect(validateCapturePart({ ...part, run: { ...part.run, event: "merge_group" } })).toContain(
      "run: invalid producer identity",
    );
    const directory = mkdtempSync(join(tmpdir(), "rendered-copy-observe-"));
    try {
      const observed = await sweepRenderedCopy(
        {
          evaluate: async () => ({
            total: ["seed-id"],
            occurrences: [
              {
                class: "seed-id",
                text: "ord_seed_visible",
                region: "main",
                label: null,
                path: "body > main",
                within: [],
              },
            ],
          }),
        },
        renderedCopyTuples[0],
        { retry: 0, startedAt: Date.now(), witness: "populated" },
        directory,
      );
      expect(observed.fields[0]).toMatchObject({ token: null, count: 1 });
      data.observations[0] = observed;
      expect(validateCapturePart(buildCapturePart(data))).toEqual([]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("emits only final observations, lists retries, and rejects missing/conflicting terminal attempts and failed finals", () => {
    const data = input();
    data.attempts[0].status = "failed";
    data.attempts.push({ ...data.attempts[0], retry: 1, status: "passed" });
    data.observations.push({ ...data.observations[0], retry: 1, durationMs: 20 });
    data.observations[0] = { ...data.observations[0], counts: { ...data.observations[0].counts, "seed-id": 7 } };
    const part = buildCapturePart(data);
    expect(part.retriedTuples).toEqual([renderedCopyTupleKey(renderedCopyTuples[0])]);
    expect(part.observations[0].retry).toBe(1);
    expect(part.observations[0].counts["seed-id"]).toBe(0);
    expect(part.observations).toHaveLength(renderedCopyTuples.length);
    expect(validateCapturePart(part)).toEqual([]);
    const missing = data.attempts.filter((entry) => !(entry.key === data.attempts[0].key && entry.retry === 0));
    expect(() => finalRenderedCopyObservations(data.observations, missing)).toThrow(
      "missing or conflicting terminal attempt",
    );
    expect(() =>
      finalRenderedCopyObservations(data.observations, [...data.attempts, { ...data.attempts[0], status: "passed" }]),
    ).toThrow("conflicting terminal attempt");
    expect(() => finalRenderedCopyObservations(data.observations, data.attempts.slice(0, -1))).toThrow("final attempt");
    expect(() => finalRenderedCopyObservations(data.observations.slice(0, -1), data.attempts)).toThrow(
      "missing final observation",
    );
    expect(() => finalRenderedCopyObservations([...data.observations, data.observations[0]], data.attempts)).toThrow(
      "conflicting observation",
    );
  });

  it("derives attempts from the actual terminal reporter, not observation presence", () => {
    const order = renderedCopyRunner.expectedRenderedCopyListing();
    const report = {
      config: { projects: [{ name: "marketplace-chromium" }, { name: "admin-web-chromium" }] },
      suites: [...new Set(order.map((entry) => entry.path))].map((path) => ({
        specs: order
          .filter((entry) => entry.path === path)
          .map((entry, index) => ({
            file: path,
            title: entry.title,
            line: index,
            column: 1,
            tests: [{ projectName: entry.project, results: [{ retry: 0, status: "passed" }] }],
          })),
      })),
    };
    expect(renderedCopyRunner.renderedCopyAttempts(report)).toEqual(attempts());
    const unknown = structuredClone(report);
    unknown.suites[0].specs[0].tests.push({ projectName: "synthetic-unknown", results: [] });
    expect(() => renderedCopyRunner.renderedCopyAttempts(unknown)).toThrow("unknown project");
    report.suites[0].specs[0].tests[0].results = [{ retry: 0, status: "failed" }];
    expect(() =>
      finalRenderedCopyObservations(observations(), renderedCopyRunner.renderedCopyAttempts(report)),
    ).toThrow("final attempt 0 failed");
  });
});

function walkFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = join(dir, entry.name);
    return entry.isDirectory() ? walkFiles(entryPath) : [entryPath.replace(/\\/g, "/")];
  });
}

describe("run e2e suite", () => {
  it("claims one playwright root before dispatching registered suites through the production entrypoint", async () => {
    const events = [];
    const commandSuites = e2eSuites.filter((suite) => Array.isArray(suite.command));
    const grepSuites = parseSuiteArgs(["marketplace_checkout,marketplace_seller"]);
    const argv = process.argv;
    vi.resetModules();
    vi.doMock("./lib/heavy-slot.mjs", () => ({
      acquireHeavySlot: (kind) => events.push({ admission: kind }),
    }));
    vi.doMock("./lib/process.mjs", async () => ({
      ...(await vi.importActual("./lib/process.mjs")),
      runCommand: async (command, args, options) => events.push({ command, args, options }),
    }));
    vi.doMock("./validate-responsive-evidence-artifacts.mjs", () => ({
      validateResponsiveEvidenceArtifacts: async (options) => {
        events.push({ artifacts: options });
        return { violations: [], expectedClaimIds: [], manifests: [] };
      },
    }));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      process.argv = [
        process.execPath,
        fileURLToPath(new URL("./run-e2e-suite.mjs", import.meta.url)),
        "--",
        ...grepSuites.map((suite) => suite.id),
        ...commandSuites.map((suite) => suite.id),
      ];
      await import("./run-e2e-suite.mjs");
      await vi.dynamicImportSettled();
      const { buildPackageManagerInvocation } = await vi.importActual("./lib/process.mjs");
      const rootDir = fileURLToPath(new URL("../", import.meta.url));
      const options = { cwd: rootDir, stdio: "inherit" };
      expect(events).toEqual([
        { admission: "playwright" },
        {
          ...buildPackageManagerInvocation(["exec", "playwright", "test", "--grep", buildSuiteGrep(grepSuites)]),
          options,
        },
        { artifacts: { repoRoot: rootDir, selectedGreps: grepSuites.map((suite) => suite.grep) } },
        ...commandSuites.map((suite) => ({ ...commandSuiteInvocation(suite), options })),
      ]);
    } finally {
      process.argv = argv;
      log.mockRestore();
      vi.doUnmock("./lib/heavy-slot.mjs");
      vi.doUnmock("./lib/process.mjs");
      vi.doUnmock("./validate-responsive-evidence-artifacts.mjs");
      vi.resetModules();
    }
  });

  it("provides a display for the headed Chromium command on Linux without changing package scripts", () => {
    const suite = e2eSuites.find((entry) => entry.id === "tcgplayer_connector_extension");
    const ordinary = commandSuiteInvocation(suite, "win32", {});
    expect(commandSuiteInvocation(suite, "linux", {})).toEqual({
      command: "xvfb-run",
      args: ["--auto-servernum", ordinary.command, ...ordinary.args],
    });
    expect(commandSuiteInvocation(suite, "linux", { DISPLAY: ":99" })).toEqual(ordinary);
    expect(commandSuiteInvocation({ ...suite, requiresDisplay: false }, "linux", {})).toEqual(ordinary);
  });
  it("pins the Chromium probe package to its root caller and kills the caller-removed mutant", () => {
    const packageJson = JSON.parse(readFileSync("deployables/tcgplayer-connector-extension/package.json", "utf8"));
    expect(chromiumProbeCallerViolations([{ packageJson }])).toEqual([]);
    expect(
      chromiumProbeCallerViolations(
        [{ packageJson }],
        e2eSuites.filter((suite) => suite.id !== "tcgplayer_connector_extension"),
      ),
    ).toEqual([
      "@chase-sets/app-tcgplayer-connector-extension test:chromium must have exactly one registered E2E command caller",
    ]);
    expect(e2eSuites.find((suite) => suite.id === "tcgplayer_connector_extension")?.command).toEqual([
      "--filter",
      "@chase-sets/app-tcgplayer-connector-extension",
      "run",
      "test:chromium",
    ]);
  });

  it("pins the product identity to the Channels client contract", () => {
    expect(Object.keys(channelsClient).sort()).toEqual([
      "TCGPLAYER_CONNECTOR_EXTENSION_ID",
      "TCGPLAYER_CONNECTOR_EXTENSION_KEY",
      "TCGPLAYER_CONNECTOR_REDIRECT_URI",
      "assertConnectorRunSettlement",
      "assertTcgplayerOrderRecord",
      "buildConnectorManifest",
      "buildTcgplayerStagedImportEnvelope",
      "composeChannelOrderFulfillmentInbound",
      "composeChannelOrderFulfillmentReference",
      "composeTcgplayerOrderInbound",
      "composeTcgplayerOrderObservation",
      "createConnectorBackground",
      "createConnectorOperationCoordinator",
      "createConnectorRetentionStore",
      "createTcgplayerLiveExportExecutor",
      "createTcgplayerStagedImportReleaseGate",
      "decodeTcgplayerStagedImportFieldClassification",
      "decodeTcgplayerStagedImportReadback",
      "deriveTcgplayerStagedImportReadbackVerdict",
      "isLiveExportAuthorityRequest",
      "parseTcgplayerStagedImportReadback",
      "preflightTcgplayerStagedImport",
      "stagedImportMembershipDigest",
      "tcgplayerLiveExportAuthority",
      "tcgplayerOrderLimits",
      "tcgplayerSaleKey",
      "tcgplayerStagedImportCandidateClassification",
      "tcgplayerStagedImportReadbackLimits",
      "translateOrderShippingType",
      "translateOrderStatus",
    ]);
    expect(channelsClient).toMatchObject({
      TCGPLAYER_CONNECTOR_EXTENSION_ID,
      TCGPLAYER_CONNECTOR_EXTENSION_KEY,
      TCGPLAYER_CONNECTOR_REDIRECT_URI,
    });
  });

  it("routes the Chromium probe package and owning Channels slice to the registered caller", () => {
    expect(e2eSuiteIdsForChangedFile("deployables/tcgplayer-connector-extension/src/background.ts")).toEqual([
      "tcgplayer_connector_extension",
    ]);
    expect(
      e2eSuiteIdsForChangedFile(
        "bounded-contexts/channels/features/connector-client/domain/derive-chrome-extension-id.ts",
      ),
    ).toEqual(["tcgplayer_connector_extension"]);
  });

  it("rejects missing and unknown suites", () => {
    expect(() => parseSuiteArgs([])).toThrow("Usage:");
    expect(() => parseSuiteArgs(["unknown_suite"])).toThrow("Unknown E2E suite 'unknown_suite'");
  });

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

  it.each([
    "docker-compose.dev.yml",
    "scripts/lib/sandbox.mjs",
    "scripts/dev-system.mjs",
    "scripts/dev-system-config.mjs",
  ])("shared sandbox runtime %s covers account and seller in normal suite batches", (file) => {
    const selected = e2eSuiteIdsForChangedFile(file);
    const batched = batchE2eSuiteIds(selected).flatMap((batch) => batch.split(","));
    expect(selected).toContain("marketplace_account");
    expect(selected).toContain("marketplace_seller");
    expect(batched).toEqual(expect.arrayContaining(["marketplace_account", "marketplace_seller"]));
    expect(new Set(batched).size).toBe(selected.length);
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

  it("owns public-web specs as deployed-target coverage instead of a PR browser suite", () => {
    const publicWebSpec = "deployables/public-web/e2e/privacy-policy.spec.ts";

    expect(isE2eSpecFile(publicWebSpec)).toBe(true);
    expect(e2eSuiteIdsForChangedFile(publicWebSpec)).toEqual([]);
    expect(e2eNoSuiteExclusionForChangedFile(publicWebSpec)).toMatchObject({
      reason: expect.stringContaining("PUBLIC_WEB_URL"),
    });
    // No catalog suite may claim public-web coverage: the PR browser-e2e system
    // boots admin-web and marketplace only, so a selected public-web suite would
    // grep for tests no running host can serve.
    expect(e2eSuites.filter((suite) => suite.deployable === "public-web")).toEqual([]);
  });

  it("keeps the privacy policy candidate on the public-web host", () => {
    // Negative control for the reroute: the spec must not exist under the
    // marketplace deployable, and no marketplace spec may claim the /privacy
    // route the marketplace host does not serve.
    expect(existsSync("deployables/marketplace/e2e/privacy-policy.spec.ts")).toBe(false);
    expect(existsSync("deployables/public-web/e2e/privacy-policy.spec.ts")).toBe(true);

    const marketplaceSpecs = walkFiles("deployables/marketplace/e2e").filter((filePath) =>
      filePath.endsWith(".spec.ts"),
    );
    const marketplaceSpecsVisitingPrivacy = marketplaceSpecs.filter((filePath) =>
      /["'`]\/privacy(?:[?#/"'`]|$)/.test(readFileSync(filePath, "utf8")),
    );

    expect(marketplaceSpecsVisitingPrivacy).toEqual([]);
    expect(readFileSync("deployables/public-web/e2e/privacy-policy.spec.ts", "utf8")).toContain("public-web-chromium");
  });

  it("routes shared auth changes to marketplace and admin auth coverage", () => {
    expect(e2eSuiteIdsForChangedFile("bounded-contexts/auth/features/sign-in/ui/sign-in-page.tsx")).toEqual([
      "marketplace_account",
      "admin_auth",
    ]);
  });

  it("routes the Auth seed to its owning suites without widening runtime support", () => {
    const seedPath = "bounded-contexts/auth/support/runtime-support/seed.ts";
    const owningSuites = ["marketplace_account", "admin_auth"];
    expect(e2eSuiteIdsForChangedFile(seedPath)).toEqual(owningSuites);
    expect(e2eSuiteIdsForChangedFile(seedPath.replaceAll("/", "\\"))).toEqual(owningSuites);

    for (const filePath of [
      "bounded-contexts/auth/support/runtime-support/seed.db.test.ts",
      "bounded-contexts/auth/support/runtime-support/seed.test.ts",
      "bounded-contexts/auth/support/runtime-support/seed.ts.bak",
      "bounded-contexts/auth/support/runtime-support/retention-policy.ts",
      "bounded-contexts/unknown/support/runtime-support/seed.ts",
      "bounded-contexts/auth/features/sessions/ui/session-list-page.test.tsx",
      "bounded-contexts/auth/routes/access-admin/sessions.test.ts",
      "bounded-contexts/auth/routes/access-admin/sessions-detail.test.ts",
    ]) {
      expect(e2eSuiteIdsForChangedFile(filePath), filePath).toEqual([]);
    }

    expect(e2eSuiteIdsForChangedFile("scripts/e2e-suites.mjs")).toEqual(
      e2eSuites
        .filter(
          (suite) =>
            suite.id !== "rendered_copy" && (suite.deployable === "marketplace" || suite.deployable === "admin-web"),
        )
        .map((suite) => suite.id),
    );
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

  it("channels-e2e-suite-ownership", () => {
    expect(e2eSuiteIdsForChangedFile("bounded-contexts/channels/routes/admin/ebay-account-deletion.tsx")).toEqual([
      "admin_support",
    ]);
    // Both Channels ownership keys must independently resolve to marketplace_account,
    // so deleting either one fails here with an unexpected empty array instead of
    // silently letting `e2eSuiteIdsForChangedFile` fall through to `?? []`.
    expect(e2eSuiteIdsForChangedFile("bounded-contexts/channels/features/connections/ui/connection-pages.tsx")).toEqual(
      ["marketplace_account", "marketplace_seller"],
    );
    expect(e2eSuiteIdsForChangedFile("bounded-contexts/channels/routes/marketplace/account-channels.tsx")).toEqual([
      "marketplace_account",
      "marketplace_seller",
    ]);
    expect(
      e2eSuiteIdsForChangedFile("bounded-contexts/channels/routes/marketplace/account-channels-connection.tsx"),
    ).toEqual(["marketplace_account", "marketplace_seller"]);
  });

  it("routes the Channels account connection detail to marketplace account coverage", () => {
    expect(
      e2eSuiteIdsForChangedFile("bounded-contexts/channels/routes/marketplace/account-channels-connection.tsx"),
    ).toEqual(["marketplace_account", "marketplace_seller"]);
    expect(
      e2eSuiteIdsForChangedFile(
        "bounded-contexts/channels/routes/marketplace/account-channel-connection-manual-sync-download.tsx",
      ),
    ).toEqual(["marketplace_account", "marketplace_seller"]);
  });
});
