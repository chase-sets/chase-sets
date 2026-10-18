import { existsSync, readdirSync, readFileSync } from "node:fs";
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
import {
  renderedCopyCaptureArtifactRoot,
  renderedCopyObservationDirectory,
  renderedCopyOwningBatch,
  renderedCopySweepSpecs,
  renderedCopyTuples,
  validateCapturePart,
} from "../infrastructure/playwright-evidence/rendered-copy.ts";
import {
  buildSuiteGrep,
  commandSuiteInvocation,
  parseSuiteArgs,
  prepareRenderedCopyCapturePart,
  renderedCopyListingOrder,
} from "./run-e2e-suite.mjs";
import {
  TCGPLAYER_CONNECTOR_EXTENSION_ID,
  TCGPLAYER_CONNECTOR_EXTENSION_KEY,
  TCGPLAYER_CONNECTOR_REDIRECT_URI,
} from "../bounded-contexts/channels/features/connector-client/domain/identity.ts";

function walkFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = join(dir, entry.name);
    return entry.isDirectory() ? walkFiles(entryPath) : [entryPath.replace(/\\/g, "/")];
  });
}

describe("run e2e suite", () => {
  const commandSuites = e2eSuites.filter((suite) => Array.isArray(suite.command));
  // marketplace_seller owns sweep tuples and the committed toggle is present,
  // so on pull_request only the capture job-index binding decides whether the
  // batch is listed.
  const grepSuites = parseSuiteArgs(["marketplace_checkout,marketplace_seller"]);
  const rootDir = fileURLToPath(new URL("../", import.meta.url));

  // Runs the production entrypoint as a hosted GitHub Actions step with every
  // spawn recorded; `jobIndex` undefined is any step outside the E2E producer.
  // The trigger is pinned (pull_request unless `env` names another), because
  // the hosted scripts battery itself runs under pull_request and merge_group.
  // `spawn` answers each spawn instead of `listResult`; `observations` stands in
  // for the producer's collected observations under an enabled toggle, and
  // file writes are then recorded rather than performed.
  async function runEntrypoint({ jobIndex, listResult, env = {}, spawn, observations }) {
    const events = [];
    const writes = [];
    const argv = process.argv;
    const pinned = { GITHUB_EVENT_NAME: "pull_request", ...env };
    const ambient = Object.fromEntries(
      ["GITHUB_ACTIONS", "RENDERED_COPY_CAPTURE_JOB_INDEX", ...Object.keys(pinned)].map((name) => [
        name,
        process.env[name],
      ]),
    );
    vi.resetModules();
    vi.doMock("node:child_process", async () => ({
      ...(await vi.importActual("node:child_process")),
      spawnSync: (command, args) => {
        events.push({ spawnSync: { command, args } });
        return spawn ? spawn(command, args) : listResult;
      },
    }));
    if (observations) {
      vi.doMock("../infrastructure/playwright-evidence/rendered-copy.ts", async () => ({
        ...(await vi.importActual("../infrastructure/playwright-evidence/rendered-copy.ts")),
        renderedCopyCollectEnabled: () => true,
        readRenderedCopyObservations: () => observations,
      }));
      vi.doMock("node:fs", async () => ({
        ...(await vi.importActual("node:fs")),
        ...Object.fromEntries(
          ["rmSync", "mkdirSync", "writeFileSync", "appendFileSync"].map((name) => [
            name,
            (...args) => writes.push({ [name]: args }),
          ]),
        ),
      }));
    }
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
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined);
    try {
      process.env.GITHUB_ACTIONS = "true";
      Object.assign(process.env, pinned);
      if (jobIndex === undefined) delete process.env.RENDERED_COPY_CAPTURE_JOB_INDEX;
      else process.env.RENDERED_COPY_CAPTURE_JOB_INDEX = jobIndex;
      process.argv = [
        process.execPath,
        fileURLToPath(new URL("./run-e2e-suite.mjs", import.meta.url)),
        "--",
        ...grepSuites.map((suite) => suite.id),
        ...commandSuites.map((suite) => suite.id),
      ];
      await import("./run-e2e-suite.mjs");
      await vi.dynamicImportSettled();
      // Drain the entrypoint's settled promise chain, including its exit path,
      // before the exit spy is restored.
      await new Promise((resolve) => setImmediate(resolve));
      return { events, writes, exits: exit.mock.calls, errors: error.mock.calls };
    } finally {
      process.argv = argv;
      for (const [name, value] of Object.entries(ambient)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      log.mockRestore();
      error.mockRestore();
      exit.mockRestore();
      vi.doUnmock("node:child_process");
      vi.doUnmock("./lib/heavy-slot.mjs");
      vi.doUnmock("./lib/process.mjs");
      vi.doUnmock("./validate-responsive-evidence-artifacts.mjs");
      vi.doUnmock("../infrastructure/playwright-evidence/rendered-copy.ts");
      vi.doUnmock("node:fs");
      vi.resetModules();
    }
  }

  it("claims one playwright root before dispatching registered suites through the production entrypoint", async () => {
    // A hosted step without the producer binding never spawns `playwright --list`.
    const { events, exits } = await runEntrypoint({ jobIndex: undefined, listResult: { status: 0, stdout: "" } });
    const { buildPackageManagerInvocation } = await vi.importActual("./lib/process.mjs");
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
    expect(exits).toEqual([]);
  });

  it("lists an owning batch for capture only in the producer step that binds the capture job index", async () => {
    const { events, exits, errors } = await runEntrypoint({
      jobIndex: "0",
      listResult: { status: 1, stdout: "", stderr: "listing refused by the test" },
    });
    const { buildPackageManagerInvocation } = await vi.importActual("./lib/process.mjs");
    const list = buildPackageManagerInvocation([
      "exec",
      "playwright",
      "test",
      "--list",
      "--reporter=json",
      "--grep",
      buildSuiteGrep(grepSuites),
    ]);
    // The listing precedes the run, so a refused listing fails closed before any test runs.
    expect(events).toEqual([{ admission: "playwright" }, { spawnSync: list }]);
    expect(exits).toEqual([[1]]);
    expect(errors).toEqual([["playwright --list failed: listing refused by the test"]]);
  });

  // The producer step of hosted merge_group run 39149420287: the toggle is
  // enabled, the job index is bound, and the checkout is the queue's own merge
  // commit (also the event's head) with the single parent B.
  describe("rendered-copy capture by trigger", () => {
    const sha = (seed) => seed.repeat(40).slice(0, 40);
    const [base, head, checkout] = [sha("b"), sha("c"), sha("d")];
    const trees = { [base]: sha("1"), [head]: sha("2"), [checkout]: sha("3") };
    const batch = [...grepSuites, ...commandSuites].map((suite) => suite.id);
    const owned = renderedCopyTuples.filter((tuple) => batch.includes(tuple.suite));
    const projects = { marketplace: "marketplace-chromium", "admin-web": "admin-web-chromium" };
    const report = {
      config: { projects: Object.values(projects).map((name) => ({ name })) },
      suites: Object.entries(renderedCopySweepSpecs).map(([deployable, file]) => ({
        file,
        specs: owned
          .filter((tuple) => tuple.deployable === deployable)
          .map((tuple, index) => ({
            title: `rendered copy ${tuple.persona} ${tuple.page} ${tuple.tag} @browser-e2e-seed`,
            file,
            line: 100 + index,
            column: 3,
            tests: [{ projectName: projects[deployable] }],
          })),
      })),
    };
    const counts = Object.fromEntries(
      ["typed-id", "seed-id", "object-string", "template-placeholder", "hedged-plural", "iso-instant"].map((name) => [
        name,
        0,
      ]),
    );
    const observations = owned.map((tuple) => ({
      schema: "rendered-copy-observation/v1",
      tuple,
      retry: 0,
      durationMs: 1_000,
      witness: "populated",
      counts,
      fields: [],
    }));
    // Answers the producer's git reads for a checkout with `parents`, and its
    // one `playwright --list` with the batch report.
    const spawnFor = (parents) => (command, args) => {
      if (command !== "git") return { status: 0, stdout: `${JSON.stringify(report, null, 2)}\n` };
      const line = args.join(" ");
      const tree = /^rev-parse (\S+)\^\{tree\}$/.exec(line)?.[1];
      const answer =
        line === "show -s --diff-merges=off --format=%P HEAD"
          ? parents.join(" ")
          : line === "rev-parse HEAD"
            ? checkout
            : line === `diff --name-only ${base} HEAD`
              ? "scripts/run-e2e-suite.mjs"
              : tree
                ? trees[tree === "HEAD" ? checkout : tree]
                : line.startsWith("rev-parse HEAD:")
                  ? sha("a")
                  : undefined;
      return answer === undefined
        ? { status: 1, stdout: "", stderr: `unexpected git ${line}` }
        : { status: 0, stdout: `${answer}\n` };
    };
    const hosted = (event, sourceHead, ref) => ({
      GITHUB_EVENT_NAME: event,
      GITHUB_WORKFLOW_REF: `chase-sets/chase-sets/.github/workflows/platform-pr.yml@${ref}`,
      GITHUB_RUN_ID: "123",
      GITHUB_RUN_ATTEMPT: "1",
      GITHUB_OUTPUT: "github-output.txt",
      RENDERED_COPY_CAPTURE_SOURCE_HEAD: sourceHead,
    });
    const queue = hosted("merge_group", checkout, `refs/heads/gh-readonly-queue/main/pr-1-${base}`);
    const pullRequest = hosted("pull_request", head, "refs/pull/1/merge");

    it("neither lists, captures nor validates a part on merge_group's single-parent queue checkout", async () => {
      const { events, writes, exits, errors } = await runEntrypoint({
        jobIndex: "0",
        env: queue,
        spawn: spawnFor([base]),
        observations,
      });
      const { buildPackageManagerInvocation } = await vi.importActual("./lib/process.mjs");
      const options = { cwd: rootDir, stdio: "inherit" };
      expect(errors).toEqual([]);
      expect(exits).toEqual([]);
      expect(writes).toEqual([]);
      expect(events).toEqual([
        { admission: "playwright" },
        {
          ...buildPackageManagerInvocation(["exec", "playwright", "test", "--grep", buildSuiteGrep(grepSuites)]),
          options,
        },
        { artifacts: { repoRoot: rootDir, selectedGreps: grepSuites.map((suite) => suite.grep) } },
        ...commandSuites.map((suite) => ({ ...commandSuiteInvocation(suite), options })),
      ]);
    });

    it("keeps exact parent authentication on pull_request: the same single-parent checkout fails closed", async () => {
      const { writes, exits, errors } = await runEntrypoint({
        jobIndex: "0",
        env: pullRequest,
        spawn: spawnFor([base]),
        observations,
      });
      expect(errors).toEqual([
        [
          `rendered-copy capture part is invalid:\npart.checkout.parents: must be [B, PR head] = [${base}, ${head}], got ["${base}"]`,
        ],
      ]);
      expect(exits).toEqual([[1]]);
      expect(writes).toEqual([
        { rmSync: [join(rootDir, renderedCopyObservationDirectory), { recursive: true, force: true }] },
      ]);
    });

    it("emits one validated part on pull_request when the checkout's parents are [B, PR head]", async () => {
      const { writes, exits, errors } = await runEntrypoint({
        jobIndex: "0",
        env: pullRequest,
        spawn: spawnFor([base, head]),
        observations,
      });
      expect(errors).toEqual([]);
      expect(exits).toEqual([]);
      const [file, text] = writes.find((entry) => entry.writeFileSync).writeFileSync;
      expect(file).toBe(join(rootDir, renderedCopyCaptureArtifactRoot, "rendered-copy-capture-123-1-0", "part.json"));
      const part = JSON.parse(text);
      expect(validateCapturePart(part)).toEqual([]);
      expect(part.run).toMatchObject({ event: "pull_request", id: 123, attempt: 1, jobIndex: 0 });
      expect(part.checkout).toEqual({ commit: checkout, tree: trees[checkout], parents: [base, head] });
      expect(part.tuples).toHaveLength(owned.length);
      expect(writes.at(-1)).toEqual({ appendFileSync: ["github-output.txt", "rendered-copy-capture=true\n"] });
    });
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
      "composeChannelOrderFulfillmentInbound",
      "composeChannelOrderFulfillmentReference",
      "composeTcgplayerOrderInbound",
      "composeTcgplayerOrderObservation",
      "createConnectorBackground",
      "createConnectorOperationCoordinator",
      "createConnectorRetentionStore",
      "createTcgplayerLiveExportExecutor",
      "isLiveExportAuthorityRequest",
      "stagedImportMembershipDigest",
      "tcgplayerLiveExportAuthority",
      "tcgplayerOrderLimits",
      "tcgplayerSaleKey",
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
        .filter((suite) => suite.deployable === "marketplace" || suite.deployable === "admin-web")
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

  it("routes rendered-copy sweep specs to their complete owning suites", () => {
    expect(e2eSuiteIdsForChangedFile("deployables/marketplace/e2e/rendered-copy-sweep.spec.ts")).toEqual([
      "marketplace_account",
      "marketplace_seller",
    ]);
    expect(e2eSuiteIdsForChangedFile("deployables/admin-web/e2e/rendered-copy-sweep.spec.ts")).toEqual([
      "catalog_admin_integrations",
      "catalog_admin_modeling",
      "admin_growth",
      "admin_commerce",
      "admin_support",
      "admin_access",
    ]);
    const owners = new Set(renderedCopyTuples.map((tuple) => tuple.suite));
    expect([...owners].sort()).toEqual(
      [
        ...e2eSuiteIdsForChangedFile(renderedCopySweepSpecs.marketplace),
        ...e2eSuiteIdsForChangedFile(renderedCopySweepSpecs["admin-web"]),
      ].sort(),
    );
    for (const tuple of renderedCopyTuples) {
      expect(e2eSuites.find((suite) => suite.id === tuple.suite)?.grep, tuple.page).toBe(tuple.tag);
    }
  });

  it.each([
    "rendered-copy.ts",
    "rendered-copy-baseline.json",
    "rendered-copy-capture.json",
    "rendered-copy-collect.json",
  ])("routes shared %s to every browser suite", (file) => {
    expect(e2eSuiteIdsForChangedFile(`infrastructure/playwright-evidence/${file}`)).toEqual(
      e2eSuiteIdsForChangedFile("infrastructure/playwright-evidence/index.ts"),
    );
  });

  describe("rendered-copy capture parts", () => {
    const sha = (seed) => seed.repeat(40).slice(0, 40);
    const [base, head, checkout] = [sha("b"), sha("c"), sha("d")];
    const git = (...args) => {
      const command = args.join(" ");
      if (command === "show -s --diff-merges=off --format=%P HEAD") return `${base} ${head}`;
      if (command === "rev-parse HEAD") return checkout;
      if (command === "diff --name-only " + base + " HEAD")
        return "scripts/run-e2e-suite.mjs\ninfrastructure/playwright-evidence/rendered-copy.ts";
      if (command.startsWith("rev-parse ") && command.endsWith("^{tree}"))
        return sha(command.includes(base) ? "1" : command.includes(head) ? "2" : "3");
      if (command.startsWith("rev-parse HEAD:")) return sha("a");
      throw new Error(`unexpected git ${command}`);
    };
    const env = {
      GITHUB_WORKFLOW_REF: "chase-sets/chase-sets/.github/workflows/platform-pr.yml@refs/pull/1/merge",
      GITHUB_EVENT_NAME: "pull_request",
      GITHUB_RUN_ID: "123",
      GITHUB_RUN_ATTEMPT: "1",
      RENDERED_COPY_CAPTURE_JOB_INDEX: "3",
      RENDERED_COPY_CAPTURE_SOURCE_HEAD: head,
    };
    const batch = "marketplace_browse,marketplace_account";
    const owned = renderedCopyTuples.filter((tuple) => tuple.suite === "marketplace_account");
    const sweep = renderedCopySweepSpecs.marketplace;
    const report = {
      config: { projects: [{ name: "marketplace-chromium" }, { name: "admin-web-chromium" }] },
      suites: [
        {
          file: "deployables/marketplace/e2e/browse.spec.ts",
          specs: [
            {
              title: "browse",
              file: "deployables/marketplace/e2e/browse.spec.ts",
              line: 4,
              column: 1,
              tests: [{ projectName: "marketplace-chromium" }],
            },
          ],
        },
        {
          file: sweep,
          suites: [
            {
              specs: [
                {
                  title: "planted",
                  file: sweep,
                  line: 200,
                  column: 3,
                  tests: [{ projectName: "marketplace-chromium" }],
                },
              ],
            },
          ],
          specs: [
            { title: "census", file: sweep, line: 90, column: 1, tests: [{ projectName: "marketplace-chromium" }] },
            ...owned.map((tuple) => ({
              title: `rendered copy ${tuple.persona} ${tuple.page} ${tuple.tag} @browser-e2e-seed`,
              file: sweep,
              line: 100,
              column: 3,
              tests: [{ projectName: "marketplace-chromium" }],
            })),
          ],
        },
      ],
    };
    const zero = {
      "typed-id": 0,
      "seed-id": 0,
      "object-string": 0,
      "template-placeholder": 0,
      "hedged-plural": 0,
      "iso-instant": 0,
    };
    const observation = (tuple, retry, count) => ({
      schema: "rendered-copy-observation/v1",
      tuple,
      retry,
      durationMs: 1_000,
      witness: "populated",
      counts: { ...zero, "seed-id": count },
      fields:
        count === 0
          ? []
          : [
              {
                page: tuple.page,
                class: "seed-id",
                selector: "main",
                label: null,
                prefix: "off_",
                token: "SB8-COPY-01",
                issue: 9937,
                count,
                samples: ["off_seed_planted"],
              },
            ],
    });
    const offers = owned.find((tuple) => tuple.page === "/account/offers/submitted");
    const observations = [
      ...owned.filter((tuple) => tuple !== offers).map((tuple) => observation(tuple, 0, 0)),
      observation(offers, 0, 4),
      observation(offers, 1, 2),
    ];
    const prepare = (overrides = {}) =>
      prepareRenderedCopyCapturePart({
        batch,
        env,
        git,
        report,
        observations,
        capturedAt: "2026-10-18T05:00:00.000Z",
        ...overrides,
      });

    it("lists the batch in normal order: projects, files, then declaration line", () => {
      expect(renderedCopyListingOrder(report).map(({ title }) => title)).toEqual([
        "browse",
        "census",
        ...owned.map((tuple) => `rendered copy ${tuple.persona} ${tuple.page} ${tuple.tag} @browser-e2e-seed`),
        "planted",
      ]);
    });

    it("assembles one validated part from the highest Playwright retry, counting each tuple once", () => {
      const part = prepare();
      expect(validateCapturePart(part)).toEqual([]);
      expect(part.tuples).toHaveLength(owned.length);
      const offersTuple = part.tuples.find((tuple) => tuple.page === offers.page);
      expect(offersTuple).toMatchObject({ retry: 1, position: 3, counts: { "seed-id": 2 } });
      expect(part.fields).toEqual([expect.objectContaining({ page: offers.page, count: 2, token: "SB8-COPY-01" })]);
      expect(part.listing).toEqual([
        { path: "deployables/marketplace/e2e/browse.spec.ts", blob: sha("a"), tests: 1 },
        { path: sweep, blob: sha("a"), tests: owned.length + 2 },
      ]);
      expect(part.checkout.parents).toEqual([base, head]);
      expect(part.run).toMatchObject({ id: 123, attempt: 1, jobIndex: 3, batch, workflow: "platform-pr.yml" });
    });

    // The hosted marketplace_browse and marketplace_seller batches list these
    // bounded-context suites ahead of the sweep.
    const contextPredecessors = [
      "bounded-contexts/auth/features/invitation-acceptance/ui/browser-proof.spec.ts",
      "bounded-contexts/inventory/features/import-batches/tests/recovery.browser.ts",
      "bounded-contexts/inventory/features/restock-decisions/tests/recovery.browser.ts",
    ];

    it("assembles a part whose predecessors are bounded-context browser suites, binding each blob", () => {
      const blobs = new Map(contextPredecessors.map((file, index) => [file, sha(String(index + 4))]));
      const part = prepare({
        report: {
          ...report,
          suites: [
            ...contextPredecessors.map((file) => ({
              file,
              specs: [
                { title: "recovery", file, line: 10, column: 1, tests: [{ projectName: "marketplace-chromium" }] },
              ],
            })),
            ...report.suites,
          ],
        },
        git: (...args) => blobs.get(args.join(" ").replace(/^rev-parse HEAD:/, "")) ?? git(...args),
      });
      expect(validateCapturePart(part)).toEqual([]);
      expect(part.listing.slice(0, contextPredecessors.length)).toEqual(
        contextPredecessors.map((file) => ({ path: file, blob: blobs.get(file), tests: 1 })),
      );
      const position = (candidate) => candidate.tuples.find((tuple) => tuple.page === offers.page).position;
      expect(position(part)).toBe(position(prepare()) + contextPredecessors.length);
    });

    it.each([
      ["an absolute path", `/${contextPredecessors[1]}`],
      ["a parent segment", "bounded-contexts/../deployables/marketplace/e2e/browse.spec.ts"],
      ["a current-directory segment", `./${contextPredecessors[1]}`],
      ["an empty segment", contextPredecessors[1].replace("/tests/", "//tests/")],
      ["a Windows separator", contextPredecessors[1].replaceAll("/", "\\")],
      ["a non-TypeScript file", contextPredecessors[1].replace(/\.ts$/, ".js")],
    ])("refuses a predecessor declared at %s", (_label, file) => {
      const part = prepare();
      part.listing[0].path = file;
      expect(validateCapturePart(part)).toContain("part.listing[0].path: invalid");
    });

    it("refuses a bounded-context predecessor without its blob", () => {
      const part = prepare();
      part.listing[0] = { ...part.listing[0], path: contextPredecessors[1], blob: "" };
      expect(validateCapturePart(part)).toEqual(["part.listing[0].blob: missing predecessor blob"]);
    });

    // The hosted B..checkout of the capture PR, which carries the host-authorized
    // (#9940 9940-d3) re-pin of the verify-static-surfaces digest.
    const captureDiff = [
      ".github/workflows/platform-pr.yml",
      "bounded-contexts/public-presence/features/policies/domain/canonical-claim-guard.test.ts",
      "deployables/admin-web/e2e/rendered-copy-sweep.spec.ts",
      "deployables/marketplace/app/smoke-auth-support.test.ts",
      "deployables/marketplace/e2e/rendered-copy-sweep.spec.ts",
      "infrastructure/playwright-evidence/package.json",
      "infrastructure/playwright-evidence/rendered-copy-baseline.json",
      "infrastructure/playwright-evidence/rendered-copy-collect.json",
      "infrastructure/playwright-evidence/rendered-copy.ts",
      "scripts/ci-gate-plan.test.mjs",
      "scripts/e2e-suites.mjs",
      "scripts/fixtures/ci-e2e-selection.json",
      "scripts/rendered-copy-provenance.test.mjs",
      "scripts/run-e2e-suite.mjs",
      "scripts/run-e2e-suite.test.mjs",
      "scripts/verify-static-scoped.test.mjs",
      "scripts/verify-static-surfaces.mjs",
      "tsconfig.base.json",
    ];

    it("assembles a part whose B..checkout diff carries the authorized canonical-claim digest re-pin", () => {
      const part = prepare({
        git: (...args) => (args.join(" ") === `diff --name-only ${base} HEAD` ? captureDiff.join("\n") : git(...args)),
      });
      expect(validateCapturePart(part)).toEqual([]);
      expect(part.diff).toEqual(captureDiff);
    });

    it("fails an eligible batch whose final observation is missing instead of emitting a partial part", () => {
      expect(() => prepare({ observations: observations.filter((entry) => entry.tuple !== offers) })).toThrow(
        "eligible tuples missing a final observation",
      );
    });

    it("rejects a part whose PR head is not the second checkout parent", () => {
      expect(() => prepare({ env: { ...env, RENDERED_COPY_CAPTURE_SOURCE_HEAD: sha("e") } })).toThrow(
        "checkout.parents: must be [B, PR head]",
      );
    });

    it("refuses a part built on a merge_group queue checkout, as hosted run 39149420287 did", () => {
      const queueGit = (...args) =>
        args.join(" ") === "show -s --diff-merges=off --format=%P HEAD" ? base : git(...args);
      expect(() =>
        prepare({
          env: { ...env, GITHUB_EVENT_NAME: "merge_group", RENDERED_COPY_CAPTURE_SOURCE_HEAD: checkout },
          git: queueGit,
        }),
      ).toThrow(
        [
          "rendered-copy capture part is invalid:",
          "part.run.event: capture runs on pull_request only",
          `part.checkout.parents: must be [B, PR head] = [${base}, ${checkout}], got ["${base}"]`,
        ].join("\n"),
      );
    });

    it("treats batches without sweep tuples as ineligible, not missing", () => {
      expect(renderedCopyOwningBatch("marketplace_browse,marketplace_checkout")).toBe(false);
      expect(renderedCopyOwningBatch("admin_platform,admin_auth")).toBe(false);
      expect(renderedCopyOwningBatch(batch)).toBe(true);
    });
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
