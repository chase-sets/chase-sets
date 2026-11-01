import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  classifyChanges,
  listChangedFiles,
  resolveChangeScope,
  toGithubOutputMap,
  toOutputMap,
} from "./change-scope.mjs";
import { estimatedE2eSuiteDurationSeconds } from "./e2e-suites.mjs";
import { listWorkspacePackages, repoRoot } from "./lib/repo.mjs";
import { classifyIntegrationRisk, classifyRisk } from "./lib/risk-policy-v1.mjs";
import { renderedCopyTuples } from "../infrastructure/playwright-evidence/rendered-copy.ts";
import { selectVerifyStaticGuardTests } from "./verify-static-scoped.mjs";

it("uses the synthetic merge commit first parent for a PR's own changed files", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "change-scope-pr-merge-"));
  const git = (...args) =>
    execFileSync(
      "git",
      ["-c", "core.autocrlf=false", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", ...args],
      { cwd: directory, encoding: "utf8", windowsHide: true },
    ).trim();
  const write = (filename, content) => writeFileSync(path.join(directory, filename), `${content}\n`, "utf8");

  try {
    git("init", "--quiet", "--initial-branch=main");
    write("base.txt", "base");
    git("add", ".");
    git("commit", "--quiet", "-m", "base");
    const eventBase = git("rev-parse", "HEAD");

    write("main-advance-one.txt", "main one");
    git("add", ".");
    git("commit", "--quiet", "-m", "main advances one");
    write("main-advance-two.txt", "main two");
    git("add", ".");
    git("commit", "--quiet", "-m", "main advances two");

    git("switch", "--create", "pr");
    write("pr-change-one.txt", "PR one");
    write("pr-change-two.txt", "PR two");
    git("add", ".");
    git("commit", "--quiet", "-m", "PR changes");
    git("switch", "main");
    git("merge", "--no-ff", "--quiet", "--no-edit", "pr");
    const syntheticMergeHead = git("rev-parse", "HEAD");

    expect(listChangedFiles(eventBase, syntheticMergeHead, { cwd: directory, firstParent: true })).toEqual([
      "pr-change-one.txt",
      "pr-change-two.txt",
    ]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

it.each([
  [
    "synthetic-parent-lookup-failed",
    {
      firstParent: true,
      exec: () => {
        throw new Error("rev-list unavailable");
      },
    },
  ],
  ["synthetic-parent-lookup-empty", { firstParent: true, exec: () => "" }],
  [
    "merge-base-failed",
    {
      exec: (_command, args) => {
        if (args[0] === "merge-base") throw new Error("merge-base unavailable");
        return "";
      },
    },
  ],
  ["merge-base-empty", { exec: (_command, args) => (args[0] === "merge-base" ? "" : "") }],
  [
    "diff-failed",
    {
      exec: (_command, args) => {
        if (args[0] === "merge-base") return "abc123\n";
        throw new Error("diff unavailable");
      },
    },
  ],
  ["diff-empty", { exec: (_command, args) => (args[0] === "merge-base" ? "abc123\n" : "") }],
])("widens to full scope when %s prevents PR-owned change derivation", (reason, fixture) => {
  const result = resolveChangeScope("base", "head", {
    ...fixture,
    execFileSync: fixture.exec,
    workspaces: [],
    baseDir: process.cwd(),
  });

  expect(result.fallbackReason).toBe(reason);
  expect(result.scope).toMatchObject({
    changedFiles: [],
    localChecksRequired: true,
    unitTestsRequired: true,
    dbTestsRequired: true,
    e2eTestsRequired: true,
    integrationRiskRequired: true,
    buildRequired: true,
    dockerImageRequired: true,
    terraformRequired: true,
    workflowLintRequired: true,
    deployRequired: true,
    clusterPreviewRequired: true,
    composeSmokeRequired: true,
  });
  expect(toOutputMap(result.scope).integration_risk_reason).toContain(reason);
});

it("enables first-parent scope for both hosted PR merge events", () => {
  const workflow = readFileSync(path.join(repoRoot, ".github/workflows/platform-pr.yml"), "utf8");
  expect(workflow).toContain(
    'if [ "${{ github.event_name }}" = "pull_request" ] || [ "${{ github.event_name }}" = "merge_group" ]; then',
  );
  expect(workflow).toContain('first_parent="--first-parent"');
  expect(workflow).toContain('github-output --base="${base}" --head="${head}" $first_parent');
});

async function importChangeScopeVariant(source) {
  const directory = mkdtempSync(path.join(tmpdir(), "change-scope-mutant-"));
  for (const specifier of ["./e2e-suites.mjs", "./lib/repo.mjs", "./lib/risk-policy-v1.mjs"]) {
    const quoted = JSON.stringify(specifier);
    if (!source.includes(quoted)) throw new Error(`Mutant source no longer imports ${specifier}`);
    source = source.replace(quoted, JSON.stringify(pathToFileURL(path.join(repoRoot, "scripts", specifier)).href));
  }
  const file = path.join(directory, "change-scope.mjs");
  writeFileSync(file, source);
  try {
    return await import(`${pathToFileURL(file).href}?mutant=${Date.now()}-${Math.random()}`);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

it("kills a source mutant that removes unavailable-scope widening", async () => {
  const source = readFileSync(path.join(repoRoot, "scripts/change-scope.mjs"), "utf8");
  const mutation = "scope: fullScopeForUnavailableChangeSet(workspaces, reason),";
  const mutatedSource = source.replace(mutation, "scope: classifyChanges({ changedFiles: [], workspaces, baseDir }),");
  expect(mutatedSource).not.toBe(source);
  const mutant = await importChangeScopeVariant(mutatedSource);
  const result = mutant.resolveChangeScope("base", "head", {
    execFileSync: (_command, args) => {
      if (args[0] === "merge-base") return "abc123\n";
      throw new Error("diff unavailable");
    },
    workspaces: [],
    baseDir: process.cwd(),
  });

  expect(result.fallbackReason).toBe("diff-failed");
  expect(result.scope.unitTestsRequired).toBe(false);
  expect(
    resolveChangeScope("base", "head", {
      execFileSync: (_command, args) => {
        if (args[0] === "merge-base") return "abc123\n";
        throw new Error("diff unavailable");
      },
      workspaces: [],
      baseDir: process.cwd(),
    }).scope.unitTestsRequired,
  ).toBe(true);
});

it("kills a source mutant that lets an empty diff narrow the PR scope", async () => {
  const source = readFileSync(path.join(repoRoot, "scripts/change-scope.mjs"), "utf8");
  const mutation = "if (changedFiles.length === 0)";
  const mutatedSource = source.replace(mutation, "if (changedFiles.length < 0)");
  expect(mutatedSource).not.toBe(source);
  const mutant = await importChangeScopeVariant(mutatedSource);
  const emptyDiff = {
    execFileSync: (_command, args) => (args[0] === "merge-base" ? "abc123\n" : ""),
    workspaces: [],
    baseDir: process.cwd(),
  };

  expect(mutant.resolveChangeScope("base", "head", emptyDiff).fallbackReason).toBe(null);
  expect(resolveChangeScope("base", "head", emptyDiff).fallbackReason).toBe("diff-empty");
});

it("keeps fallback notices off json stdout", () => {
  const args = ["scripts/change-scope.mjs", "json", "--base=HEAD", "--head=HEAD"];
  const result = spawnSync(process.execPath, args, { cwd: repoRoot, encoding: "utf8" });

  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout).integrationRiskReason).toContain("diff-empty");
  expect(result.stderr).toContain("Change-scope derivation fallback: diff-empty");
});

it("kills a source mutant that sends the fallback notice to json stdout", () => {
  const source = readFileSync(path.join(repoRoot, "scripts/change-scope.mjs"), "utf8");
  const mutatedSource = source.replace(
    "console.error(`Change-scope derivation fallback:",
    "console.log(`Change-scope derivation fallback:",
  );
  expect(mutatedSource).not.toBe(source);
  const mutantPath = path.join(repoRoot, "scripts", `.change-scope-mutant-${process.pid}-${Date.now()}.mjs`);
  writeFileSync(mutantPath, mutatedSource, "utf8");
  try {
    const result = spawnSync(process.execPath, [mutantPath, "json", "--base=HEAD", "--head=HEAD"], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    expect(result.status).toBe(0);
    expect(() => JSON.parse(result.stdout)).toThrow();
  } finally {
    rmSync(mutantPath, { force: true });
  }
});

describe("rendered-copy real-provider selection corpus", () => {
  it("preserves current-main owning selection for modified, added, deleted and --no-renames paths", async () => {
    const fixture = JSON.parse(readFileSync("scripts/fixtures/ci-e2e-selection.json", "utf8")).renderedCopy;
    const directory = mkdtempSync(path.join(tmpdir(), "rendered-copy-selection-"));
    const git = (args) =>
      execFileSync("git", args, {
        cwd: directory,
        encoding: "utf8",
        timeout: 30_000,
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
    const priorSource = execFileSync("git", ["show", `${fixture.baseSha}:scripts/e2e-suites.mjs`], {
      encoding: "utf8",
      timeout: 30_000,
    }).replace(
      '"./lib/risk-policy-v1.mjs"',
      JSON.stringify(pathToFileURL(path.resolve("scripts/lib/risk-policy-v1.mjs")).href),
    );
    const priorFile = path.join(directory, "prior.mjs");
    writeFileSync(priorFile, priorSource);
    const prior = await import(pathToFileURL(priorFile).href);
    const owners = new Set(renderedCopyTuples.map((tuple) => tuple.suite));
    const write = (filename, content) => {
      const target = path.join(directory, filename);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, content);
    };
    const commit = () => {
      git(["add", "."]);
      git([
        "-c",
        "user.name=Synthetic selection",
        "-c",
        "user.email=synthetic@example.invalid",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "--quiet",
        "-m",
        "Synthetic path operation",
      ]);
      return git(["rev-parse", "HEAD"]);
    };
    const check = (base, head, paths) => {
      const changed = listChangedFiles(base, head, { cwd: directory });
      expect(changed).toEqual([...paths].sort());
      for (const entry of fixture.cases) {
        const relevant = changed.filter((filename) => filename === entry.path);
        if (!relevant.length) continue;
        const old = prior.e2eSuiteIdsForChangedFile(entry.path).some((id) => owners.has(id));
        const scope = classifyChanges({ changedFiles: relevant });
        const selected = JSON.parse(toOutputMap(scope).e2e_suite_batches_json).includes("rendered_copy");
        expect(selected, `${entry.path}: ${entry.reason}`).toBe(entry.selected);
        expect(!old || selected, `never narrower: ${entry.path}`).toBe(true);
        expect(entry.reason.length).toBeGreaterThan(20);
        if (selected !== old) expect(entry.reason).toMatch(/^intentional delta:/);
      }
    };
    try {
      git(["init", "--quiet"]);
      for (const entry of fixture.cases) {
        if (!entry.reason.startsWith("intentional delta: the new"))
          expect(existsSync(entry.path), entry.path).toBe(true);
        write(entry.path, "Synthetic baseline\n");
      }
      let base = commit();
      for (const entry of fixture.cases) write(entry.path, "Synthetic modified\n");
      let head = commit();
      check(
        base,
        head,
        fixture.cases.map((entry) => entry.path),
      );
      base = head;
      for (const entry of fixture.cases) rmSync(path.join(directory, entry.path));
      head = commit();
      check(
        base,
        head,
        fixture.cases.map((entry) => entry.path),
      );
      base = head;
      for (const entry of fixture.cases) write(entry.path, "Synthetic added\n");
      head = commit();
      check(
        base,
        head,
        fixture.cases.map((entry) => entry.path),
      );
      base = head;
      const from = "bounded-contexts/payments/features/payments/api/provider-webhook-paths.ts";
      const to = "infrastructure/stripe-payments/index.ts";
      rmSync(path.join(directory, to));
      base = commit();
      git(["mv", from, to]);
      head = commit();
      check(base, head, [from, to]);
      console.log(
        `RENDERED_COPY_PROVIDER_CORPUS base=${fixture.baseSha} cases=${fixture.cases.length} operations=modified,added,deleted,renamed--no-renames`,
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

const googleMerchantProviderChangeCorpus = [
  {
    operation: "modified",
    changedFiles: ["infrastructure/google-merchant/index.ts"],
    reason: "provider workspace remains selected for a modified adapter path",
  },
  {
    operation: "added",
    changedFiles: ["infrastructure/google-merchant/config.ts"],
    reason: "provider workspace remains selected for an added adapter path",
  },
  {
    operation: "deleted",
    changedFiles: ["infrastructure/google-merchant/auth.ts"],
    reason: "provider workspace remains selected for a deleted adapter path",
  },
  {
    operation: "renamed",
    changedFiles: [
      "deployables/platform-worker/src/google-merchant-client.ts",
      "infrastructure/google-merchant/index.ts",
    ],
    reason: "both sides of the provider move remain in the selected scope",
  },
];

it.each(googleMerchantProviderChangeCorpus)(
  "keeps Google Merchant scope for $operation changes",
  ({ changedFiles, reason }) => {
    const scope = classifyChanges({ changedFiles });
    expect(scope.affectedWorkspaces, reason).toContain("@chase-sets/google-merchant");
    expect(scope.affectedWorkspaces, reason).toContain("@chase-sets/app-platform-worker");
    expect(scope.unitTestsRequired, reason).toBe(true);
    expect(scope.dbTestsRequired, reason).toBe(true);
  },
);

it("does not select the Google Merchant workspace for an infrastructure path lookalike", () => {
  const scope = classifyChanges({ changedFiles: ["infrastructure/google-merchant-notes/index.ts"] });
  expect(scope.affectedWorkspaces).not.toContain("@chase-sets/google-merchant");
});

it.each(["sidecar-only", "renamed-source", "removed-source"])(
  "lost-update selection survives real Git %s changes",
  (kind) => {
    const directory = mkdtempSync(path.join(tmpdir(), "lost-update-selection-"));
    const source = "bounded-contexts/pricing/features/market-estimates/read-model/queries.ts";
    const sidecar = `${source}.lost-update-exceptions.json`;
    const git = (...args) =>
      execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", ...args], {
        cwd: directory,
        encoding: "utf8",
        timeout: 10000,
      });
    try {
      git("init", "--quiet", "--initial-branch=main");
      mkdirSync(path.dirname(path.join(directory, source)), { recursive: true });
      writeFileSync(path.join(directory, source), "const sql = `DELETE FROM rows WHERE id = $1`;\n");
      writeFileSync(path.join(directory, sidecar), "[]\n");
      git("add", ".");
      git("commit", "--quiet", "-m", "seed owner pair");
      const base = git("rev-parse", "HEAD").trim();
      if (kind === "sidecar-only") writeFileSync(path.join(directory, sidecar), "[{}]\n");
      else if (kind === "removed-source") git("rm", source, sidecar);
      else {
        mkdirSync(path.join(directory, "archive"));
        git("mv", source, "archive/queries.ts");
        git("mv", sidecar, "archive/queries.ts.lost-update-exceptions.json");
      }
      git("add", ".");
      git("commit", "--quiet", "-m", kind);
      const changedFiles = listChangedFiles(base, "HEAD", { cwd: directory });
      expect(changedFiles).toContain(sidecar);
      if (kind !== "sidecar-only") expect(changedFiles).toContain(source);
      expect(selectVerifyStaticGuardTests({ changedFiles })).toContain(
        "scripts/check-structure/lost-update-write-guard.test.mjs",
      );
      expect(classifyChanges({ changedFiles }).changedFiles).toContain(sidecar);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

const priorProductionIntegrationRules = [
  {
    reason: "Bounded-context metadata, including event subscriptions, changed",
    patterns: [/^bounded-contexts\/[^/]+\/context\.json$/],
  },
  {
    reason: "Cross-context subscription or runtime composition changed",
    patterns: [
      /^infrastructure\/(?:bounded-context-runtime|platform-runtime)\//,
      /^deployables\/(?:platform-api|platform-worker)\/src\/context-registry\.ts$/,
      /^deployables\/(?:admin-web|marketplace|public-web)\/app\/context-registry\.ts$/,
    ],
  },
  {
    reason: "Shared application shell or router changed",
    patterns: [
      /^deployables\/admin-web\/app\/(?:admin-root-shell|host|routes)\.[cm]?[tj]sx?$/,
      /^deployables\/admin-web\/app\/routes\/[^/]+-layout\.[cm]?[tj]sx?$/,
      /^deployables\/marketplace\/app\/(?:root|routes)\.[cm]?[tj]sx?$/,
      /^deployables\/marketplace\/app\/routes\/layout\.[cm]?[tj]sx?$/,
    ],
  },
  {
    reason: "Design-system navigation changed",
    patterns: [
      /^packages\/design-system\/src\/components\/actions\/(?:navigation|navigation-menu|navigation-header|section-navigation)\.[cm]?[jt]sx?$/,
      /^packages\/design-system\/src\/patterns\/app-shells\/shells\.[cm]?[jt]sx?$/,
      /^packages\/design-system\/src\/theme\/(?:link-adapter|provider)\.[cm]?[jt]sx?$/,
    ],
  },
];

function priorProductionIntegrationReasons(filename) {
  return priorProductionIntegrationRules
    .filter((rule) => rule.patterns.some((pattern) => pattern.test(filename)))
    .map((rule) => rule.reason);
}

const lockedIntegrationParityCorpus = [
  ["modified", "contracts/primitives/typed-ids.ts"],
  ["added", "contracts/http/client.ts"],
  ["removed", "infrastructure/platform-runtime/runtime.ts"],
  ["modified", "infrastructure/platform-runtime/runtime.test.ts"],
  ["added", "infrastructure/platform-runtime/README.md"],
  ["removed", "infrastructure/bounded-context-runtime/compose.test.ts"],
  ["modified", "infrastructure/bounded-context-runtime/docs/composition.md"],
  ["added", "bounded-contexts/pricing/context.json"],
  ["modified", "deployables/platform-worker/src/context-registry.ts"],
  ["modified", "deployables/marketplace/app/context-registry.ts"],
  ["modified", "deployables/admin-web/app/admin-root-shell.tsx"],
  ["modified", "packages/design-system/src/components/actions/navigation-menu.tsx"],
  ["modified", "docs/runbooks/integration-risk.md"],
  ["renamed", "infrastructure/platform-runtime/renamed-runtime.ts", "archive/renamed-runtime.ts"],
  ["renamed", "archive/legacy-runtime.ts", "infrastructure/platform-runtime/legacy-runtime.ts"],
];

const schedulerOwnedArtifacts = [
  "scripts/run-workspaces.mjs",
  "scripts/run-workspaces.test.mjs",
  "scripts/workspace-test-duration-hints-v1.json",
  "scripts/fixtures/workspace-unit-duration-replay-v1.json",
];

// Paths that carry the scheduler's filename vocabulary without being members of
// the frozen set above. They are planted, not real repository files: the point
// is that selection is exact-path set membership, so a near-miss name must
// classify exactly like any other unrelated script.
const schedulerVocabularyLookalikePaths = [
  "scripts/run-workspaces-report.mjs",
  "scripts/lib/run-workspaces-support.mjs",
  "scripts/fixtures/run-workspaces-legacy-v1.json",
  "scripts/workspace-test-duration-hints-v2.json",
  "scripts/fixtures/workspace-unit-duration-replay-v2.json",
];

// Captured offline at the base commit refs/remotes/origin/main
// f78143573af96c636d97696b987a82990df23904 by importing the unmodified
// classifier and calling the exported classifyChanges and toOutputMap directly.
// A scheduler-owned change fans every workspace into the affected set, so this
// is that fan-out's exact membership and order at the base commit. It is
// asserted against the live workspace inventory as well, so adding a workspace
// fails here loudly and this pin is refreshed with it.
// Accepted inventory delta: #7197 adds @chase-sets/order-groups. The captured
// classifier decisions, reasons, and output-key equivalence remain unchanged.
// Accepted dependency delta: #9101 declares platform-runtime's existing Ordering
// type import, adding platform-runtime to the Ordering case's affected set only.
// Accepted dependency delta: #7422 imports the real Payments service contract
// into Auth. Ordering changes now also reach Auth and its downstream consumers.
// Accepted dependency delta: #7274 declares Notifications' owner-builder imports,
// adding Notifications to the Ordering and Pricing cases' affected sets.
// Accepted inventory delta: #9919 adds @chase-sets/tcgplayer-market-observations.
// Accepted inventory delta adds @chase-sets/inventory-draft-listing.
const baseCapturedSchedulerFanoutWorkspaces = [
  "@chase-sets/app-admin-web",
  "@chase-sets/app-marketplace-web",
  "@chase-sets/app-platform-api",
  "@chase-sets/app-platform-worker",
  "@chase-sets/app-public-web",
  "@chase-sets/app-tcgplayer-connector-extension",
  "@chase-sets/app-tcgplayer-operator-extension",
  "@chase-sets/auth",
  "@chase-sets/auth-context",
  "@chase-sets/authenticity",
  "@chase-sets/bounded-context-module",
  "@chase-sets/bounded-context-runtime",
  "@chase-sets/catalog",
  "@chase-sets/catalog-product-line",
  "@chase-sets/catalog-seed",
  "@chase-sets/channels",
  "@chase-sets/checkout",
  "@chase-sets/checkout-order-source",
  "@chase-sets/collections",
  "@chase-sets/commercial-terms",
  "@chase-sets/customer-feedback",
  "@chase-sets/design-system",
  "@chase-sets/discovery",
  "@chase-sets/easypost-postage",
  "@chase-sets/embedded-surface-theme",
  "@chase-sets/event-core",
  "@chase-sets/event-core-postgres",
  "@chase-sets/evidence-window-provider-write",
  "@chase-sets/fulfillment",
  "@chase-sets/google-merchant",
  "@chase-sets/google-shopping-export",
  "@chase-sets/http",
  "@chase-sets/identity",
  "@chase-sets/identity-seed",
  "@chase-sets/inventory",
  "@chase-sets/inventory-draft-listing",
  "@chase-sets/local-email-capture",
  "@chase-sets/localization",
  "@chase-sets/market-estimate-display",
  "@chase-sets/marketplace",
  "@chase-sets/marketplace-seed-testing",
  "@chase-sets/money-movement",
  "@chase-sets/notification-outbox",
  "@chase-sets/notifications",
  "@chase-sets/object-storage",
  "@chase-sets/observability",
  "@chase-sets/order-groups",
  "@chase-sets/ordering",
  "@chase-sets/outbound-messaging",
  "@chase-sets/payment-processing",
  "@chase-sets/payments",
  "@chase-sets/platform-operations",
  "@chase-sets/platform-policy",
  "@chase-sets/platform-runtime",
  "@chase-sets/playwright-evidence",
  "@chase-sets/postage-labels",
  "@chase-sets/pricing",
  "@chase-sets/primitives",
  "@chase-sets/product-measures",
  "@chase-sets/product-selection",
  "@chase-sets/provider-credentials",
  "@chase-sets/provider-webhook-inbox",
  "@chase-sets/public-docs",
  "@chase-sets/public-presence",
  "@chase-sets/realtime",
  "@chase-sets/review-eligibility",
  "@chase-sets/seller-attention-queue",
  "@chase-sets/seller-desk",
  "@chase-sets/ses-email",
  "@chase-sets/settlement",
  "@chase-sets/stripe-appearance",
  "@chase-sets/stripe-config",
  "@chase-sets/stripe-connect",
  "@chase-sets/stripe-payments",
  "@chase-sets/tcgplayer-market-observations",
  "@chase-sets/twilio-messaging",
  "@chase-sets/typescript-compiler-api",
  "@chase-sets/web-notifications",
];

const baseCapturedAllWorkspacesCsv = baseCapturedSchedulerFanoutWorkspaces.join(",");
const baseCapturedAllWorkspacesJson = JSON.stringify(baseCapturedSchedulerFanoutWorkspaces);

// The exact key order `toOutputMap` emits at the base commit. Asserting it per
// corpus case closes the output schema, so a silently added or reordered output
// cannot hide behind a value-only comparison.
const baseCapturedOutputMapKeyOrder = [
  "changed_files_json",
  "affected_workspaces",
  "affected_workspaces_json",
  "directly_affected_workspaces_json",
  "docs_only",
  "local_checks",
  "unit_tests",
  "db_tests",
  "e2e_tests",
  "e2e_suites",
  "e2e_suites_json",
  "e2e_suite_batches_json",
  "integration_risk_required",
  "integration_risk_reason",
  "build",
  "docker_image",
  "terraform",
  "workflow_lint",
  "deploy",
  "cluster_preview",
  "compose_smoke",
  "exposure_posture_changed",
  "exposure_posture_categories",
  "exposure_posture_categories_json",
];

const baseCapturedQuietGateOutputs = {
  e2e_tests: "false",
  e2e_suites: "",
  e2e_suites_json: "[]",
  e2e_suite_batches_json: "[]",
  integration_risk_required: "false",
  integration_risk_reason: "No integration-risk change detected",
  build: "false",
  docker_image: "false",
  terraform: "false",
  workflow_lint: "false",
  deploy: "false",
  cluster_preview: "false",
  compose_smoke: "false",
  exposure_posture_changed: "false",
  exposure_posture_categories: "",
  exposure_posture_categories_json: "[]",
};

function baseCapturedSchedulerFanoutOutputMap(changedFiles) {
  return {
    changed_files_json: JSON.stringify(changedFiles),
    affected_workspaces: baseCapturedAllWorkspacesCsv,
    affected_workspaces_json: baseCapturedAllWorkspacesJson,
    directly_affected_workspaces_json: "[]",
    docs_only: "false",
    local_checks: "true",
    unit_tests: "true",
    db_tests: "false",
    ...baseCapturedQuietGateOutputs,
  };
}

function baseCapturedNoWorkspaceOutputMap(changedFiles, overrides = {}) {
  return {
    changed_files_json: JSON.stringify(changedFiles),
    affected_workspaces: "",
    affected_workspaces_json: "[]",
    directly_affected_workspaces_json: "[]",
    docs_only: "false",
    local_checks: "true",
    unit_tests: "false",
    db_tests: "false",
    ...baseCapturedQuietGateOutputs,
    ...overrides,
  };
}

// The old-versus-new corpus. `baseDbTests` and `baseOutputMap` are the values
// the unmodified classifier produced at the base commit; `expectedDbTests` is
// what the extended predicate must produce. Recording both is what makes the
// set of changed classifications an asserted fact rather than a claim.
const dbTestsOldVersusNewCorpus = [
  {
    name: "scheduler-owned artifact scripts/run-workspaces.mjs",
    changedFiles: ["scripts/run-workspaces.mjs"],
    baseDbTests: "false",
    expectedDbTests: "true",
    changesDbTests: true,
    baseOutputMap: baseCapturedSchedulerFanoutOutputMap(["scripts/run-workspaces.mjs"]),
  },
  {
    name: "scheduler-owned artifact scripts/run-workspaces.test.mjs",
    changedFiles: ["scripts/run-workspaces.test.mjs"],
    baseDbTests: "false",
    expectedDbTests: "true",
    changesDbTests: true,
    baseOutputMap: baseCapturedSchedulerFanoutOutputMap(["scripts/run-workspaces.test.mjs"]),
  },
  {
    name: "scheduler-owned artifact scripts/workspace-test-duration-hints-v1.json",
    changedFiles: ["scripts/workspace-test-duration-hints-v1.json"],
    baseDbTests: "false",
    expectedDbTests: "true",
    changesDbTests: true,
    baseOutputMap: baseCapturedSchedulerFanoutOutputMap(["scripts/workspace-test-duration-hints-v1.json"]),
  },
  {
    name: "scheduler-owned artifact scripts/fixtures/workspace-unit-duration-replay-v1.json",
    changedFiles: ["scripts/fixtures/workspace-unit-duration-replay-v1.json"],
    baseDbTests: "false",
    expectedDbTests: "true",
    changesDbTests: true,
    baseOutputMap: baseCapturedSchedulerFanoutOutputMap(["scripts/fixtures/workspace-unit-duration-replay-v1.json"]),
  },
  {
    name: "documentation-only change",
    changedFiles: ["docs/runbooks/release-process-evolution.md"],
    baseDbTests: "false",
    expectedDbTests: "false",
    changesDbTests: false,
    baseOutputMap: baseCapturedNoWorkspaceOutputMap(["docs/runbooks/release-process-evolution.md"], {
      docs_only: "true",
      exposure_posture_changed: "true",
      exposure_posture_categories: "rollout-policy",
      exposure_posture_categories_json: '["rollout-policy"]',
    }),
  },
  {
    name: "workflow-only change",
    changedFiles: [".github/workflows/platform-pr.yml"],
    baseDbTests: "false",
    expectedDbTests: "true",
    changesDbTests: true,
    baseOutputMap: baseCapturedNoWorkspaceOutputMap([".github/workflows/platform-pr.yml"], {
      workflow_lint: "true",
      cluster_preview: "true",
    }),
  },
  {
    name: "change-scope classifier-only change",
    changedFiles: ["scripts/change-scope.mjs"],
    baseDbTests: "false",
    expectedDbTests: "false",
    changesDbTests: false,
    baseOutputMap: baseCapturedNoWorkspaceOutputMap(["scripts/change-scope.mjs"]),
  },
  {
    name: "this slice's own footprint",
    changedFiles: ["scripts/change-scope.mjs", "scripts/change-scope.test.mjs"],
    baseDbTests: "false",
    expectedDbTests: "false",
    changesDbTests: false,
    baseOutputMap: baseCapturedNoWorkspaceOutputMap(["scripts/change-scope.mjs", "scripts/change-scope.test.mjs"]),
  },
  {
    name: "db-test-preflight-only change",
    changedFiles: ["scripts/db-test-preflight.mjs"],
    baseDbTests: "false",
    expectedDbTests: "false",
    changesDbTests: false,
    baseOutputMap: baseCapturedNoWorkspaceOutputMap(["scripts/db-test-preflight.mjs"]),
  },
  {
    name: "unrelated bounded-context change",
    changedFiles: ["bounded-contexts/ordering/features/tax-quotes/domain/tax-quote.ts"],
    baseDbTests: "true",
    expectedDbTests: "true",
    changesDbTests: false,
    baseOutputMap: {
      changed_files_json: '["bounded-contexts/ordering/features/tax-quotes/domain/tax-quote.ts"]',
      affected_workspaces:
        "@chase-sets/app-admin-web,@chase-sets/app-marketplace-web,@chase-sets/app-platform-api,@chase-sets/app-platform-worker,@chase-sets/app-public-web,@chase-sets/app-tcgplayer-connector-extension,@chase-sets/auth,@chase-sets/channels,@chase-sets/checkout,@chase-sets/discovery,@chase-sets/marketplace-seed-testing,@chase-sets/notifications,@chase-sets/ordering,@chase-sets/payments,@chase-sets/platform-runtime,@chase-sets/pricing,@chase-sets/settlement",
      affected_workspaces_json:
        '["@chase-sets/app-admin-web","@chase-sets/app-marketplace-web","@chase-sets/app-platform-api","@chase-sets/app-platform-worker","@chase-sets/app-public-web","@chase-sets/app-tcgplayer-connector-extension","@chase-sets/auth","@chase-sets/channels","@chase-sets/checkout","@chase-sets/discovery","@chase-sets/marketplace-seed-testing","@chase-sets/notifications","@chase-sets/ordering","@chase-sets/payments","@chase-sets/platform-runtime","@chase-sets/pricing","@chase-sets/settlement"]',
      directly_affected_workspaces_json: '["@chase-sets/ordering"]',
      docs_only: "false",
      local_checks: "true",
      unit_tests: "true",
      db_tests: "true",
      ...baseCapturedQuietGateOutputs,
      build: "true",
      docker_image: "true",
      deploy: "true",
      compose_smoke: "true",
      exposure_posture_changed: "true",
      exposure_posture_categories: "live-money-provider,tax-posture",
      exposure_posture_categories_json: '["live-money-provider","tax-posture"]',
    },
  },
  {
    name: "root shared vitest config change",
    changedFiles: ["vitest.shared.mjs"],
    baseDbTests: "true",
    expectedDbTests: "true",
    changesDbTests: false,
    baseOutputMap: {
      ...baseCapturedSchedulerFanoutOutputMap(["vitest.shared.mjs"]),
      directly_affected_workspaces_json: baseCapturedAllWorkspacesJson,
      db_tests: "true",
    },
  },
  {
    name: "DB-capable deployable script change",
    changedFiles: ["deployables/platform-api/scripts/check-bootstrap-db-enrollment.mjs"],
    baseDbTests: "true",
    expectedDbTests: "true",
    changesDbTests: false,
    baseOutputMap: {
      changed_files_json: '["deployables/platform-api/scripts/check-bootstrap-db-enrollment.mjs"]',
      affected_workspaces: "@chase-sets/app-platform-api",
      affected_workspaces_json: '["@chase-sets/app-platform-api"]',
      directly_affected_workspaces_json: '["@chase-sets/app-platform-api"]',
      docs_only: "false",
      local_checks: "true",
      unit_tests: "true",
      db_tests: "true",
      ...baseCapturedQuietGateOutputs,
      e2e_tests: "true",
      e2e_suites:
        "marketplace_browse,marketplace_account,marketplace_checkout,marketplace_seller,catalog_admin_integrations,catalog_admin_modeling,admin_growth,admin_commerce,admin_support,admin_platform,admin_auth,admin_access",
      e2e_suites_json:
        '["marketplace_browse","marketplace_account","marketplace_checkout","marketplace_seller","catalog_admin_integrations","catalog_admin_modeling","admin_growth","admin_commerce","admin_support","admin_platform","admin_auth","admin_access"]',
      e2e_suite_batches_json:
        '["catalog_admin_integrations,admin_auth","catalog_admin_modeling,admin_platform","marketplace_checkout,admin_support","marketplace_browse,marketplace_account","admin_commerce,admin_access","marketplace_seller,admin_growth"]',
      build: "true",
      docker_image: "true",
      deploy: "true",
      compose_smoke: "true",
    },
  },
  {
    name: "empty changed-file list",
    changedFiles: [],
    baseDbTests: "false",
    expectedDbTests: "false",
    changesDbTests: false,
    baseOutputMap: baseCapturedNoWorkspaceOutputMap([], { local_checks: "false" }),
  },
];

const dbTestsOldVersusNewCorpusCaseNames = [
  "scheduler-owned artifact scripts/run-workspaces.mjs",
  "scheduler-owned artifact scripts/run-workspaces.test.mjs",
  "scheduler-owned artifact scripts/workspace-test-duration-hints-v1.json",
  "scheduler-owned artifact scripts/fixtures/workspace-unit-duration-replay-v1.json",
  "documentation-only change",
  "workflow-only change",
  "change-scope classifier-only change",
  "this slice's own footprint",
  "db-test-preflight-only change",
  "unrelated bounded-context change",
  "root shared vitest config change",
  "DB-capable deployable script change",
  "empty changed-file list",
];

const dbTestsCorpusCaseKeys = [
  "name",
  "changedFiles",
  "baseDbTests",
  "expectedDbTests",
  "changesDbTests",
  "baseOutputMap",
];

// The changed-file set the dependent slice is predicted to touch, with the
// output map the unmodified classifier produced for it at the base commit.
const dependentSliceBaseCapture = {
  changedFiles: [
    "scripts/run-workspaces.mjs",
    "scripts/run-workspaces.test.mjs",
    "scripts/db-test-preflight.mjs",
    "scripts/db-test-preflight.test.mjs",
    ".github/workflows/platform-pr.yml",
  ],
  baseDbTests: "false",
  expectedDbTests: "true",
  baseOutputMap: {
    ...baseCapturedSchedulerFanoutOutputMap([
      ".github/workflows/platform-pr.yml",
      "scripts/db-test-preflight.mjs",
      "scripts/db-test-preflight.test.mjs",
      "scripts/run-workspaces.mjs",
      "scripts/run-workspaces.test.mjs",
    ]),
    workflow_lint: "true",
    cluster_preview: "true",
  },
};

const hostedDbAdmissionStatusForms = ["added", "modified", "removed", "renamed"];

const hostedDbAdmissionCorpusSeeds = [
  {
    name: "DB-only scheduler path",
    changedFiles: ["scripts/run-workspaces.mjs"],
    eventName: "pull_request",
    expected: { db: true, e2e: false, integrationRisk: false, clusterPreview: false },
    expectedAffectedWorkspaces: baseCapturedSchedulerFanoutWorkspaces,
    deltaReason: "DB-required footprint executes on the PR fast lane independently of the shared targeted lane",
  },
  {
    name: "non-DB issue-readiness path",
    changedFiles: ["scripts/issue-readiness.mjs"],
    eventName: "pull_request",
    expected: { db: false, e2e: false, integrationRisk: false, clusterPreview: false },
    expectedAffectedWorkspaces: [],
    deltaReason: null,
  },
  {
    name: "integration-risk context metadata path",
    changedFiles: ["bounded-contexts/pricing/context.json"],
    eventName: "pull_request",
    expected: { db: true, e2e: false, integrationRisk: true, clusterPreview: false },
    expectedAffectedWorkspaces: [
      "@chase-sets/app-admin-web",
      "@chase-sets/app-marketplace-web",
      "@chase-sets/app-platform-api",
      "@chase-sets/app-platform-worker",
      "@chase-sets/app-public-web",
      "@chase-sets/discovery",
      "@chase-sets/marketplace-seed-testing",
      "@chase-sets/notifications",
      "@chase-sets/platform-runtime",
      "@chase-sets/pricing",
    ],
    deltaReason: null,
  },
  {
    name: "merge-group full-battery control",
    changedFiles: ["scripts/issue-readiness.mjs"],
    eventName: "merge_group",
    expected: { db: false, e2e: false, integrationRisk: false, clusterPreview: false },
    expectedAffectedWorkspaces: [],
    deltaReason: null,
  },
  {
    name: "DB-and-E2E overlap",
    changedFiles: ["bounded-contexts/catalog/routes/admin/integrations.tsx"],
    eventName: "pull_request",
    expected: { db: true, e2e: true, integrationRisk: false, clusterPreview: false },
    expectedAffectedWorkspaces: [
      "@chase-sets/app-admin-web",
      "@chase-sets/app-platform-api",
      "@chase-sets/app-platform-worker",
      "@chase-sets/app-tcgplayer-operator-extension",
      "@chase-sets/catalog",
      "@chase-sets/discovery",
      "@chase-sets/inventory",
      "@chase-sets/marketplace-seed-testing",
      "@chase-sets/pricing",
    ],
    deltaReason: "DB-required footprint executes on the PR fast lane independently of the shared targeted lane",
  },
  {
    name: "DB-and-preview overlap",
    changedFiles: ["scripts/run-workspaces.mjs", "infrastructure/helm/platform/values.yaml"],
    eventName: "pull_request",
    expected: { db: true, e2e: false, integrationRisk: false, clusterPreview: true },
    expectedAffectedWorkspaces: baseCapturedSchedulerFanoutWorkspaces,
    deltaReason: "DB-required footprint executes on the PR fast lane independently of the shared targeted lane",
  },
  {
    name: "sibling seeding entry surface",
    siblingKind: "seeding",
    changedFiles: ["bounded-contexts/catalog/features/source-observations/api/seed.ts"],
    eventName: "pull_request",
    expected: { db: true, e2e: true, integrationRisk: false, clusterPreview: false },
    deltaReason: "DB-required footprint executes on the PR fast lane independently of the shared targeted lane",
  },
  {
    name: "sibling bootstrap entry surface",
    siblingKind: "bootstrap",
    changedFiles: ["deployables/platform-api/src/bootstrap.ts"],
    eventName: "pull_request",
    expected: { db: true, e2e: true, integrationRisk: false, clusterPreview: false },
    deltaReason: "DB-required footprint executes on the PR fast lane independently of the shared targeted lane",
  },
  {
    name: "sibling import entry surface",
    siblingKind: "import",
    changedFiles: [
      "bounded-contexts/catalog/features/source-observations/api/source-observation-provider-import-runtime.ts",
    ],
    eventName: "pull_request",
    expected: { db: true, e2e: true, integrationRisk: false, clusterPreview: false },
    deltaReason: "DB-required footprint executes on the PR fast lane independently of the shared targeted lane",
  },
  {
    name: "sibling reconciliation entry surface",
    siblingKind: "reconciliation",
    changedFiles: [
      "bounded-contexts/settlement/features/liability-reconciliation/read-model/liability-reconciliation.ts",
    ],
    eventName: "pull_request",
    expected: { db: true, e2e: false, integrationRisk: false, clusterPreview: false },
    deltaReason: "DB-required footprint executes on the PR fast lane independently of the shared targeted lane",
  },
];

const hostedDbAdmissionCorpus = hostedDbAdmissionCorpusSeeds.flatMap((seed) =>
  hostedDbAdmissionStatusForms.map((status) => ({ ...seed, status })),
);

const hostedDbConsumerInventory = [
  { name: "platform-pr/db-tests condition", changesAdmission: true },
  { name: "platform-pr/e2e-tests condition", changesAdmission: false },
  { name: "platform-pr/PR Required DB aggregation", changesAdmission: true },
  { name: "platform-pr/PR Required E2E aggregation", changesAdmission: false },
  { name: "platform-pr/preview-deploy-smoke admission", changesAdmission: true },
  { name: "scripts/release-deployment-scope.mjs", changesAdmission: false },
  { name: "scripts/release-qualification-scope.mjs", changesAdmission: false },
  { name: "scripts/verify-static-scoped.mjs", changesAdmission: false },
  { name: "scripts/verify-static-scoped.test.mjs", changesAdmission: false },
  { name: "scripts/public-web-route-smoke-workflows.test.mjs", changesAdmission: false },
  { name: "scripts/change-scope.test.mjs", changesAdmission: false },
  { name: "scripts/lib/risk-policy-v1.test.mjs", changesAdmission: false },
  { name: "scripts/digitalocean-platform-config.test.mjs", changesAdmission: false },
];

function hostedLaneFor({ eventName, integrationRiskRequired }) {
  const fullBatteryRequired = eventName === "merge_group";
  return {
    fullBatteryRequired,
    targetedHeavyRequired: fullBatteryRequired || integrationRiskRequired,
  };
}

function statusAwareRiskFiles({ changedFiles, status }) {
  return changedFiles.map((filename) =>
    status === "renamed" ? { filename, previousFilename: filename, status } : { filename, status },
  );
}

function priorHostedAdmission(scope, lane) {
  // Historical DB admission, with today's scope-gated E2E policy.
  return {
    dbJobExecutes: lane.targetedHeavyRequired && scope.dbTestsRequired,
    dbRequiredByName: lane.targetedHeavyRequired && scope.dbTestsRequired,
    e2eJobExecutes: scope.e2eTestsRequired,
    e2eRequiredByName: scope.e2eTestsRequired,
    affectedWorkspaces: scope.affectedWorkspaces,
  };
}

function isolatedHostedDbAdmission(scope) {
  return {
    dbJobExecutes: scope.dbTestsRequired,
    dbRequiredByName: scope.dbTestsRequired,
    e2eJobExecutes: scope.e2eTestsRequired,
    e2eRequiredByName: scope.e2eTestsRequired,
    affectedWorkspaces: scope.affectedWorkspaces,
  };
}

function workspaceWithScripts(baseDir, root, dirName, name, scripts) {
  return {
    name,
    dir: path.join(baseDir, root, dirName),
    dirName,
    root,
    packageJson: { name, dependencies: {}, scripts },
  };
}

function workspace(baseDir, root, dirName, name, dependencies = {}, chaseSets) {
  return {
    name,
    dir: path.join(baseDir, root, dirName),
    dirName,
    root,
    packageJson: {
      name,
      dependencies,
      chaseSets,
    },
  };
}

// The classifier before #9670 enrolled Public Presence for every nonempty
// diff, imported verbatim from git so each old-versus-new delta is measured
// against the real base rather than a hand-written oracle.
const PUBLIC_PRESENCE_ENROLLMENT_BASE_SHA = "a4105366989c3e1afa4a46f5f64d4ddb1e300a93";
const baseChangeScope = await (async () => {
  let source = execFileSync("git", ["show", `${PUBLIC_PRESENCE_ENROLLMENT_BASE_SHA}:scripts/change-scope.mjs`], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  for (const specifier of ["./e2e-suites.mjs", "./lib/repo.mjs", "./lib/risk-policy-v1.mjs"]) {
    const quoted = JSON.stringify(specifier);
    if (!source.includes(quoted)) throw new Error(`Base classifier no longer imports ${specifier}`);
    source = source.replace(quoted, JSON.stringify(pathToFileURL(path.join(repoRoot, "scripts", specifier)).href));
  }
  const directory = mkdtempSync(path.join(tmpdir(), "change-scope-base-"));
  try {
    const file = path.join(directory, "change-scope.mjs");
    writeFileSync(file, source);
    return await import(pathToFileURL(file).href);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
})();

const publicPresenceWorkspaceName = "@chase-sets/public-presence";

// AC1's historical, cited and unrelated real paths: each omitted Public
// Presence at the base commit while its own owners required Unit Tests.
const publicPresenceReaderInputs = [
  "bounded-contexts/identity/api.ts",
  "bounded-contexts/pricing/features/repricing-engine/api/runtime.ts",
  "bounded-contexts/identity/GLOSSARY.md",
  "bounded-contexts/authenticity/README.md",
  "bounded-contexts/marketplace/features/listings/api/runtime.test.ts",
  "scripts/clean-logs.mjs",
  "README.md",
  "docs/runbooks/release-process-evolution.md",
];

const publicPresenceCitationFenceInputs = [
  "bounded-contexts/public-presence/features/policies/domain/authenticity-service-terms.ts",
  "bounded-contexts/public-presence/features/policies/domain/privacy-policy.ts",
  "bounded-contexts/public-presence/features/policies/domain/authenticity-service-terms.test.ts",
  "scripts/verify-static-surfaces.mjs",
];

function publicPresenceOccurrences(names) {
  return names.filter((name) => name === publicPresenceWorkspaceName).length;
}

function withPublicPresenceAffected(names) {
  const affected = new Set([...names, publicPresenceWorkspaceName]);
  return listWorkspacePackages({ repoRoot })
    .map(({ name }) => name)
    .filter((name) => affected.has(name));
}

// Applies #9670's only permitted delta to an output map captured before it:
// Public Presence joins the affected and direct lists once and the unit gate
// turns on. An empty diff, and an empty list that requires DB tests (the
// all-DB sweep), keep their captured outputs.
function withRenderedCopyOutput(output) {
  const batches = JSON.parse(output.e2e_suite_batches_json);
  const owners = new Set(renderedCopyTuples.map((tuple) => tuple.suite));
  return {
    ...output,
    e2e_suite_batches_json: JSON.stringify([
      ...batches,
      ...(batches.some((batch) => batch.split(",").some((id) => owners.has(id))) ? ["rendered_copy"] : []),
    ]),
  };
}

function withPublicPresenceEnrollmentOutputs(baseOutputMap) {
  baseOutputMap = withRenderedCopyOutput(baseOutputMap);
  const affected = JSON.parse(baseOutputMap.affected_workspaces_json);
  if (
    JSON.parse(baseOutputMap.changed_files_json).length === 0 ||
    (baseOutputMap.db_tests === "true" && affected.length === 0)
  ) {
    return baseOutputMap;
  }
  const nextAffected = withPublicPresenceAffected(affected);
  const direct = JSON.parse(baseOutputMap.directly_affected_workspaces_json);
  return {
    ...baseOutputMap,
    affected_workspaces: nextAffected.join(","),
    affected_workspaces_json: JSON.stringify(nextAffected),
    directly_affected_workspaces_json: JSON.stringify(
      direct.includes(publicPresenceWorkspaceName) ? direct : [...direct, publicPresenceWorkspaceName].sort(),
    ),
    unit_tests: "true",
  };
}

// The one delta #9670 permits: Public Presence joins the test-only, direct and
// affected sets exactly once, plus the unit gate a nonempty affected set
// implies. An empty diff stays unchanged, and so does an empty affected set
// that requires DB tests, because an empty list is how both DB-profile
// runners sweep every DB workspace.
function expectedPublicPresenceEnrollment(base, workspaces) {
  if (base.changedFiles.length === 0 || (base.dbTestsRequired && base.affectedWorkspaces.length === 0)) {
    return base;
  }
  const withPublicPresence = (names) => [...new Set([...names, publicPresenceWorkspaceName])];
  const affected = new Set(withPublicPresence(base.affectedWorkspaces));
  return {
    ...base,
    affectedWorkspaces: workspaces.map(({ name }) => name).filter((name) => affected.has(name)),
    directlyAffectedWorkspaces: withPublicPresence(base.directlyAffectedWorkspaces).sort(),
    directlyTestOnlyAffectedWorkspaces: withPublicPresence(base.directlyTestOnlyAffectedWorkspaces).sort(),
    unitTestsRequired: true,
  };
}

function expectOnlyPublicPresenceEnrollmentDelta(changedFiles) {
  const workspaces = listWorkspacePackages({ repoRoot });
  const base = baseChangeScope.classifyChanges({ changedFiles, workspaces, baseDir: repoRoot });
  const head = classifyChanges({ changedFiles, workspaces, baseDir: repoRoot });
  const expected = expectedPublicPresenceEnrollment(base, workspaces);
  const label = JSON.stringify(changedFiles);
  expect(head, label).toEqual(expected);
  expect(toGithubOutputMap(head), label).toEqual(withRenderedCopyOutput(baseChangeScope.toGithubOutputMap(expected)));
  return { base, head };
}

const publicPresenceEnrollmentCorpus = [
  ...dbTestsOldVersusNewCorpus.map(({ name, changedFiles }) => ({ name, changedFiles })),
  ...hostedDbAdmissionCorpusSeeds
    .filter(({ eventName }) => eventName === "pull_request")
    .map(({ name, changedFiles }) => ({ name: `hosted DB admission: ${name}`, changedFiles })),
  ...lockedIntegrationParityCorpus.map(([status, ...paths]) => ({
    name: `integration parity ${status} ${paths.join(" -> ")}`,
    changedFiles: paths,
  })),
  ...schedulerVocabularyLookalikePaths.map((file) => ({ name: `scheduler lookalike ${file}`, changedFiles: [file] })),
  ...publicPresenceReaderInputs.map((file) => ({ name: `reader input ${file}`, changedFiles: [file] })),
  ...publicPresenceCitationFenceInputs.map((file) => ({ name: `citation fence ${file}`, changedFiles: [file] })),
  { name: "real Stripe payments provider", changedFiles: ["infrastructure/stripe-payments/index.ts"] },
  { name: "real provider webhook inbox", changedFiles: ["infrastructure/provider-webhook-inbox/index.ts"] },
  { name: "real provider credentials contract", changedFiles: ["contracts/provider-credentials/index.ts"] },
  { name: "mixed Identity runtime and docs", changedFiles: ["bounded-contexts/identity/api.ts", "README.md"] },
  {
    name: "mixed Public Presence owner runtime and unrelated script",
    changedFiles: [
      "bounded-contexts/public-presence/features/policies/domain/privacy-policy.ts",
      "scripts/clean-logs.mjs",
    ],
  },
  {
    name: "platform-pr workflow with cited Identity glossary",
    changedFiles: [".github/workflows/platform-pr.yml", "bounded-contexts/identity/GLOSSARY.md"],
  },
  {
    name: "platform-pr workflow with docs and script",
    changedFiles: [".github/workflows/platform-pr.yml", "README.md"],
  },
  { name: "blank normalized path", changedFiles: ["", "./"] },
];

function batchDurationSeconds(batch) {
  return batch
    .split(",")
    .filter(Boolean)
    .reduce((total, suiteId) => total + estimatedE2eSuiteDurationSeconds(suiteId), 0);
}

describe("change-scope", () => {
  it("enrolls the Inventory recovery browser spec in the hosted seller suite", () => {
    const scope = classifyChanges({ changedFiles: ["deployables/marketplace/e2e/inventory-recovery.spec.ts"] });
    expect(scope.e2eTestsRequired).toBe(true);
    expect(scope.e2eSuiteIds).toEqual(["marketplace_seller"]);
  });
  it("selects the Chromium authority caller for package and connector-client changes", () => {
    const baseDir = path.join(process.cwd(), "repo");
    const extension = workspaceWithScripts(
      baseDir,
      "deployables",
      "tcgplayer-connector-extension",
      "@chase-sets/app-tcgplayer-connector-extension",
      { test: "test", "test:chromium": "test:chromium" },
    );
    for (const changedFile of [
      "deployables/tcgplayer-connector-extension/src/background.ts",
      "bounded-contexts/channels/features/connector-client/domain/identity.ts",
    ]) {
      const scope = classifyChanges({
        baseDir,
        changedFiles: [changedFile],
        workspaces: [extension, workspace(baseDir, "bounded-contexts", "channels", "@chase-sets/channels")],
      });
      expect(scope.e2eSuiteIds, changedFile).toEqual(["tcgplayer_connector_extension"]);
      expect(scope.e2eTestsRequired, changedFile).toBe(true);
    }
  });

  it.each(publicPresenceCitationFenceInputs)("selects public-presence for citation fence input %s", (file) => {
    const scope = classifyChanges({ changedFiles: [file] });
    expect(publicPresenceOccurrences(scope.affectedWorkspaces)).toBe(1);
    expect(scope.unitTestsRequired).toBe(true);
  });

  it.each(publicPresenceReaderInputs)("enrolls public-presence exactly once, test-only, for %s", (file) => {
    const scope = classifyChanges({ changedFiles: [file] });
    const output = toOutputMap(scope);
    expect(publicPresenceOccurrences(scope.affectedWorkspaces)).toBe(1);
    expect(publicPresenceOccurrences(output.affected_workspaces.split(","))).toBe(1);
    expect(publicPresenceOccurrences(JSON.parse(output.affected_workspaces_json))).toBe(1);
    expect(scope.directlyTestOnlyAffectedWorkspaces).toContain(publicPresenceWorkspaceName);
    expect(scope.runtimeAffectedWorkspaces).not.toContain(publicPresenceWorkspaceName);
    expect(scope.unitTestsRequired).toBe(true);
    expect(output.unit_tests).toBe("true");
  });

  it.each(publicPresenceEnrollmentCorpus)(
    "changes only Public Presence enrollment against the base for $name",
    ({ changedFiles }) => {
      expectOnlyPublicPresenceEnrollmentDelta(changedFiles);
    },
  );

  it("exercises enrolled, already-selected, empty and DB-sweep inputs in the enrollment corpus", () => {
    const outcomes = publicPresenceEnrollmentCorpus.map(({ changedFiles }) => {
      const { base, head } = expectOnlyPublicPresenceEnrollmentDelta(changedFiles);
      if (head.changedFiles.length === 0) return "empty";
      if (publicPresenceOccurrences(head.affectedWorkspaces) === 0) return "db-sweep";
      return publicPresenceOccurrences(base.affectedWorkspaces) === 0 ? "newly-enrolled" : "already-selected";
    });
    expect(new Set(outcomes)).toEqual(new Set(["empty", "db-sweep", "newly-enrolled", "already-selected"]));
  });

  it("enrolls public-presence for modified, added, deleted and both renamed paths from listChangedFiles", () => {
    const temporary = mkdtempSync(path.join(tmpdir(), "change-scope-public-presence-"));
    const git = (args) =>
      execFileSync("git", args, { cwd: temporary, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    const paths = [
      "bounded-contexts/identity/api.ts",
      "bounded-contexts/pricing/features/repricing-engine/api/runtime.ts",
      "bounded-contexts/identity/GLOSSARY.md",
      "scripts/clean-logs.mjs",
    ];
    const writePaths = (content) => {
      for (const file of paths) {
        mkdirSync(path.dirname(path.join(temporary, file)), { recursive: true });
        writeFileSync(path.join(temporary, file), content);
      }
    };
    const commit = () => {
      git(["add", "--all"]);
      git([
        "-c",
        "user.name=Change scope fixture",
        "-c",
        "user.email=change-scope@example.invalid",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "--quiet",
        "-m",
        "Synthetic path operation",
      ]);
      return git(["rev-parse", "HEAD"]);
    };
    const check = (base, head, expectedPaths) => {
      const changedFiles = listChangedFiles(base, head, { cwd: temporary });
      expect(changedFiles).toEqual([...expectedPaths].sort());
      for (const files of [changedFiles, ...changedFiles.map((file) => [file])]) {
        const scope = expectOnlyPublicPresenceEnrollmentDelta(files).head;
        expect(publicPresenceOccurrences(scope.affectedWorkspaces), JSON.stringify(files)).toBe(1);
      }
    };
    try {
      git(["init", "--quiet"]);
      writePaths("Synthetic fixture baseline\n");
      let base = commit();
      writePaths("Synthetic fixture modified\n");
      let head = commit();
      check(base, head, paths);
      base = head;
      for (const file of paths) rmSync(path.join(temporary, file));
      head = commit();
      check(base, head, paths);
      base = head;
      writePaths("Synthetic fixture added\n");
      head = commit();
      check(base, head, paths);
      base = head;
      mkdirSync(path.join(temporary, "archive"), { recursive: true });
      git(["mv", "bounded-contexts/identity/api.ts", "archive/identity-api.ts"]);
      head = commit();
      check(base, head, ["archive/identity-api.ts", "bounded-contexts/identity/api.ts"]);
      base = head;
      const renamedIn = "bounded-contexts/pricing/features/repricing-engine/api/runtime-relocated.ts";
      git(["mv", "archive/identity-api.ts", renamedIn]);
      head = commit();
      check(base, head, ["archive/identity-api.ts", renamedIn]);
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  });

  it("adds no phantom package for an empty diff or an inventory without public-presence", () => {
    for (const changedFiles of [[], [""], ["./"]]) {
      const scope = classifyChanges({ changedFiles });
      expect(scope.changedFiles).toEqual([]);
      expect(scope.affectedWorkspaces).toEqual([]);
      expect(scope.directlyAffectedWorkspaces).toEqual([]);
      expect(scope.unitTestsRequired).toBe(false);
    }
    const baseDir = path.join(process.cwd(), "repo");
    const changedFiles = ["README.md", "scripts/clean-logs.mjs", "bounded-contexts/identity/api.ts"];
    for (const [workspaces, expectedAffected] of [
      [[], []],
      [[workspace(baseDir, "bounded-contexts", "identity", "@test/identity")], ["@test/identity"]],
      // Discovery is the bounded-contexts/public-presence directory, not a name.
      [[workspace(baseDir, "packages", "public-presence", "@test/public-presence")], []],
    ]) {
      const scope = classifyChanges({ baseDir, changedFiles, workspaces });
      expect(scope.affectedWorkspaces).toEqual(expectedAffected);
      expect(scope.directlyTestOnlyAffectedWorkspaces).toEqual([]);
      expect(scope.unitTestsRequired).toBe(expectedAffected.length > 0);
    }
  });

  it("enrolls a discovered public-presence workspace without runtime, build, deploy or DB capability", () => {
    const baseDir = path.join(process.cwd(), "repo");
    const dependent = workspace(baseDir, "deployables", "public-web", "@test/public-web", {
      "@test/public-presence": "workspace:*",
    });
    for (const scripts of [
      { test: "vitest run" },
      { "test:db": "vitest run" },
      { test: "vitest", "test:db": "a.md" },
    ]) {
      const publicPresence = workspaceWithScripts(
        baseDir,
        "bounded-contexts",
        "public-presence",
        "@test/public-presence",
        scripts,
      );
      const scope = classifyChanges({ baseDir, changedFiles: ["a.md"], workspaces: [publicPresence, dependent] });
      expect(scope.affectedWorkspaces).toEqual(["@test/public-presence"]);
      expect(scope.directlyTestOnlyAffectedWorkspaces).toEqual(["@test/public-presence"]);
      expect(scope.runtimeAffectedWorkspaces).toEqual([]);
      expect(scope.docsOnly).toBe(true);
      expect(scope.unitTestsRequired).toBe(true);
      expect(scope.dbTestsRequired).toBe(false);
      expect(scope.buildRequired).toBe(false);
      expect(scope.dockerImageRequired).toBe(false);
      expect(scope.deployRequired).toBe(false);
    }
  });

  it("keeps the platform-pr all-DB sweep unnarrowed, including where the static-surfaces branch narrowed it", () => {
    for (const changedFiles of [
      [".github/workflows/platform-pr.yml"],
      [".github/workflows/platform-pr.yml", "README.md", "scripts/clean-logs.mjs"],
    ]) {
      const scope = classifyChanges({ changedFiles });
      expect(scope.dbTestsRequired).toBe(true);
      expect(scope.affectedWorkspaces).toEqual([]);
      expect(scope.unitTestsRequired).toBe(false);
    }
    // Explicit delta: the removed exact-path branch enrolled Public Presence
    // before DB selection, narrowing this sweep to a workspace without DB tests.
    const changedFiles = [".github/workflows/platform-pr.yml", "scripts/verify-static-surfaces.mjs"];
    const workspaces = listWorkspacePackages({ repoRoot });
    const base = baseChangeScope.classifyChanges({ changedFiles, workspaces, baseDir: repoRoot });
    const head = classifyChanges({ changedFiles, workspaces, baseDir: repoRoot });
    expect(base.affectedWorkspaces).toEqual([publicPresenceWorkspaceName]);
    expect(base.dbTestsRequired).toBe(true);
    expect(head).toEqual({
      ...base,
      affectedWorkspaces: [],
      directlyAffectedWorkspaces: [],
      directlyTestOnlyAffectedWorkspaces: [],
      unitTestsRequired: false,
    });
  });

  it("exposes the exact classifier result for the shared CI gate plan", () => {
    const scope = classifyChanges({ changedFiles: ["README.md"] });
    const output = toGithubOutputMap(scope);

    expect(JSON.parse(output.scope_json)).toEqual(scope);
    expect(Object.keys(output)).toEqual([...baseCapturedOutputMapKeyOrder, "scope_json"]);
  });

  it.each([
    "docker-compose.dev.yml",
    "scripts/lib/sandbox.mjs",
    "scripts/dev-system.mjs",
    "scripts/dev-system-config.mjs",
  ])("selects hosted browser coverage for shared sandbox runtime %s", (file) => {
    const scope = classifyChanges({ changedFiles: [file], workspaces: [] });
    const output = toOutputMap(scope);
    expect(scope.e2eTestsRequired).toBe(true);
    expect(scope.e2eSuiteIds).toEqual(expect.arrayContaining(["marketplace_account", "marketplace_seller"]));
    const covered = JSON.parse(output.e2e_suite_batches_json).flatMap((batch) => batch.split(","));
    expect(covered).toEqual(expect.arrayContaining(["marketplace_account", "marketplace_seller"]));
  });

  it("diffs changed files from the merge-base instead of the moving base branch tip", () => {
    const calls = [];
    const changedFiles = listChangedFiles("origin/main", "HEAD", {
      cwd: "/repo",
      execFileSync: (_command, args, options) => {
        calls.push({ args, cwd: options.cwd });
        if (args[0] === "merge-base") {
          return "abc123\n";
        }
        if (args[0] === "diff") {
          return "bounded-contexts/catalog/domain.ts\n";
        }
        throw new Error(`Unexpected git call: ${args.join(" ")}`);
      },
    });

    expect(changedFiles).toEqual(["bounded-contexts/catalog/domain.ts"]);
    expect(calls).toEqual([
      { args: ["merge-base", "origin/main", "HEAD"], cwd: "/repo" },
      { args: ["diff", "--no-renames", "--name-only", "abc123...HEAD"], cwd: "/repo" },
    ]);
  });

  it("treats documentation-only changes as non-deployable", () => {
    const baseDir = path.join(process.cwd(), "repo");
    const scope = classifyChanges({
      baseDir,
      changedFiles: ["docs/runbooks/digitalocean-platform-deployment.md", "README.md"],
      workspaces: [workspace(baseDir, "deployables", "public-web", "@test/public-web")],
    });

    expect(scope.docsOnly).toBe(true);
    expect(scope.localChecksRequired).toBe(true);
    expect(scope.deployRequired).toBe(false);
    expect(scope.dockerImageRequired).toBe(false);
    expect(scope.terraformRequired).toBe(false);
    expect(scope.exposurePostureChanged).toBe(false);
    expect(scope.affectedWorkspaces).toEqual([]);
  });

  it("maps marketplace OpenAPI docs to platform-api parity coverage", () => {
    const baseDir = path.join(process.cwd(), "repo");
    const scope = classifyChanges({
      baseDir,
      changedFiles: ["docs/api/marketplace.openapi.json"],
      workspaces: [
        {
          ...workspace(baseDir, "deployables", "platform-api", "@test/platform-api"),
          packageJson: {
            name: "@test/platform-api",
            dependencies: {},
            scripts: { test: "vitest run" },
          },
        },
      ],
    });

    expect(scope.docsOnly).toBe(false);
    expect(scope.localChecksRequired).toBe(true);
    expect(scope.affectedWorkspaces).toEqual(["@test/platform-api"]);
    expect(scope.directlyTestOnlyAffectedWorkspaces).toEqual(["@test/platform-api"]);
    expect(scope.unitTestsRequired).toBe(true);
    expect(scope.buildRequired).toBe(false);
    expect(scope.deployRequired).toBe(false);
  });

  it("maps context metadata route changes to platform-runtime and OpenAPI parity coverage", () => {
    const baseDir = path.join(process.cwd(), "repo");
    const scope = classifyChanges({
      baseDir,
      changedFiles: ["bounded-contexts/inventory/context.json"],
      workspaces: [
        workspace(baseDir, "bounded-contexts", "inventory", "@test/inventory"),
        workspace(baseDir, "infrastructure", "platform-runtime", "@test/platform-runtime"),
        workspace(baseDir, "deployables", "platform-api", "@test/app-platform-api", {
          "@test/inventory": "workspace:*",
        }),
      ],
    });

    expect(scope.affectedWorkspaces).toEqual(["@test/inventory", "@test/platform-runtime", "@test/app-platform-api"]);
    expect(scope.directlyTestOnlyAffectedWorkspaces).toEqual(["@test/app-platform-api", "@test/platform-runtime"]);
    expect(scope.unitTestsRequired).toBe(true);
    expect(scope.buildRequired).toBe(true);
  });

  it("classifies every source-context wake registry shard exactly like the pre-split single file", () => {
    const baseDir = path.join(process.cwd(), "repo");
    const workspaces = [
      workspace(baseDir, "infrastructure", "platform-runtime", "@test/platform-runtime"),
      workspace(baseDir, "deployables", "platform-api", "@test/app-platform-api", {
        "@test/platform-runtime": "workspace:*",
      }),
    ];
    // `changedFiles` is the echoed input, not a classification; every other
    // key must be identical for a shard and for the pre-split single file.
    const classify = (changedFile) => {
      const { changedFiles, ...classification } = classifyChanges({
        baseDir,
        changedFiles: [changedFile],
        workspaces,
      });
      return classification;
    };
    const aggregate = classify("infrastructure/platform-runtime/source-context-wake-registry.ts");

    // The pre-split baseline: the registry feeds platform-api contract
    // coverage, so it lands in both the directly affected and the test-only
    // sets. A shard that only matched the workspace directory would drop
    // @test/app-platform-api from both and silently stop running those tests.
    expect(aggregate.directlyAffectedWorkspaces).toEqual(["@test/app-platform-api", "@test/platform-runtime"]);
    expect(aggregate.directlyTestOnlyAffectedWorkspaces).toEqual(["@test/app-platform-api", "@test/platform-runtime"]);

    for (const familyPath of [
      "infrastructure/platform-runtime/source-context-wake-registry/catalog.ts",
      "infrastructure/platform-runtime/source-context-wake-registry/commercial-terms.ts",
      "infrastructure/platform-runtime/source-context-wake-registry-entry.ts",
    ]) {
      expect(classify(familyPath), familyPath).toEqual(aggregate);
    }
  });

  it("classifies renamed and deleted wake registry shard paths as context metadata routes", () => {
    const baseDir = path.join(process.cwd(), "repo");
    const workspaces = [
      workspace(baseDir, "infrastructure", "platform-runtime", "@test/platform-runtime"),
      workspace(baseDir, "deployables", "platform-api", "@test/app-platform-api", {
        "@test/platform-runtime": "workspace:*",
      }),
    ];

    // `listChangedFiles` reports renames and deletions as plain paths, so a
    // shard that is removed or moved must still route the platform-api
    // coverage its membership change invalidates.
    const renamed = classifyChanges({
      baseDir,
      workspaces,
      changedFiles: [
        "infrastructure/platform-runtime/source-context-wake-registry/catalog.ts",
        "infrastructure/platform-runtime/source-context-wake-registry/catalog-authoring.ts",
      ],
    });
    const deleted = classifyChanges({
      baseDir,
      workspaces,
      changedFiles: ["infrastructure/platform-runtime/source-context-wake-registry/notifications.ts"],
    });

    for (const scope of [renamed, deleted]) {
      expect(scope.directlyAffectedWorkspaces).toEqual(["@test/app-platform-api", "@test/platform-runtime"]);
      expect(scope.directlyTestOnlyAffectedWorkspaces).toEqual(["@test/app-platform-api", "@test/platform-runtime"]);
    }
  });

  it("escalates pricing event-subscription metadata to targeted DB admission", () => {
    const scope = classifyChanges({
      changedFiles: ["bounded-contexts/pricing/context.json"],
    });

    expect(scope.integrationRiskRequired).toBe(true);
    expect(scope.integrationRiskReason).toBe("Bounded-context metadata, including event subscriptions, changed");
    expect(scope.dbTestsRequired).toBe(true);
    expect(toOutputMap(scope).integration_risk_required).toBe("true");
    expect(toOutputMap(scope).integration_risk_reason).toBe(scope.integrationRiskReason);
  });

  it("escalates cross-context runtime composition to targeted DB admission", () => {
    const scope = classifyChanges({
      changedFiles: ["infrastructure/bounded-context-runtime/subscriptions.ts"],
    });

    expect(scope.integrationRiskRequired).toBe(true);
    expect(scope.integrationRiskReason).toBe("Cross-context subscription or runtime composition changed");
    expect(scope.dbTestsRequired).toBe(true);
  });

  it("escalates shared admin shell and router changes to affected admin E2E", () => {
    const scope = classifyChanges({
      changedFiles: ["deployables/admin-web/app/admin-root-shell.tsx"],
    });

    expect(scope.integrationRiskRequired).toBe(true);
    expect(scope.integrationRiskReason).toBe("Shared application shell or router changed");
    expect(scope.e2eSuiteIds).toEqual([
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

  it("escalates design-system navigation changes to affected browser E2E", () => {
    const scope = classifyChanges({
      changedFiles: ["packages/design-system/src/components/actions/section-navigation.tsx"],
    });

    expect(scope.integrationRiskRequired).toBe(true);
    expect(scope.integrationRiskReason).toBe("Design-system navigation changed");
    expect(scope.e2eSuiteIds).toEqual([
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

  it("keeps docs and ordinary single-slice changes on the fast lane", () => {
    const docsScope = classifyChanges({
      changedFiles: ["docs/runbooks/integration-risk.md"],
    });
    const sliceScope = classifyChanges({
      changedFiles: ["bounded-contexts/pricing/features/recommendations/domain/recommendation.ts"],
    });

    expect(docsScope.integrationRiskRequired).toBe(false);
    expect(docsScope.integrationRiskReason).toBe("No integration-risk change detected");
    expect(sliceScope.integrationRiskRequired).toBe(false);
    expect(sliceScope.integrationRiskReason).toBe("No integration-risk change detected");
  });

  it.each(lockedIntegrationParityCorpus)(
    "locks the pre-PR integration battery for %s %s",
    (status, filename, previousFilename) => {
      const priorReasons = priorProductionIntegrationReasons(filename);
      const change = {
        filename,
        status,
        ...(status === "renamed" ? { previousFilename } : {}),
      };
      const projected = classifyIntegrationRisk({ changedFiles: [change] });
      const scope = classifyChanges({ changedFiles: [filename] });

      expect(projected.reasons).toEqual(priorReasons);
      expect(projected.required).toBe(priorReasons.length > 0);
      expect(scope.integrationRiskRequired).toBe(priorReasons.length > 0);
      expect(scope.integrationRiskReason).toBe(
        priorReasons.length > 0 ? priorReasons.join("; ") : "No integration-risk change detected",
      );
    },
  );

  it("keeps the rename-out advisory delta explicit without widening the required battery", () => {
    const change = {
      filename: "archive/legacy-runtime.ts",
      previousFilename: "infrastructure/platform-runtime/legacy-runtime.ts",
      status: "renamed",
    };

    expect(classifyIntegrationRisk({ changedFiles: [change] })).toEqual({ required: false, reasons: [] });
    expect(classifyRisk({ changedFiles: [change] })).toMatchObject({
      classification: "high",
      categories: expect.arrayContaining(["cross-context-contract"]),
    });
  });

  it("keeps unrelated bounded-context changes from pulling platform-runtime into scope", () => {
    const baseDir = path.join(process.cwd(), "repo");
    const scope = classifyChanges({
      baseDir,
      changedFiles: ["bounded-contexts/inventory/features/import-batches/domain/import-batch.ts"],
      workspaces: [
        workspace(baseDir, "bounded-contexts", "inventory", "@test/inventory"),
        workspace(baseDir, "infrastructure", "platform-runtime", "@test/platform-runtime"),
        workspace(baseDir, "deployables", "platform-api", "@test/app-platform-api", {
          "@test/inventory": "workspace:*",
        }),
      ],
    });

    expect(scope.affectedWorkspaces).toEqual(["@test/inventory", "@test/app-platform-api"]);
    expect(scope.directlyTestOnlyAffectedWorkspaces).toEqual([]);
    expect(scope.affectedWorkspaces).not.toContain("@test/platform-runtime");
  });

  it("includes provider credential vocabulary and its real Catalog dependents", () => {
    const scope = classifyChanges({ changedFiles: ["contracts/provider-credentials/index.ts"] });

    expect(scope.directlyAffectedWorkspaces).toEqual(["@chase-sets/provider-credentials", publicPresenceWorkspaceName]);
    expect(scope.affectedWorkspaces).toEqual(
      expect.arrayContaining([
        "@chase-sets/provider-credentials",
        "@chase-sets/catalog",
        "@chase-sets/app-platform-api",
      ]),
    );
    expect(scope.unitTestsRequired).toBe(true);
    expect(scope.buildRequired).toBe(true);
  });

  it("expands affected workspaces through workspace dependents", () => {
    const baseDir = path.join(process.cwd(), "repo");
    const scope = classifyChanges({
      baseDir,
      changedFiles: ["contracts/primitives/typed-ids.ts"],
      workspaces: [
        workspace(baseDir, "contracts", "primitives", "@test/primitives"),
        workspace(baseDir, "bounded-contexts", "catalog", "@test/catalog", {
          "@test/primitives": "workspace:*",
        }),
        workspace(baseDir, "deployables", "public-web", "@test/public-web", {
          "@test/catalog": "workspace:*",
        }),
      ],
    });

    expect(scope.affectedWorkspaces).toEqual(["@test/primitives", "@test/catalog", "@test/public-web"]);
    expect(scope.unitTestsRequired).toBe(true);
    expect(scope.buildRequired).toBe(true);
    expect(scope.deployRequired).toBe(true);
    expect(scope.exposurePostureCategories).toEqual([]);
    // #4864: a pure app-code change (no Helm/Terraform/deploy-script/deploy-
    // workflow surface touched) still needs a docker image, but must not get
    // a chase-sets-pr-<n> cluster preview -- it gets the CI compose
    // boot+smoke job instead.
    expect(scope.dockerImageRequired).toBe(true);
    expect(scope.clusterPreviewRequired).toBe(false);
    expect(scope.composeSmokeRequired).toBe(true);
  });

  it("reruns tests for dev-dependents of runtime changes without fanning out to their dependents", () => {
    const baseDir = path.join(process.cwd(), "repo");
    const scope = classifyChanges({
      baseDir,
      changedFiles: ["bounded-contexts/catalog/features/catalog-items/domain/catalog-item.ts"],
      workspaces: [
        workspace(baseDir, "bounded-contexts", "catalog", "@test/catalog"),
        {
          ...workspace(baseDir, "bounded-contexts", "inventory", "@test/inventory"),
          packageJson: {
            name: "@test/inventory",
            dependencies: {},
            devDependencies: { "@test/catalog": "workspace:*" },
            scripts: { "test:db": "test:db" },
          },
        },
        workspace(baseDir, "bounded-contexts", "marketplace", "@test/marketplace", {
          "@test/inventory": "workspace:*",
        }),
        workspace(baseDir, "deployables", "platform-api", "@test/platform-api", {
          "@test/catalog": "workspace:*",
        }),
      ],
    });

    expect(scope.affectedWorkspaces).toEqual(["@test/catalog", "@test/inventory", "@test/platform-api"]);
    expect(scope.runtimeAffectedWorkspaces).toEqual(["@test/catalog", "@test/platform-api"]);
    expect(scope.devDependencyTestAffectedWorkspaces).toEqual(["@test/inventory"]);
    expect(scope.unitTestsRequired).toBe(true);
    expect(scope.dbTestsRequired).toBe(true);
    expect(scope.buildRequired).toBe(true);
  });

  it("keeps a catalog-internal domain edit inside the catalog runtime boundary", () => {
    const scope = classifyChanges({
      changedFiles: ["bounded-contexts/catalog/features/catalog-items/domain/catalog-item.ts"],
    });

    expect(scope.affectedWorkspaces.length).toBeLessThanOrEqual(10);
    expect(scope.affectedWorkspaces).toContain("@chase-sets/catalog");
    for (const workspaceName of [
      "@chase-sets/checkout",
      "@chase-sets/payments",
      "@chase-sets/settlement",
      "@chase-sets/marketplace",
      "@chase-sets/ordering",
    ]) {
      expect(scope.affectedWorkspaces).not.toContain(workspaceName);
    }
    // Acceptance tests in inventory, discovery, and pricing mount the catalog module, so
    // their tests rerun without dragging their own dependents along.
    expect(scope.devDependencyTestAffectedWorkspaces).toEqual([
      "@chase-sets/discovery",
      "@chase-sets/inventory",
      "@chase-sets/pricing",
    ]);
    expect(scope.dbTestsRequired).toBe(true);
  });

  it("fans a catalog-seed fixture edit out to every seed consumer", () => {
    const scope = classifyChanges({
      changedFiles: ["contracts/catalog-seed/ids.ts"],
    });

    for (const workspaceName of [
      "@chase-sets/catalog",
      "@chase-sets/catalog-seed",
      "@chase-sets/checkout",
      "@chase-sets/inventory",
      "@chase-sets/marketplace",
      "@chase-sets/marketplace-seed-testing",
      "@chase-sets/ordering",
    ]) {
      expect(scope.affectedWorkspaces).toContain(workspaceName);
    }
  });

  it("detects DB tests only when an affected workspace publishes a DB test script", () => {
    const baseDir = path.join(process.cwd(), "repo");
    const fastScope = classifyChanges({
      baseDir,
      changedFiles: ["packages/design-system/button.tsx"],
      workspaces: [
        workspace(baseDir, "packages", "design-system", "@test/design-system"),
        {
          ...workspace(baseDir, "deployables", "platform-api", "@test/platform-api", {}, { testProfile: "db" }),
          packageJson: {
            name: "@test/platform-api",
            dependencies: {},
            chaseSets: { testProfile: "db" },
            scripts: { "test:db": "test:db" },
          },
        },
      ],
    });

    expect(fastScope.dbTestsRequired).toBe(false);

    const dbScope = classifyChanges({
      baseDir,
      changedFiles: ["deployables/platform-api/src/main.ts"],
      workspaces: [
        workspace(baseDir, "packages", "design-system", "@test/design-system"),
        {
          ...workspace(baseDir, "deployables", "platform-api", "@test/platform-api", {}, { testProfile: "db" }),
          packageJson: {
            name: "@test/platform-api",
            dependencies: {},
            chaseSets: { testProfile: "db" },
            scripts: { "test:db": "test:db" },
          },
        },
      ],
    });

    expect(dbScope.dbTestsRequired).toBe(true);
  });

  it("keeps DB-backed context test-only changes scoped to the owning workspace", () => {
    const baseDir = path.join(process.cwd(), "repo");
    const scope = classifyChanges({
      baseDir,
      changedFiles: ["bounded-contexts/catalog/tests/catalog-authoring/acceptance/admin-page-projections.test.ts"],
      workspaces: [
        {
          ...workspace(baseDir, "bounded-contexts", "catalog", "@test/catalog", {}, { testProfile: "db" }),
          packageJson: {
            name: "@test/catalog",
            dependencies: {},
            chaseSets: { testProfile: "db" },
            scripts: {
              "test:unit": "test:unit",
              "test:db": "vitest run tests/catalog-authoring/acceptance/admin-page-projections.test.ts",
            },
          },
        },
        workspace(baseDir, "bounded-contexts", "discovery", "@test/discovery", {
          "@test/catalog": "workspace:*",
        }),
      ],
    });

    expect(scope.affectedWorkspaces).toEqual(["@test/catalog"]);
    expect(scope.runtimeAffectedWorkspaces).toEqual([]);
    expect(scope.unitTestsRequired).toBe(true);
    expect(scope.dbTestsRequired).toBe(true);
    expect(scope.buildRequired).toBe(false);
    expect(scope.e2eTestsRequired).toBe(false);
  });

  it("routes a test-only change enrolled only in a non-default DB partition", () => {
    const baseDir = path.join(process.cwd(), "repo");
    const scope = classifyChanges({
      baseDir,
      changedFiles: ["deployables/platform-api/__tests__/partition-two.db.test.ts"],
      workspaces: [
        {
          ...workspace(baseDir, "deployables", "platform-api", "@test/platform-api", {}, { testProfile: "db" }),
          packageJson: {
            name: "@test/platform-api",
            dependencies: {},
            chaseSets: { testProfile: "db" },
            scripts: {
              "test:unit":
                "vitest run --exclude __tests__/partition-one.db.test.ts --exclude __tests__/partition-two.db.test.ts",
              "test:db:1": "vitest run __tests__/partition-one.db.test.ts",
              "test:db:2": "vitest run __tests__/partition-two.db.test.ts",
            },
          },
        },
      ],
    });

    expect(scope.affectedWorkspaces).toEqual(["@test/platform-api"]);
    expect(scope.dbTestsRequired).toBe(true);
  });

  it("requires DB tests only for affected workspaces that publish a DB test script", () => {
    const baseDir = path.join(process.cwd(), "repo");
    const scope = classifyChanges({
      baseDir,
      changedFiles: ["deployables/platform-api/__tests__/config.test.ts"],
      workspaces: [
        {
          ...workspace(baseDir, "deployables", "platform-api", "@test/platform-api", {}, { testProfile: "db" }),
          packageJson: {
            name: "@test/platform-api",
            dependencies: {},
            chaseSets: { testProfile: "db" },
            scripts: { test: "test", "test:unit": "test:unit" },
          },
        },
      ],
    });

    expect(scope.unitTestsRequired).toBe(true);
    expect(scope.dbTestsRequired).toBe(false);
  });

  it("narrows E2E requirements to marketplace-facing user journey surfaces", () => {
    const baseDir = path.join(process.cwd(), "repo");
    const domainScope = classifyChanges({
      baseDir,
      changedFiles: ["bounded-contexts/ordering/features/orders/domain/domain.ts"],
      workspaces: [workspace(baseDir, "bounded-contexts", "ordering", "@test/ordering")],
    });

    expect(domainScope.unitTestsRequired).toBe(true);
    expect(domainScope.e2eTestsRequired).toBe(false);
    expect(domainScope.e2eSuiteIds).toEqual([]);

    const routeScope = classifyChanges({
      baseDir,
      changedFiles: ["bounded-contexts/marketplace/routes/account-listing.tsx"],
      workspaces: [workspace(baseDir, "bounded-contexts", "marketplace", "@test/marketplace")],
    });

    expect(routeScope.e2eTestsRequired).toBe(true);
    expect(routeScope.e2eSuiteIds).toEqual(["marketplace_account", "marketplace_seller"]);

    const deployableTestScope = classifyChanges({
      baseDir,
      changedFiles: ["deployables/marketplace/app/routes/account-listing.test.tsx"],
      workspaces: [workspace(baseDir, "deployables", "marketplace", "@test/marketplace-web")],
    });

    expect(deployableTestScope.e2eTestsRequired).toBe(false);
    expect(deployableTestScope.e2eSuiteIds).toEqual([]);

    const deployableTestSupportScope = classifyChanges({
      baseDir,
      changedFiles: ["deployables/marketplace/app/routes/test-support/http.ts"],
      workspaces: [
        {
          ...workspace(baseDir, "deployables", "marketplace", "@test/marketplace-web"),
          packageJson: {
            name: "@test/marketplace-web",
            dependencies: {},
            scripts: { test: "vitest run" },
          },
        },
      ],
    });

    expect(deployableTestSupportScope.affectedWorkspaces).toEqual(["@test/marketplace-web"]);
    expect(deployableTestSupportScope.runtimeAffectedWorkspaces).toEqual([]);
    expect(deployableTestSupportScope.unitTestsRequired).toBe(true);
    expect(deployableTestSupportScope.buildRequired).toBe(false);
    expect(deployableTestSupportScope.dockerImageRequired).toBe(false);
    expect(deployableTestSupportScope.e2eTestsRequired).toBe(false);
    expect(deployableTestSupportScope.e2eSuiteIds).toEqual([]);

    const deployableRouteScope = classifyChanges({
      baseDir,
      changedFiles: ["deployables/marketplace/app/routes/account-listing.tsx"],
      workspaces: [workspace(baseDir, "deployables", "marketplace", "@test/marketplace-web")],
    });

    expect(deployableRouteScope.e2eTestsRequired).toBe(true);
    expect(deployableRouteScope.e2eSuiteIds).toEqual(["marketplace_seller"]);

    const deployableUtilityScope = classifyChanges({
      baseDir,
      changedFiles: ["deployables/marketplace/app/routes/manifest.ts"],
      workspaces: [workspace(baseDir, "deployables", "marketplace", "@test/marketplace-web")],
    });

    expect(deployableUtilityScope.e2eTestsRequired).toBe(false);
    expect(deployableUtilityScope.e2eSuiteIds).toEqual([]);

    const deployableSpecScope = classifyChanges({
      baseDir,
      changedFiles: ["deployables/marketplace/e2e/item-detail.spec.ts"],
      workspaces: [workspace(baseDir, "deployables", "marketplace", "@test/marketplace-web")],
    });

    expect(deployableSpecScope.runtimeAffectedWorkspaces).toEqual([]);
    expect(deployableSpecScope.unitTestsRequired).toBe(true);
    expect(deployableSpecScope.buildRequired).toBe(false);
    expect(deployableSpecScope.e2eTestsRequired).toBe(true);
    expect(deployableSpecScope.e2eSuiteIds).toEqual(["marketplace_browse"]);
  });

  it("routes root browser runtime changes to browser E2E suites", () => {
    const baseDir = path.join(process.cwd(), "repo");
    const scope = classifyChanges({
      baseDir,
      changedFiles: ["package.json", "pnpm-lock.yaml"],
      workspaces: [workspace(baseDir, "deployables", "marketplace", "@test/marketplace-web")],
    });

    expect(scope.e2eTestsRequired).toBe(true);
    expect(scope.e2eSuiteIds).toEqual([
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

  it("keeps test typecheck configuration changes out of runtime fanout", () => {
    const baseDir = path.join(process.cwd(), "repo");
    const scope = classifyChanges({
      baseDir,
      changedFiles: ["tsconfig.tests.json", "test-env.d.ts"],
      workspaces: [workspace(baseDir, "deployables", "marketplace", "@test/marketplace-web")],
    });

    expect(scope.localChecksRequired).toBe(true);
    expect(scope.unitTestsRequired).toBe(false);
    expect(scope.buildRequired).toBe(false);
    expect(scope.e2eTestsRequired).toBe(false);
  });

  it("re-runs every workspace's tests for root vitest configuration changes without runtime fanout", () => {
    const baseDir = path.join(process.cwd(), "repo");
    const scope = classifyChanges({
      baseDir,
      changedFiles: ["vitest.shared.mjs"],
      workspaces: [
        workspace(baseDir, "deployables", "marketplace", "@test/marketplace-web"),
        workspace(baseDir, "bounded-contexts", "catalog", "@test/catalog"),
      ],
    });

    expect(scope.localChecksRequired).toBe(true);
    expect(scope.unitTestsRequired).toBe(true);
    expect(scope.affectedWorkspaces).toEqual(["@test/marketplace-web", "@test/catalog"]);
    expect(scope.runtimeAffectedWorkspaces).toEqual([]);
    expect(scope.buildRequired).toBe(false);
    expect(scope.dockerImageRequired).toBe(false);
    expect(scope.deployRequired).toBe(false);
    expect(scope.e2eTestsRequired).toBe(false);
  });

  it.each(schedulerOwnedArtifacts)(
    "re-runs every workspace's unit tests for scheduler artifact %s without unrelated gate fanout",
    (schedulerOwnedArtifact) => {
      const currentWorkspaceNames = listWorkspacePackages({ repoRoot }).map((entry) => entry.name);
      const scope = classifyChanges({ changedFiles: [schedulerOwnedArtifact] });

      expect(scope.affectedWorkspaces).toEqual(currentWorkspaceNames);
      expect(scope.unitTestsRequired).toBe(true);
      expect(scope).toMatchObject({
        runtimeAffectedWorkspaces: [],
        devDependencyTestAffectedWorkspaces: [],
        // #9670: Public Presence's nonempty-diff enrollment is the only direct member.
        directlyAffectedWorkspaces: [publicPresenceWorkspaceName],
        directlyRuntimeAffectedWorkspaces: [],
        directlyTestOnlyAffectedWorkspaces: [publicPresenceWorkspaceName],
        dbTestsRequired: true,
        e2eSuiteIds: [],
        e2eTestsRequired: false,
        integrationRiskRequired: false,
        buildRequired: false,
        dockerImageRequired: false,
        terraformRequired: false,
        workflowLintRequired: false,
        deployRequired: false,
        clusterPreviewRequired: false,
        composeSmokeRequired: false,
        exposurePostureChanged: false,
        exposurePostureCategories: [],
      });
    },
  );

  it.each(schedulerOwnedArtifacts)(
    "requires DB profile tests for scheduler-owned artifact %s and preserves its base fan-out",
    (schedulerOwnedArtifact) => {
      const scope = classifyChanges({ changedFiles: [schedulerOwnedArtifact] });
      const outputs = toOutputMap(scope);

      expect(scope.dbTestsRequired).toBe(true);
      expect(outputs.db_tests).toBe("true");

      // The fan-out is the reason the DB job has work to do, so it is asserted
      // for membership and order against the base capture, not merely for
      // length or for containing the DB-capable deployable.
      expect(scope.affectedWorkspaces).toEqual(baseCapturedSchedulerFanoutWorkspaces);
      expect(scope.affectedWorkspaces).toEqual(listWorkspacePackages({ repoRoot }).map((entry) => entry.name));
      expect(scope.affectedWorkspaces).toHaveLength(baseCapturedSchedulerFanoutWorkspaces.length);
      expect(scope.affectedWorkspaces).toContain("@chase-sets/app-platform-api");
      expect(outputs.affected_workspaces).toBe(baseCapturedAllWorkspacesCsv);
      expect(outputs.affected_workspaces_json).toBe(baseCapturedAllWorkspacesJson);
    },
  );

  it("keeps the scheduler-owned artifact set at exactly its four frozen members", () => {
    expect(schedulerOwnedArtifacts).toEqual([
      "scripts/run-workspaces.mjs",
      "scripts/run-workspaces.test.mjs",
      "scripts/workspace-test-duration-hints-v1.json",
      "scripts/fixtures/workspace-unit-duration-replay-v1.json",
    ]);

    // Membership is proven behaviourally in both directions: every member fans
    // out to every workspace and requires DB tests, and no near-miss path does.
    for (const member of schedulerOwnedArtifacts) {
      const scope = classifyChanges({ changedFiles: [member] });
      expect(scope.affectedWorkspaces).toEqual(baseCapturedSchedulerFanoutWorkspaces);
      expect(scope.dbTestsRequired).toBe(true);
    }

    for (const nonMember of [
      ...schedulerVocabularyLookalikePaths,
      "scripts/change-scope.mjs",
      "scripts/db-test-preflight.mjs",
    ]) {
      const scope = classifyChanges({ changedFiles: [nonMember] });
      expect(scope.affectedWorkspaces).toEqual([publicPresenceWorkspaceName]);
      expect(scope.dbTestsRequired).toBe(false);
    }
  });

  it("requires the complete DB sweep for the isolation mechanism without deploying the scheduler", () => {
    for (const changedFiles of [["scripts/run-workspaces.mjs"], [".github/workflows/platform-pr.yml"]]) {
      const scope = classifyChanges({ changedFiles });
      expect(scope.dbTestsRequired).toBe(true);
      expect(scope.affectedWorkspaces).toEqual(
        changedFiles[0].startsWith("scripts/") ? listWorkspacePackages({ repoRoot }).map((entry) => entry.name) : [],
      );
    }
    const drift = classifyChanges({ changedFiles: ["scripts/release-health-db-duration-drift.mjs"] });
    expect(drift.affectedWorkspaces).toEqual([publicPresenceWorkspaceName]);
    expect(drift.dbTestsRequired).toBe(false);
  });

  it.each(schedulerVocabularyLookalikePaths)(
    "leaves scheduler-vocabulary lookalike %s classified as an ordinary script change",
    (lookalikePath) => {
      const scope = classifyChanges({ changedFiles: [lookalikePath] });
      const outputs = toOutputMap(scope);

      expect(scope.dbTestsRequired).toBe(false);
      expect(outputs.db_tests).toBe("false");
      expect(scope.affectedWorkspaces).toEqual([publicPresenceWorkspaceName]);
      expect(outputs).toEqual(withPublicPresenceEnrollmentOutputs(baseCapturedNoWorkspaceOutputMap([lookalikePath])));
    },
  );

  it("closes the old-versus-new db_tests corpus over its enumerated cases", () => {
    expect(dbTestsOldVersusNewCorpus.map((testCase) => testCase.name)).toEqual(dbTestsOldVersusNewCorpusCaseNames);
    expect(new Set(dbTestsOldVersusNewCorpusCaseNames).size).toBe(dbTestsOldVersusNewCorpusCaseNames.length);

    for (const testCase of dbTestsOldVersusNewCorpus) {
      expect(Object.keys(testCase).sort()).toEqual([...dbTestsCorpusCaseKeys].sort());
      expect(Array.isArray(testCase.changedFiles)).toBe(true);
      expect(["true", "false"]).toContain(testCase.baseDbTests);
      expect(["true", "false"]).toContain(testCase.expectedDbTests);
      expect(testCase.changesDbTests).toBe(testCase.baseDbTests !== testCase.expectedDbTests);
      expect(Object.keys(testCase.baseOutputMap)).toEqual(baseCapturedOutputMapKeyOrder);
      expect(testCase.baseOutputMap.db_tests).toBe(testCase.baseDbTests);
    }
  });

  it("changes db_tests for exactly the scheduler-owned artifacts and platform-pr workflow across the whole corpus", () => {
    const observed = dbTestsOldVersusNewCorpus.map((testCase) => ({
      name: testCase.name,
      changedFiles: testCase.changedFiles,
      previous: testCase.baseDbTests,
      next: toOutputMap(classifyChanges({ changedFiles: testCase.changedFiles })).db_tests,
    }));

    for (const [index, entry] of observed.entries()) {
      expect(entry.next).toBe(dbTestsOldVersusNewCorpus[index].expectedDbTests);
    }

    const changedCaseFileSets = observed
      .filter((entry) => entry.previous !== entry.next)
      .map((entry) => entry.changedFiles);

    // Set equality, not containment: a predicate that also flipped an unrelated
    // case would pass a containment check and must fail here.
    expect(changedCaseFileSets).toEqual([
      ...schedulerOwnedArtifacts.map((artifact) => [artifact]),
      [".github/workflows/platform-pr.yml"],
    ]);
  });

  it.each([".github/workflows/platform-coverage.yml", ".github/actions/setup-pnpm-workspace/action.yml"])(
    "does not broaden DB selection to the workflow family: %s",
    (filename) => {
      const scope = classifyChanges({ changedFiles: [filename] });
      expect(scope.dbTestsRequired).toBe(false);
      expect(scope.affectedWorkspaces).toEqual([publicPresenceWorkspaceName]);
    },
  );

  it("keeps every output except db_tests and Public Presence enrollment byte-identical to the base commit for every corpus case", () => {
    for (const testCase of dbTestsOldVersusNewCorpus) {
      const scope = classifyChanges({ changedFiles: testCase.changedFiles });
      const outputs = toOutputMap(scope);

      expect(Object.keys(outputs)).toEqual(baseCapturedOutputMapKeyOrder);
      expect(outputs.db_tests).toBe(testCase.expectedDbTests);
      expect(outputs).toEqual(
        withPublicPresenceEnrollmentOutputs({ ...testCase.baseOutputMap, db_tests: testCase.expectedDbTests }),
      );
      expect(String(scope.dbTestsRequired)).toBe(testCase.expectedDbTests);
    }
  });

  it("requires DB profile tests for the dependent slice's predicted changed-file set", () => {
    const scope = classifyChanges({ changedFiles: dependentSliceBaseCapture.changedFiles });
    const outputs = toOutputMap(scope);

    expect(dependentSliceBaseCapture.baseDbTests).toBe("false");
    expect(outputs.db_tests).toBe("true");
    expect(outputs.db_tests).toBe(dependentSliceBaseCapture.expectedDbTests);
    expect(scope.dbTestsRequired).toBe(true);
    expect(scope.affectedWorkspaces).toEqual(baseCapturedSchedulerFanoutWorkspaces);
    expect(outputs).toEqual(
      withPublicPresenceEnrollmentOutputs({
        ...dependentSliceBaseCapture.baseOutputMap,
        db_tests: dependentSliceBaseCapture.expectedDbTests,
      }),
    );
  });

  it("still reports no DB tests for a scheduler-owned change when no workspace exposes a DB script", () => {
    const baseDir = path.join(process.cwd(), "repo");
    const workspacesWithoutDbScripts = [
      workspaceWithScripts(baseDir, "packages", "design-system", "@test/design-system", { test: "test" }),
      workspaceWithScripts(baseDir, "deployables", "platform-api", "@test/platform-api", {
        test: "test",
        "test:unit": "test:unit",
      }),
    ];

    for (const schedulerOwnedArtifact of schedulerOwnedArtifacts) {
      const scope = classifyChanges({
        baseDir,
        changedFiles: [schedulerOwnedArtifact],
        workspaces: workspacesWithoutDbScripts,
      });

      // The fan-out still names every workspace; only the DB requirement is
      // withheld, because there is no DB execution unit to run.
      expect(scope.affectedWorkspaces).toEqual(["@test/design-system", "@test/platform-api"]);
      expect(scope.unitTestsRequired).toBe(true);
      expect(scope.dbTestsRequired).toBe(false);
      expect(toOutputMap(scope).db_tests).toBe("false");
    }
  });

  it("requires DB tests for a scheduler-owned change as soon as one injected workspace exposes a DB script", () => {
    const baseDir = path.join(process.cwd(), "repo");
    const workspacesWithOneDbScript = [
      workspaceWithScripts(baseDir, "packages", "design-system", "@test/design-system", { test: "test" }),
      workspaceWithScripts(baseDir, "deployables", "platform-api", "@test/platform-api", {
        "test:unit": "test:unit",
        "test:db:1": "vitest run __tests__/partition-one.db.test.ts",
      }),
    ];

    for (const schedulerOwnedArtifact of schedulerOwnedArtifacts) {
      const scope = classifyChanges({
        baseDir,
        changedFiles: [schedulerOwnedArtifact],
        workspaces: workspacesWithOneDbScript,
      });

      expect(scope.affectedWorkspaces).toEqual(["@test/design-system", "@test/platform-api"]);
      expect(scope.dbTestsRequired).toBe(true);
      expect(toOutputMap(scope).db_tests).toBe("true");
    }
  });

  // A rename away from a frozen scheduler-owned path is the one Git status form
  // `git diff --name-only` does not report faithfully: rename detection collapses
  // the pair to its destination, so the frozen source path never reaches the
  // classifier and the DB profile job it owns is silently unselected. These cases
  // drive real Git objects through the production
  // `listChangedFiles -> classifyChanges -> toOutputMap` chain, and each carries
  // the rename-detected name list alongside as a control, so dropping
  // `--no-renames` from the production diff fails them.
  describe("scheduler-owned artifacts renamed away from their frozen paths", () => {
    const renameAwayCases = schedulerOwnedArtifacts.map((sourcePath, index) => ({
      index,
      sourcePath,
      destinationPath: `archive/${path.posix.basename(sourcePath)}`,
    }));
    let fixtureRoot;
    let fixtureCommits;

    // `diff.renames` is pinned on rather than inherited so the control below
    // observes Git's own default rename detection on any host.
    function fixtureGit(args) {
      return execFileSync(
        "git",
        [
          "-c",
          "core.autocrlf=false",
          "-c",
          "diff.renames=true",
          "-c",
          "user.name=Fixture",
          "-c",
          "user.email=fixture@example.invalid",
          ...args,
        ],
        { cwd: fixtureRoot, encoding: "utf8", windowsHide: true },
      );
    }

    beforeAll(() => {
      fixtureRoot = mkdtempSync(path.join(tmpdir(), "change-scope-rename-away-"));
      fixtureGit(["init", "--quiet", "--initial-branch=main"]);
      for (const { sourcePath } of renameAwayCases) {
        const target = path.join(fixtureRoot, sourcePath);
        mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(target, `scheduler-owned fixture body for ${sourcePath}\n`, "utf8");
      }
      mkdirSync(path.join(fixtureRoot, "archive"), { recursive: true });
      fixtureGit(["add", "--all"]);
      fixtureGit(["commit", "--quiet", "-m", "seed scheduler-owned artifacts"]);

      // One commit per case, each renaming exactly one artifact away. Case i is
      // then the diff from commit i to commit i+1, so every case observes a
      // single rename with no checkout churn between them.
      for (const { sourcePath, destinationPath } of renameAwayCases) {
        fixtureGit(["mv", sourcePath, destinationPath]);
        fixtureGit(["commit", "--quiet", "-m", `rename ${sourcePath} away`]);
      }
      fixtureCommits = fixtureGit(["log", "--format=%H", "--reverse"]).trim().split(/\r?\n/);
    });

    afterAll(() => {
      if (fixtureRoot) {
        rmSync(fixtureRoot, { recursive: true, force: true });
      }
    });

    it("covers every frozen scheduler-owned artifact with its own rename-away commit", () => {
      expect(renameAwayCases.map((entry) => entry.sourcePath)).toEqual(schedulerOwnedArtifacts);
      expect(fixtureCommits).toHaveLength(schedulerOwnedArtifacts.length + 1);
      expect(new Set(fixtureCommits).size).toBe(fixtureCommits.length);
    });

    it.each(renameAwayCases)(
      "requires DB tests when $sourcePath is renamed away to $destinationPath",
      ({ index, sourcePath, destinationPath }) => {
        const base = fixtureCommits[index];
        const head = fixtureCommits[index + 1];

        // Control: Git really does record this as a 100%-similarity rename, and
        // the rename-detected name list names only the destination. That list is
        // exactly what the production diff would return without `--no-renames`,
        // and it does not contain the frozen path.
        expect(fixtureGit(["diff", "--name-status", `${base}...${head}`]).trim()).toBe(
          `R100\t${sourcePath}\t${destinationPath}`,
        );
        expect(
          fixtureGit(["diff", "--name-only", `${base}...${head}`])
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean),
        ).toEqual([destinationPath]);

        // Production path: real Git objects through the exported `listChangedFiles`.
        const changedFiles = listChangedFiles(base, head, { cwd: fixtureRoot });
        expect([...changedFiles].sort()).toEqual([destinationPath, sourcePath].sort());

        const scope = classifyChanges({ changedFiles });
        const outputs = toOutputMap(scope);

        expect(scope.changedFiles).toEqual([destinationPath, sourcePath].sort());
        expect(scope.dbTestsRequired).toBe(true);
        expect(outputs.db_tests).toBe("true");

        // Nothing else moves: the same whole-repo fan-out a scheduler-owned
        // change already produced, and every other output key byte-identical to
        // the base-commit capture for that fan-out.
        expect(scope.affectedWorkspaces).toEqual(baseCapturedSchedulerFanoutWorkspaces);
        expect(scope.affectedWorkspaces).toContain("@chase-sets/app-platform-api");
        expect(outputs).toEqual(
          withPublicPresenceEnrollmentOutputs({
            ...baseCapturedSchedulerFanoutOutputMap(scope.changedFiles),
            db_tests: "true",
          }),
        );

        // Discriminator: the destination path alone carries none of this, so the
        // frozen source path recovered by `--no-renames` is what selects the job.
        const destinationOnly = classifyChanges({ changedFiles: [destinationPath] });
        expect(destinationOnly.dbTestsRequired).toBe(false);
        expect(toOutputMap(destinationOnly).db_tests).toBe("false");
        expect(destinationOnly.affectedWorkspaces).toEqual([publicPresenceWorkspaceName]);
      },
    );
  });

  it("locks the hosted DB old-versus-new admission corpus over real paths and every status form", () => {
    expect(hostedDbAdmissionCorpus).toHaveLength(
      hostedDbAdmissionCorpusSeeds.length * hostedDbAdmissionStatusForms.length,
    );
    expect(new Set(hostedDbAdmissionCorpus.map(({ name, status }) => `${name}:${status}`)).size).toBe(
      hostedDbAdmissionCorpus.length,
    );

    for (const seed of hostedDbAdmissionCorpusSeeds) {
      expect(hostedDbAdmissionCorpus.filter((entry) => entry.name === seed.name).map((entry) => entry.status)).toEqual(
        hostedDbAdmissionStatusForms,
      );
      for (const filename of seed.changedFiles) {
        expect(
          existsSync(path.join(repoRoot, filename)),
          `${seed.name} must use the real repository path ${filename}`,
        ).toBe(true);
      }
    }

    for (const testCase of hostedDbAdmissionCorpus) {
      const scope = classifyChanges({ changedFiles: testCase.changedFiles });
      const statusAwareIntegrationRisk = classifyIntegrationRisk({
        changedFiles: statusAwareRiskFiles(testCase),
      });
      const lane = hostedLaneFor({
        eventName: testCase.eventName,
        integrationRiskRequired: statusAwareIntegrationRisk.required,
      });
      const prior = priorHostedAdmission(scope, lane);
      const next = isolatedHostedDbAdmission(scope);
      const changesAdmission =
        prior.dbJobExecutes !== next.dbJobExecutes || prior.dbRequiredByName !== next.dbRequiredByName;

      expect(scope.dbTestsRequired, `${testCase.name}:${testCase.status} db_tests`).toBe(testCase.expected.db);
      expect(scope.e2eTestsRequired, `${testCase.name}:${testCase.status} e2e_tests`).toBe(testCase.expected.e2e);
      expect(scope.integrationRiskRequired, `${testCase.name}:${testCase.status} integration risk`).toBe(
        testCase.expected.integrationRisk,
      );
      expect(statusAwareIntegrationRisk.required, `${testCase.name}:${testCase.status} status-aware risk`).toBe(
        testCase.expected.integrationRisk,
      );
      expect(scope.clusterPreviewRequired, `${testCase.name}:${testCase.status} preview`).toBe(
        testCase.expected.clusterPreview,
      );
      expect(lane.fullBatteryRequired, `${testCase.name}:${testCase.status} full battery`).toBe(
        testCase.eventName === "merge_group",
      );
      expect(Boolean(testCase.deltaReason), `${testCase.name}:${testCase.status} named delta reason`).toBe(
        changesAdmission,
      );
      expect(next.e2eJobExecutes).toBe(prior.e2eJobExecutes);
      expect(next.e2eRequiredByName).toBe(prior.e2eRequiredByName);
      expect(next.affectedWorkspaces).toEqual(prior.affectedWorkspaces);
      if (testCase.expectedAffectedWorkspaces) {
        expect(next.affectedWorkspaces, `${testCase.name}:${testCase.status} affected_workspaces`).toEqual(
          withPublicPresenceAffected(testCase.expectedAffectedWorkspaces),
        );
      }

      if (testCase.name === "DB-and-E2E overlap") {
        expect(next).toMatchObject({
          dbJobExecutes: true,
          dbRequiredByName: true,
          e2eJobExecutes: true,
          e2eRequiredByName: true,
        });
      }
    }
  });

  it("makes every sibling seed-path and DB-shared-targeted-lane mutant bite the locked corpus", () => {
    const siblingMutantTable = hostedDbAdmissionCorpusSeeds
      .filter((entry) => entry.siblingKind)
      .map((entry) => {
        const scope = classifyChanges({ changedFiles: entry.changedFiles });
        const baseline = isolatedHostedDbAdmission(scope);
        const mutant = isolatedHostedDbAdmission({ ...scope, dbTestsRequired: false });
        return {
          mutant: `omit-${entry.siblingKind}-from-db-scope`,
          path: entry.changedFiles[0],
          baselineExecutes: baseline.dbJobExecutes,
          mutantExecutes: mutant.dbJobExecutes,
          killed: baseline.dbJobExecutes && !mutant.dbJobExecutes,
        };
      });

    expect(siblingMutantTable.length).toBeGreaterThan(0);
    expect(siblingMutantTable.map((entry) => entry.mutant)).toEqual([
      "omit-seeding-from-db-scope",
      "omit-bootstrap-from-db-scope",
      "omit-import-from-db-scope",
      "omit-reconciliation-from-db-scope",
    ]);
    expect(siblingMutantTable.every((entry) => entry.killed)).toBe(true);

    const overlap = hostedDbAdmissionCorpusSeeds.find((entry) => entry.name === "DB-and-E2E overlap");
    const overlapScope = classifyChanges({ changedFiles: overlap.changedFiles });
    const overlapLane = hostedLaneFor({
      eventName: overlap.eventName,
      integrationRiskRequired: overlapScope.integrationRiskRequired,
    });
    const isolated = isolatedHostedDbAdmission(overlapScope);
    const sharedPredicateMutant = priorHostedAdmission(overlapScope, overlapLane);
    const sharedPredicateMutantRow = {
      mutant: "put-db-back-under-shared-targeted-heavy-required",
      isolatedDbExecutes: isolated.dbJobExecutes,
      isolatedE2eExecutes: isolated.e2eJobExecutes,
      mutantDbExecutes: sharedPredicateMutant.dbJobExecutes,
      mutantE2eExecutes: sharedPredicateMutant.e2eJobExecutes,
      killed: isolated.dbJobExecutes && !sharedPredicateMutant.dbJobExecutes,
    };

    expect(sharedPredicateMutantRow.killed).toBe(true);
    expect(isolated.e2eJobExecutes).toBe(true);
    expect(sharedPredicateMutant.e2eJobExecutes).toBe(true);
    console.info("hosted-db sibling mutant table", siblingMutantTable);
    console.info("hosted-db shared-predicate mutant", sharedPredicateMutantRow);
  });

  it("enumerates all thirteen classifier and workflow consumers with exactly three moving admissions", () => {
    expect(hostedDbConsumerInventory.map((entry) => entry.name)).toEqual([
      "platform-pr/db-tests condition",
      "platform-pr/e2e-tests condition",
      "platform-pr/PR Required DB aggregation",
      "platform-pr/PR Required E2E aggregation",
      "platform-pr/preview-deploy-smoke admission",
      "scripts/release-deployment-scope.mjs",
      "scripts/release-qualification-scope.mjs",
      "scripts/verify-static-scoped.mjs",
      "scripts/verify-static-scoped.test.mjs",
      "scripts/public-web-route-smoke-workflows.test.mjs",
      "scripts/change-scope.test.mjs",
      "scripts/lib/risk-policy-v1.test.mjs",
      "scripts/digitalocean-platform-config.test.mjs",
    ]);
    expect(hostedDbConsumerInventory).toHaveLength(13);
    expect(hostedDbConsumerInventory.filter((entry) => entry.changesAdmission).map((entry) => entry.name)).toEqual([
      "platform-pr/db-tests condition",
      "platform-pr/PR Required DB aggregation",
      "platform-pr/preview-deploy-smoke admission",
    ]);

    const frozenSourceConsumers = [
      [
        "scripts/release-deployment-scope.mjs",
        'import { classifyChanges, listChangedFiles, toOutputMap } from "./change-scope.mjs";',
      ],
      ["scripts/release-qualification-scope.mjs", 'import { classifyChanges } from "./change-scope.mjs";'],
      ["scripts/verify-static-scoped.mjs", 'import { classifyChanges } from "./change-scope.mjs";'],
      ["scripts/verify-static-scoped.test.mjs", 'import { classifyChanges } from "./change-scope.mjs";'],
      ["scripts/public-web-route-smoke-workflows.test.mjs", 'import { classifyChanges } from "./change-scope.mjs";'],
      [
        "scripts/change-scope.test.mjs",
        'import { classifyChanges, listChangedFiles, toOutputMap } from "./change-scope.mjs";',
      ],
      ["scripts/lib/risk-policy-v1.test.mjs", "expect(changeScope).toContain('from \"./lib/risk-policy-v1.mjs\"');"],
      [
        "scripts/digitalocean-platform-config.test.mjs",
        'const platformPrWorkflow = readFileSync(resolve(".github/workflows/platform-pr.yml"), "utf8");',
      ],
    ];

    for (const [filename, frozenFragment] of frozenSourceConsumers) {
      expect(readFileSync(path.join(repoRoot, filename), "utf8"), filename).toContain(frozenFragment);
    }
  });

  it.each([
    "scripts/discovery-search-identity-terms-populate.mjs",
    "scripts/typescript-resolver-caller-manifests/discovery-search-identity-terms-populate.manifest",
  ])("requires an image and deploy without cluster preview for population asset %s", (file) => {
    const scope = classifyChanges({ changedFiles: [file] });
    const unrelated = classifyChanges({ changedFiles: ["scripts/unrelated-maintenance.mjs"] });
    expect(scope).toEqual({
      ...unrelated,
      changedFiles: [file],
      dockerImageRequired: true,
      deployRequired: true,
      composeSmokeRequired: true,
    });
    expect(scope.clusterPreviewRequired).toBe(false);
  });

  it.each([
    "scripts/discovery-search-identity-terms-populate.test.mjs",
    "scripts/discovery-search-identity-terms-populate.mjs.bak",
    "scripts/typescript-resolver-caller-manifests/discovery-search-identity-terms-populate.manifest.bak",
  ])("keeps population asset lookalikes out of image and deploy scope: %s", (file) => {
    expect(classifyChanges({ changedFiles: [file] })).toEqual({
      ...classifyChanges({ changedFiles: ["scripts/unrelated-maintenance.mjs"] }),
      changedFiles: [file],
    });
  });

  it("keeps unrelated scripts-only changes to Public Presence test enrollment without other fanout", () => {
    const scope = classifyChanges({ changedFiles: ["scripts/unrelated-maintenance.mjs"] });

    expect(scope.localChecksRequired).toBe(true);
    expect(scope.unitTestsRequired).toBe(true);
    expect(scope.affectedWorkspaces).toEqual([publicPresenceWorkspaceName]);
    expect(scope).toMatchObject({
      runtimeAffectedWorkspaces: [],
      devDependencyTestAffectedWorkspaces: [],
      directlyAffectedWorkspaces: [publicPresenceWorkspaceName],
      directlyRuntimeAffectedWorkspaces: [],
      directlyTestOnlyAffectedWorkspaces: [publicPresenceWorkspaceName],
      dbTestsRequired: false,
      e2eSuiteIds: [],
      e2eTestsRequired: false,
      integrationRiskRequired: false,
      buildRequired: false,
      dockerImageRequired: false,
      terraformRequired: false,
      workflowLintRequired: false,
      deployRequired: false,
      clusterPreviewRequired: false,
      composeSmokeRequired: false,
      exposurePostureChanged: false,
      exposurePostureCategories: [],
    });
  });

  it("requires deployment for the isolated Kubernetes deployment helper and test pair", () => {
    const scope = classifyChanges({
      changedFiles: ["scripts/platform-kubernetes-deployment.mjs", "scripts/platform-kubernetes-deployment.test.mjs"],
    });

    expect(scope).toMatchObject({
      deployRequired: true,
      clusterPreviewRequired: true,
      dockerImageRequired: false,
      buildRequired: false,
    });
  });

  it("keeps the exact production stale Helm recovery workflow out of cluster preview", () => {
    const scope = classifyChanges({
      changedFiles: [".github/workflows/platform-production-stale-helm-recovery.yml"],
    });

    expect(scope).toMatchObject({
      deployRequired: true,
      clusterPreviewRequired: false,
      dockerImageRequired: false,
      buildRequired: false,
    });
    expect(
      classifyChanges({ changedFiles: [".github/workflows/synthetic-unrelated-advisory.yml"] }).deployRequired,
    ).toBe(false);
  });

  it("does not require deployment for an unrelated scripts path", () => {
    expect(classifyChanges({ changedFiles: ["scripts/synthetic-unrelated-maintenance.mjs"] }).deployRequired).toBe(
      false,
    );
  });

  it("does not expand bounded-context unit test changes to runtime dependents or E2E", () => {
    const baseDir = path.join(process.cwd(), "repo");
    const scope = classifyChanges({
      baseDir,
      changedFiles: ["bounded-contexts/catalog/features/catalog-items/ui/catalog-item-list-page.test.tsx"],
      workspaces: [
        {
          ...workspace(baseDir, "bounded-contexts", "catalog", "@test/catalog", {}, { testProfile: "db" }),
          packageJson: {
            name: "@test/catalog",
            dependencies: {},
            chaseSets: { testProfile: "db" },
            scripts: {
              "test:unit": "test:unit",
              "test:db": "vitest run tests/catalog-authoring/acceptance/admin-page-projections.test.ts",
            },
          },
        },
        workspace(baseDir, "bounded-contexts", "discovery", "@test/discovery", {
          "@test/catalog": "workspace:*",
        }),
      ],
    });

    expect(scope.affectedWorkspaces).toEqual(["@test/catalog"]);
    expect(scope.runtimeAffectedWorkspaces).toEqual([]);
    expect(scope.unitTestsRequired).toBe(true);
    expect(scope.dbTestsRequired).toBe(false);
    expect(scope.buildRequired).toBe(false);
    expect(scope.deployRequired).toBe(false);
    expect(scope.e2eTestsRequired).toBe(false);
  });

  it("emits duration-balanced suite batches for E2E matrix fanout", () => {
    const baseDir = path.join(process.cwd(), "repo");
    const scope = classifyChanges({
      baseDir,
      changedFiles: ["package.json"],
      workspaces: [workspace(baseDir, "deployables", "marketplace", "@test/marketplace-web")],
    });
    const allBatches = JSON.parse(toOutputMap(scope).e2e_suite_batches_json);
    expect(allBatches.filter((batch) => batch.includes("rendered_copy"))).toEqual(["rendered_copy"]);
    const suiteBatches = allBatches.filter((batch) => batch !== "rendered_copy");
    const oldStaticBatches = [
      "marketplace_browse,marketplace_account",
      "marketplace_checkout,marketplace_seller",
      "catalog_admin_integrations,catalog_admin_modeling",
      "admin_growth,admin_commerce",
      "admin_support,admin_platform",
      "admin_auth,admin_access",
    ];
    const batchMeanSeconds =
      suiteBatches.reduce((total, batch) => total + batchDurationSeconds(batch), 0) / suiteBatches.length;
    const longestBatchDistanceFromMean = (batches) => Math.max(...batches.map(batchDurationSeconds)) - batchMeanSeconds;

    expect(suiteBatches).toEqual([
      "catalog_admin_integrations,admin_auth",
      "catalog_admin_modeling,admin_platform",
      "marketplace_checkout,admin_support",
      "marketplace_browse,marketplace_account",
      "admin_commerce,admin_access",
      "marketplace_seller,admin_growth",
    ]);
    expect(suiteBatches.flatMap((batch) => batch.split(",")).sort()).toEqual([...scope.e2eSuiteIds].sort());
    expect(new Set(suiteBatches.flatMap((batch) => batch.split(","))).size).toBe(scope.e2eSuiteIds.length);
    expect(longestBatchDistanceFromMean(suiteBatches)).toBeLessThan(longestBatchDistanceFromMean(oldStaticBatches) / 2);
    expect(toOutputMap(scope)).not.toHaveProperty("coverage_fast");
    expect(toOutputMap(scope)).not.toHaveProperty("coverage_summary");
    expect(toOutputMap(scope).exposure_posture_changed).toBe("false");
  });

  it.each([
    {
      // Suite-selecting paths of the settlement change whose account/extension job hit the 25-minute limit.
      changedFiles: [
        "bounded-contexts/channels/features/connector-client/tests/coordinator-test-support.ts",
        "bounded-contexts/channels/features/outbound-sync/api/runtime.ts",
        "bounded-contexts/channels/features/tcgplayer-csv/api/runtime.ts",
        "deployables/tcgplayer-connector-extension/__tests__/harness/executors.harness.ts",
      ],
      suites: ["marketplace_account", "marketplace_seller", "tcgplayer_connector_extension"],
      batches: ["marketplace_account,marketplace_seller", "tcgplayer_connector_extension", "rendered_copy"],
    },
    {
      changedFiles: [
        "deployables/marketplace/e2e/account-elevation-intent.spec.ts",
        "deployables/tcgplayer-connector-extension/src/background.ts",
      ],
      suites: ["marketplace_account", "tcgplayer_connector_extension"],
      batches: ["marketplace_account", "tcgplayer_connector_extension", "rendered_copy"],
    },
  ])("emits the connector extension as its own matrix batch for $suites", ({ changedFiles, suites, batches }) => {
    const scope = classifyChanges({ changedFiles });
    const output = toOutputMap(scope);
    expect(scope.e2eTestsRequired).toBe(true);
    expect(scope.e2eSuiteIds).toEqual(suites);
    expect(output.e2e_tests).toBe("true");
    expect(output.e2e_suites).toBe(suites.join(","));
    expect(JSON.parse(output.e2e_suite_batches_json)).toEqual(batches);
  });

  it("routes context UI and API slices to owned E2E suites", () => {
    const baseDir = path.join(process.cwd(), "repo");
    const scope = classifyChanges({
      baseDir,
      changedFiles: [
        "bounded-contexts/discovery/features/search/ui/search-page.tsx",
        "bounded-contexts/checkout/features/cart/api/cart-routes.ts",
        "bounded-contexts/inventory/features/inventory/ui/account-inventory.tsx",
        "bounded-contexts/ordering/features/postage-policies/ui/postage-policy-detail-drawer.tsx",
        "bounded-contexts/identity/features/invitations/ui/invitation-detail-page.tsx",
      ],
      workspaces: [
        workspace(baseDir, "bounded-contexts", "discovery", "@test/discovery"),
        workspace(baseDir, "bounded-contexts", "checkout", "@test/checkout"),
        workspace(baseDir, "bounded-contexts", "inventory", "@test/inventory"),
        workspace(baseDir, "bounded-contexts", "ordering", "@test/ordering"),
        workspace(baseDir, "bounded-contexts", "identity", "@test/identity"),
      ],
    });

    expect(scope.e2eTestsRequired).toBe(true);
    expect(scope.e2eSuiteIds).toEqual([
      "marketplace_browse",
      "marketplace_checkout",
      "marketplace_seller",
      "admin_commerce",
      "admin_access",
    ]);
  });

  it("routes catalog admin integration routes to admin E2E", () => {
    const baseDir = path.join(process.cwd(), "repo");
    const scope = classifyChanges({
      baseDir,
      changedFiles: [
        "bounded-contexts/catalog/routes/admin/integrations.tsx",
        "deployables/admin-web/app/routes/catalog-layout.tsx",
      ],
      workspaces: [
        workspace(baseDir, "bounded-contexts", "catalog", "@test/catalog"),
        workspace(baseDir, "deployables", "admin-web", "@test/admin-web"),
      ],
    });

    expect(scope.e2eTestsRequired).toBe(true);
    expect(scope.e2eSuiteIds).toEqual([
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

  it("routes catalog admin modeling routes to modeling E2E", () => {
    const baseDir = path.join(process.cwd(), "repo");
    const scope = classifyChanges({
      baseDir,
      changedFiles: [
        "bounded-contexts/catalog/routes/admin/dimensions.tsx",
        "bounded-contexts/catalog/features/dimensions/ui/dimension-list-page.tsx",
      ],
      workspaces: [workspace(baseDir, "bounded-contexts", "catalog", "@test/catalog")],
    });

    expect(scope.e2eTestsRequired).toBe(true);
    expect(scope.e2eSuiteIds).toEqual(["catalog_admin_modeling"]);
  });

  it("routes support platform feedback admin routes to admin support E2E", () => {
    const baseDir = path.join(process.cwd(), "repo");
    const scope = classifyChanges({
      baseDir,
      changedFiles: ["bounded-contexts/platform-operations/routes/admin/platform-feedback.tsx"],
      workspaces: [workspace(baseDir, "bounded-contexts", "platform-operations", "@test/platform-operations")],
    });

    expect(scope.e2eTestsRequired).toBe(true);
    expect(scope.e2eSuiteIds).toEqual(["admin_support"]);
  });

  it("routes platform projection operations admin routes to admin platform E2E", () => {
    const baseDir = path.join(process.cwd(), "repo");
    const scope = classifyChanges({
      baseDir,
      changedFiles: ["bounded-contexts/platform-operations/routes/admin/projection-operations.tsx"],
      workspaces: [workspace(baseDir, "bounded-contexts", "platform-operations", "@test/platform-operations")],
    });

    expect(scope.e2eTestsRequired).toBe(true);
    expect(scope.e2eSuiteIds).toEqual(["admin_platform"]);
  });

  it("routes bounded-context marketplace and admin routes by owned journey", () => {
    const baseDir = path.join(process.cwd(), "repo");
    const marketplaceAccountScope = classifyChanges({
      baseDir,
      changedFiles: [
        "bounded-contexts/identity/routes/marketplace/account.tsx",
        "bounded-contexts/support/routes/marketplace/account-support.tsx",
        "bounded-contexts/marketplace/routes/marketplace/account-written-reviews.tsx",
      ],
      workspaces: [
        workspace(baseDir, "bounded-contexts", "identity", "@test/identity"),
        workspace(baseDir, "bounded-contexts", "support", "@test/support"),
        workspace(baseDir, "bounded-contexts", "marketplace", "@test/marketplace"),
      ],
    });

    expect(marketplaceAccountScope.e2eTestsRequired).toBe(true);
    expect(marketplaceAccountScope.e2eSuiteIds).toEqual(["marketplace_account"]);

    const adminScope = classifyChanges({
      baseDir,
      changedFiles: ["bounded-contexts/identity/routes/admin/users.tsx"],
      workspaces: [workspace(baseDir, "bounded-contexts", "identity", "@test/identity")],
    });

    expect(adminScope.e2eTestsRequired).toBe(true);
    expect(adminScope.e2eSuiteIds).toEqual(["admin_access"]);
  });

  it("routes milestone-25 decomposed routes to their owning E2E suites", () => {
    const baseDir = path.join(process.cwd(), "repo");
    const scope = classifyChanges({
      baseDir,
      changedFiles: [
        "bounded-contexts/discovery/routes/item-detail.tsx",
        "bounded-contexts/checkout/routes/sell-checkout-session.tsx",
        "bounded-contexts/payments/routes/marketplace/account-payment.tsx",
        "bounded-contexts/payments/routes/marketplace/checkout-payment.tsx",
      ],
      workspaces: [
        workspace(baseDir, "bounded-contexts", "discovery", "@test/discovery"),
        workspace(baseDir, "bounded-contexts", "checkout", "@test/checkout"),
        workspace(baseDir, "bounded-contexts", "payments", "@test/payments"),
      ],
    });

    expect(scope.e2eTestsRequired).toBe(true);
    expect(scope.e2eSuiteIds).toEqual(["marketplace_browse", "marketplace_checkout"]);
  });

  it("routes context changes to the consolidated marketplace seed DB acceptance suite", () => {
    const baseDir = path.join(process.cwd(), "repo");
    const scope = classifyChanges({
      baseDir,
      changedFiles: ["bounded-contexts/ordering/features/orders/domain/order.ts"],
      workspaces: [
        workspace(baseDir, "bounded-contexts", "ordering", "@test/ordering"),
        {
          ...workspace(baseDir, "deployables", "marketplace-seed-testing", "@test/marketplace-seed-testing", {
            "@test/ordering": "workspace:*",
          }),
          packageJson: {
            name: "@test/marketplace-seed-testing",
            dependencies: {
              "@test/ordering": "workspace:*",
            },
            chaseSets: { testProfile: "db" },
            scripts: { "test:db": "test:db" },
          },
        },
      ],
    });

    expect(scope.affectedWorkspaces).toEqual(["@test/ordering", "@test/marketplace-seed-testing"]);
    expect(scope.dbTestsRequired).toBe(true);
  });

  it("keeps workflow-only changes out of deployment but scopes platform-*.yml to a cluster preview", () => {
    const baseDir = path.join(process.cwd(), "repo");
    const scope = classifyChanges({
      baseDir,
      changedFiles: [".github/workflows/platform-pr.yml"],
      workspaces: [workspace(baseDir, "deployables", "public-web", "@test/public-web")],
    });

    expect(scope.workflowLintRequired).toBe(true);
    expect(scope.localChecksRequired).toBe(true);
    expect(scope.deployRequired).toBe(false);
    // #4864: a deploy-pipeline workflow file is a deploy surface even though
    // it never touches app code, so it still earns the real cluster preview
    // (this is also why this issue's own PR self-tests the new rule).
    expect(scope.clusterPreviewRequired).toBe(true);
    expect(scope.composeSmokeRequired).toBe(false);
  });

  it("keeps non-platform workflow changes off the cluster-preview surface", () => {
    const baseDir = path.join(process.cwd(), "repo");
    const scope = classifyChanges({
      baseDir,
      changedFiles: [".github/workflows/review-cadence-digest.yml"],
      workspaces: [workspace(baseDir, "deployables", "public-web", "@test/public-web")],
    });

    expect(scope.workflowLintRequired).toBe(true);
    expect(scope.deployRequired).toBe(false);
    expect(scope.clusterPreviewRequired).toBe(false);
    expect(scope.composeSmokeRequired).toBe(false);
  });

  it.each([
    [".github/workflows/platform-pr.yml", true],
    [".github/workflows/platform-ephemeral-verification.yml", false],
    [".github/workflows/platform-production.yml", false],
    [".github/workflows/platform-production-memory-probe.yml", false],
    [".github/workflows/platform-production-stale-helm-recovery.yml", false],
    [".github/workflows/platform-compose-boot-smoke.yml", false],
    [".github/workflows/platform-pr-scope.yml", false],
  ])("limits platform workflow cluster-preview admission to preview caller %s", (file, expected) => {
    expect(classifyChanges({ changedFiles: [file] }).clusterPreviewRequired, file).toBe(expected);
  });

  it.each([
    ["scripts/digitalocean-platform-config.mjs", true],
    ["scripts/digitalocean-platform-config.test.mjs", false],
    ["scripts/platform-smoke.mjs", true],
    ["scripts/platform-smoke.test.mjs", false],
    ["scripts/platform-smoke.spec.mjs", false],
  ])("keeps test-only DigitalOcean and platform-smoke paths off cluster preview: %s", (file, expected) => {
    expect(classifyChanges({ changedFiles: [file] }).clusterPreviewRequired, file).toBe(expected);
  });

  const clusterPreviewSafetyFixtures = [
    ["Helm", "infrastructure/helm/platform/values.yaml"],
    ["preview Terraform", "infrastructure/digitalocean/platform/main.tf"],
    ["Dockerfile", "Dockerfile"],
    ["deploy script", "scripts/platform-kubernetes-deployment.mjs"],
    ["secret script", "scripts/platform-kubernetes-secret.mjs"],
    ["ingress script", "scripts/platform-ingress-wait.mjs"],
    ["platform PR preview workflow", ".github/workflows/platform-pr.yml"],
  ];

  it("kills one recorded source safety mutant per deploy guard", async () => {
    const source = readFileSync(path.join(repoRoot, "scripts/change-scope.mjs"), "utf8");
    const predicateMutations = [
      ["helmChanged", "false ||"],
      ["previewDeployTerraformChanged", "false ||"],
      ["dockerChanged", "false ||"],
      ["clusterPreviewScriptChanged", "false ||"],
      ["clusterPreviewWorkflowChanged", "false;"],
    ];
    const mutantTable = [];
    const clusterBlockStart = source.indexOf("const clusterPreviewRequired =");
    const clusterBlockEnd = source.indexOf("const composeSmokeRequired", clusterBlockStart);
    const clusterBlock = source.slice(clusterBlockStart, clusterBlockEnd);
    for (const [guard, replacement] of predicateMutations) {
      const search = guard === "clusterPreviewWorkflowChanged" ? `${guard};` : `${guard} ||`;
      const mutatedBlock = clusterBlock.replace(search, replacement);
      const mutatedSource = `${source.slice(0, clusterBlockStart)}${mutatedBlock}${source.slice(clusterBlockEnd)}`;
      expect(mutatedSource, guard).not.toBe(source);
      const mutantClassifier = await importChangeScopeVariant(mutatedSource);
      const file = clusterPreviewSafetyFixtures.find(
        ([fixtureGuard]) =>
          fixtureGuard ===
          {
            helmChanged: "Helm",
            previewDeployTerraformChanged: "preview Terraform",
            dockerChanged: "Dockerfile",
            clusterPreviewScriptChanged: "deploy script",
            clusterPreviewWorkflowChanged: "platform PR preview workflow",
          }[guard],
      )?.[1];
      const baseline = classifyChanges({ changedFiles: [file] }).clusterPreviewRequired;
      const mutant = mutantClassifier.classifyChanges({ changedFiles: [file] }).clusterPreviewRequired;
      mutantTable.push({ guard, file, baseline, mutant, killed: baseline && !mutant });
    }

    expect(mutantTable.every(({ killed }) => killed)).toBe(true);
    console.info("cluster-preview safety mutant table", mutantTable);
  });

  it("preserves a compose-or-cluster gate for every runtime fixture", () => {
    const runtimeFixtures = [
      "deployables/platform-api/src/main.ts",
      "infrastructure/helm/platform/values.yaml",
      "infrastructure/digitalocean/platform/main.tf",
      "Dockerfile",
      "scripts/platform-kubernetes-deployment.mjs",
    ];
    const results = runtimeFixtures.map((file) => {
      const scope = classifyChanges({ changedFiles: [file] });
      return {
        file,
        composeSmoke: scope.composeSmokeRequired,
        clusterPreview: scope.clusterPreviewRequired,
        covered: scope.composeSmokeRequired || scope.clusterPreviewRequired,
      };
    });

    expect(results.every(({ covered }) => covered)).toBe(true);
    console.info("runtime gate coverage table", results);
  });

  it("treats Terraform and deployment helper changes as deployable infrastructure needing a cluster preview", () => {
    const baseDir = path.join(process.cwd(), "repo");
    const scope = classifyChanges({
      baseDir,
      changedFiles: ["infrastructure/digitalocean/platform/main.tf", "scripts/render-platform-helm-values.mjs"],
      workspaces: [workspace(baseDir, "deployables", "public-web", "@test/public-web")],
    });

    expect(scope.terraformRequired).toBe(true);
    expect(scope.deployRequired).toBe(true);
    expect(scope.dockerImageRequired).toBe(false);
    expect(scope.clusterPreviewRequired).toBe(true);
    expect(scope.composeSmokeRequired).toBe(false);
  });

  it("keeps DOKS-only Terraform changes on the plan-only lane, off the cluster-preview surface", () => {
    const baseDir = path.join(process.cwd(), "repo");
    const scope = classifyChanges({
      baseDir,
      changedFiles: ["infrastructure/digitalocean/doks/main.tf"],
      workspaces: [workspace(baseDir, "deployables", "public-web", "@test/public-web")],
    });

    expect(scope.terraformRequired).toBe(true);
    expect(scope.deployRequired).toBe(false);
    expect(scope.dockerImageRequired).toBe(false);
    expect(scope.clusterPreviewRequired).toBe(false);
    expect(scope.composeSmokeRequired).toBe(false);
  });

  it("routes Helm chart changes through ordinary staged deployment without a docker image", () => {
    const baseDir = path.join(process.cwd(), "repo");
    const scope = classifyChanges({
      baseDir,
      changedFiles: ["infrastructure/helm/platform/templates/deployment.yaml"],
      workspaces: [workspace(baseDir, "deployables", "public-web", "@test/public-web")],
    });

    expect(scope.workflowLintRequired).toBe(true);
    expect(scope.terraformRequired).toBe(false);
    expect(scope.deployRequired).toBe(true);
    expect(scope.dockerImageRequired).toBe(false);
    // #4864: Helm changes are a deploy surface in their own right, even
    // without a docker image, because they alter what the cluster preview
    // (and staging/production) actually deploys.
    expect(scope.clusterPreviewRequired).toBe(true);
    expect(scope.composeSmokeRequired).toBe(false);

    const docsScope = classifyChanges({
      baseDir,
      changedFiles: ["docs/runbooks/digitalocean-platform-deployment.md"],
      workspaces: [workspace(baseDir, "deployables", "public-web", "@test/public-web")],
    });
    expect(docsScope.docsOnly).toBe(true);
    expect(docsScope.deployRequired).toBe(false);
  });

  it("routes the platform Kubernetes Secret helper through workflow lint and a cluster preview without deploying", () => {
    const baseDir = path.join(process.cwd(), "repo");
    const scope = classifyChanges({
      baseDir,
      changedFiles: ["scripts/platform-kubernetes-secret.mjs"],
      workspaces: [workspace(baseDir, "deployables", "public-web", "@test/public-web")],
    });

    expect(scope.workflowLintRequired).toBe(true);
    expect(scope.localChecksRequired).toBe(true);
    expect(scope.deployRequired).toBe(false);
    expect(scope.dockerImageRequired).toBe(false);
    expect(scope.terraformRequired).toBe(false);
    // #4864: this script builds the runtime Secret every preview/staging/
    // production release applies, so a change here is env plumbing that
    // needs the real cluster preview, not just the dry-run in workflow lint.
    expect(scope.clusterPreviewRequired).toBe(true);
    expect(scope.composeSmokeRequired).toBe(false);
  });

  it("routes the platform ingress wait helper through workflow lint and a cluster preview without deploying", () => {
    const baseDir = path.join(process.cwd(), "repo");
    const scope = classifyChanges({
      baseDir,
      changedFiles: ["scripts/platform-ingress-wait.mjs"],
      workspaces: [workspace(baseDir, "deployables", "public-web", "@test/public-web")],
    });

    expect(scope.workflowLintRequired).toBe(true);
    expect(scope.localChecksRequired).toBe(true);
    expect(scope.deployRequired).toBe(false);
    expect(scope.dockerImageRequired).toBe(false);
    expect(scope.terraformRequired).toBe(false);
    expect(scope.clusterPreviewRequired).toBe(true);
    expect(scope.composeSmokeRequired).toBe(false);
  });

  it("routes DOKS and platform Kubernetes deploy script changes onto the cluster-preview surface", () => {
    const baseDir = path.join(process.cwd(), "repo");
    const scope = classifyChanges({
      baseDir,
      changedFiles: ["scripts/doks-cluster-addons.mjs", "scripts/platform-kubernetes-deployment.mjs"],
      workspaces: [workspace(baseDir, "deployables", "public-web", "@test/public-web")],
    });

    expect(scope.dockerImageRequired).toBe(false);
    expect(scope.clusterPreviewRequired).toBe(true);
    expect(scope.composeSmokeRequired).toBe(false);
  });

  it("classifies exposure-posture changes for targeted release gates", () => {
    const baseDir = path.join(process.cwd(), "repo");
    const scope = classifyChanges({
      baseDir,
      changedFiles: [
        "scripts/marketplace-tax-readiness-evidence.mjs",
        "scripts/marketplace-stripe-money-operations-evidence.mjs",
        "scripts/release-lock.mjs",
        "docs/adr/0002-adopt-ucp-for-agent-commerce.md",
      ],
      workspaces: [workspace(baseDir, "bounded-contexts", "platform-operations", "@test/platform-operations")],
    });

    expect(scope.exposurePostureChanged).toBe(true);
    expect(scope.exposurePostureCategories).toEqual([
      "live-money-provider",
      "rollout-policy",
      "tax-posture",
      "ucp-signed-write",
    ]);
    expect(JSON.parse(toOutputMap(scope).exposure_posture_categories_json)).toEqual(scope.exposurePostureCategories);
  });

  it.each([
    "scripts/release-lock-monitor.mjs",
    "scripts/release-lock-monitor.test.mjs",
    ".github/workflows/platform-production-lock-monitor.yml",
  ])("classifies %s as rollout policy", (file) => {
    expect(classifyChanges({ changedFiles: [file] }).exposurePostureCategories).toContain("rollout-policy");
  });
});
