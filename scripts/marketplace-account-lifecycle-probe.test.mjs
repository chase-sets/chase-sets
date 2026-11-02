import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { identitySeedIds } from "../contracts/identity-seed/ids.ts";
import { marketplaceBrowserE2eSeedContract } from "../deployables/marketplace/e2e/support/seed-contract.ts";
import { e2eSuiteById } from "./e2e-suites.mjs";
import {
  canonicalDigest,
  changedPathsOutsideProbe,
  classifyRun,
  decideProbe,
  evaluateCleanPrecondition,
  evaluateRetainedPrecondition,
  evaluateSeedReceipt,
  listedTests,
  postgresVolumeName,
  probeCiBranchMarker,
  probeExitCode,
  probeOwnedPaths,
  probeRuns,
  probeSuiteGrep,
  probeSuiteId,
  requiredSeedStreams,
  seedReceiptCatalogItemIds,
  seedReceiptIdentities,
  summarizePerTest,
  withRetainedPrecondition,
} from "./marketplace-account-lifecycle-probe.mjs";

const workflowPath = ".github/workflows/marketplace-account-lifecycle-probe.yml";

function report(tests, errors = []) {
  return {
    config: {},
    stats: { startTime: "2026-11-02T10:00:00.000Z" },
    errors,
    suites: [
      {
        title: "account.spec.ts",
        file: "account.spec.ts",
        specs: [],
        suites: [
          {
            title: "describe",
            specs: tests.map(({ title, status, results }) => ({
              title,
              file: "deployables/marketplace/e2e/account.spec.ts",
              tests: [{ projectName: "marketplace-chromium", status, results }],
            })),
          },
        ],
      },
    ],
  };
}

function result(status, startTime, duration, messages = []) {
  return { retry: 0, status, startTime, duration, errors: messages.map((message) => ({ message })) };
}

const passingReport = report([
  {
    title: "buyer signs in @marketplace-account",
    status: "expected",
    results: [result("passed", "2026-11-02T10:01:00.000Z", 5_000)],
  },
  {
    title: "seller signs in @marketplace-account",
    status: "flaky",
    results: [
      result("failed", "2026-11-02T10:02:00.000Z", 4_000, ["transient"]),
      { ...result("passed", "2026-11-02T10:03:00.000Z", 6_000), retry: 1 },
    ],
  },
]);

function seedStreams() {
  return requiredSeedStreams().map(({ streamId }, index) => ({
    contextName: streamId.split(".")[0],
    streamId,
    events: 3,
    version: 3,
    firstEventId: `evt_${index}`,
    firstEventType: "Created",
  }));
}

const completeSeed = evaluateSeedReceipt({
  contexts: [
    { contextName: "catalog", categories: [{ category: "item", events: 30, streams: 10 }] },
    { contextName: "identity", categories: [{ category: "user", events: 6, streams: 2 }] },
  ],
  streams: seedStreams(),
});

function lifecycle(overrides = {}) {
  return {
    schemaVersion: 1,
    kind: "browser-e2e-service-lifecycle",
    target: "browser-e2e",
    services: [
      {
        name: "bootstrap-app-platform-api",
        spawnedAt: "2026-11-02T09:58:00.000Z",
        status: "exited",
        exitedAt: "2026-11-02T09:58:45.000Z",
        exitCode: 0,
        signal: null,
      },
      {
        name: "platform-api",
        spawnedAt: "2026-11-02T09:59:00.000Z",
        status: "exited",
        exitedAt: "2026-11-02T10:05:00.000Z",
        exitCode: null,
        signal: "SIGTERM",
      },
    ],
    ...overrides,
  };
}

const readyReadiness = {
  schemaVersion: 1,
  kind: "browser-e2e-readiness",
  target: "browser-e2e",
  outcome: "ready",
  completedAt: "2026-11-02T10:00:30.000Z",
};

function passingInput(overrides = {}) {
  return {
    suiteExitCode: 0,
    lifecycle: lifecycle(),
    readiness: readyReadiness,
    workerLogBytes: 512,
    ciBranchObserved: true,
    seedReceipt: completeSeed,
    perTest: summarizePerTest(passingReport),
    listedCount: 2,
    productTreeUnchanged: true,
    ...overrides,
  };
}

describe("marketplace account lifecycle probe pins", () => {
  it("signs in with the canonical seeded buyer and seller identities", () => {
    for (const [role, seed] of [
      ["buyer", identitySeedIds.collector],
      ["seller", identitySeedIds.demo],
    ]) {
      expect(seedReceiptIdentities[role]).toEqual({
        email: marketplaceBrowserE2eSeedContract[role].email,
        accountId: seed.accountId,
        userId: seed.userId,
        membershipId: seed.membershipId,
      });
    }
    expect(seedReceiptCatalogItemIds).toEqual(marketplaceBrowserE2eSeedContract.browse.itemCatalogIds);
  });

  it("runs the registered marketplace_account suite unchanged", () => {
    expect(probeSuiteId).toBe("marketplace_account");
    expect(e2eSuiteById(probeSuiteId).grep).toBe(probeSuiteGrep);
    expect(probeRuns.map(({ mode, directory }) => [mode, directory])).toEqual([
      ["clean", "run-1-clean"],
      ["retained", "run-2-retained"],
    ]);
  });

  it("keeps the workflow probe-only, path-filtered, non-required and CI=true development-target", () => {
    const workflow = parse(readFileSync(workflowPath, "utf8"));
    expect(Object.keys(workflow.on)).toEqual(["pull_request"]);
    expect(workflow.on.pull_request.paths.every((entry) => probeOwnedPaths.includes(entry))).toBe(true);
    expect(workflow.permissions).toEqual({ contents: "read" });
    const job = workflow.jobs.probe;
    expect(job["runs-on"]).toBe("ubuntu-24.04");
    expect(job.env).toMatchObject({ CI: "true", CHASE_SETS_BROWSER_E2E_SYSTEM: "development" });
    const checkout = job.steps[0];
    expect(checkout.with).toMatchObject({ "fetch-depth": 2, "persist-credentials": false });
    const probe = job.steps.find((step) => step.id === "probe");
    expect(probe.run).toBe(
      "node scripts/marketplace-account-lifecycle-probe.mjs --out-dir artifacts/marketplace-account-lifecycle-probe",
    );
    const upload = job.steps.at(-1);
    expect(upload.if).toBe("always()");
    expect(upload.with).toMatchObject({
      path: "artifacts/marketplace-account-lifecycle-probe",
      "if-no-files-found": "error",
    });
    expect(job.steps.some((step) => /dev:bootstrap|dev:db:refresh|down -v/.test(step.run ?? ""))).toBe(false);
  });

  it("names the compose postgres volume the clean and retained joins inspect", () => {
    expect(postgresVolumeName("chase-sets-abc12345")).toBe("chase-sets-abc12345_chase-sets-postgres-dev-data");
    expect(readFileSync("docker-compose.dev.yml", "utf8")).toContain(
      "chase-sets-postgres-dev-data:/var/lib/postgresql/data",
    );
  });
});

describe("marketplace account lifecycle probe joins", () => {
  it("rejects any head change outside the probe paths", () => {
    expect(changedPathsOutsideProbe([...probeOwnedPaths])).toEqual([]);
    expect(changedPathsOutsideProbe([...probeOwnedPaths, "playwright.config.ts"])).toEqual(["playwright.config.ts"]);
  });

  it("summarizes per-test outcomes, the last result end and sign-in 401 failures", () => {
    const perTest = summarizePerTest(
      report([
        ...passingReport.suites[0].suites[0].specs.map((spec) => ({
          title: spec.title,
          status: spec.tests[0].status,
          results: spec.tests[0].results,
        })),
        {
          title: "seeded seller form @marketplace-account",
          status: "unexpected",
          results: [
            result("failed", "2026-11-02T10:04:00.000Z", 2_000, [
              "password sign-in should start a session (account=sha256:abc, status=401)",
            ]),
          ],
        },
        { title: "skipped @marketplace-account", status: "skipped", results: [result("skipped", null, 0)] },
      ]),
    );
    expect(perTest.counts).toEqual({ total: 4, executed: 4, expected: 1, unexpected: 1, flaky: 1, skipped: 1 });
    expect(perTest.testsEndedAt).toBe("2026-11-02T10:04:02.000Z");
    expect(perTest.signInFailures).toEqual([
      {
        file: "deployables/marketplace/e2e/account.spec.ts",
        title: "seeded seller form @marketplace-account",
        project: "marketplace-chromium",
      },
    ]);
  });

  it("orders the listed suite identity so equal suites share a digest", () => {
    const listed = listedTests(passingReport);
    expect(listed.map((test) => test.title)).toEqual([
      "buyer signs in @marketplace-account",
      "seller signs in @marketplace-account",
    ]);
    const reversed = structuredClone(passingReport);
    reversed.suites[0].suites[0].specs.reverse();
    expect(canonicalDigest(listedTests(reversed))).toBe(canonicalDigest(listed));
  });

  it("requires every seeded identity stream and every context, not presence of some rows", () => {
    expect(completeSeed.complete).toBe(true);
    const partial = evaluateSeedReceipt({
      contexts: [{ contextName: "identity", categories: [] }],
      streams: seedStreams().filter((stream) => stream.streamId !== "identity.user-usr_seed_demo_user"),
    });
    expect(partial).toMatchObject({ complete: false, missingStreams: ["identity.user-usr_seed_demo_user"] });
    const unreachable = evaluateSeedReceipt({
      contexts: [{ contextName: "auth", error: "connect ECONNREFUSED" }],
      streams: seedStreams(),
    });
    expect(unreachable).toMatchObject({ complete: false, unreachableContexts: ["auth"] });
    const empty = evaluateSeedReceipt({
      contexts: [],
      streams: seedStreams().map((stream) => ({ ...stream, events: 0 })),
    });
    expect(empty.complete).toBe(false);
  });

  it("refuses a pre-seeded clean run", () => {
    const project = "chase-sets-abc12345";
    expect(
      evaluateCleanPrecondition({ volumeNames: ["other"], composeProjectName: project, browserE2eRunsPresent: false }),
    ).toEqual({ proven: true, reasons: [] });
    expect(
      evaluateCleanPrecondition({
        volumeNames: [postgresVolumeName(project)],
        composeProjectName: project,
        browserE2eRunsPresent: true,
      }).reasons,
    ).toHaveLength(2);
  });

  it("proves the retained run used Run 1's volume and seeded aggregates", () => {
    const volume = { present: true, name: "v", createdAt: "2026-11-02T10:00:00Z" };
    const input = {
      run1Volume: volume,
      afterDownVolume: volume,
      beforeRun2Volume: volume,
      run1Seed: completeSeed,
      run2Seed: completeSeed,
    };
    expect(evaluateRetainedPrecondition(input)).toEqual({ proven: true, run1SeedComplete: true, reasons: [] });
    expect(
      evaluateRetainedPrecondition({ ...input, beforeRun2Volume: { ...volume, createdAt: "2026-11-02T10:20:00Z" } })
        .reasons,
    ).toEqual(["Run 2 did not start on Run 1's volume"]);
    expect(evaluateRetainedPrecondition({ ...input, afterDownVolume: { present: false } }).reasons).toEqual([
      "dev:down did not keep Run 1's volume",
    ]);
    const reseeded = {
      ...completeSeed,
      identities: completeSeed.identities.map((identity) => ({
        ...identity,
        firstEventId: `${identity.firstEventId}x`,
      })),
    };
    expect(evaluateRetainedPrecondition({ ...input, run2Seed: reseeded }).reasons[0]).toMatch(
      /^retained seed identities changed: identity\.account-acc_seed_collector_account/,
    );
    const partialRun1 = {
      ...completeSeed,
      complete: false,
      identities: completeSeed.identities.map((identity, index) =>
        index === 0 ? { ...identity, firstEventId: null } : identity,
      ),
    };
    expect(evaluateRetainedPrecondition({ ...input, run1Seed: partialRun1 })).toEqual({
      proven: true,
      run1SeedComplete: false,
      reasons: [],
    });
    expect(evaluateRetainedPrecondition({ ...input, run2Seed: null }).proven).toBe(false);
  });
});

describe("marketplace account lifecycle probe classification", () => {
  it("passes a run whose evidence joins and whose suite passed", () => {
    const classification = classifyRun(passingInput());
    expect(classification).toMatchObject({ verdict: "pass", firstCausalEdge: null });
    expect(classification.firstChildExit).toMatchObject({ name: "bootstrap-app-platform-api", exitCode: 0 });
  });

  it.each([
    ["product-tree", "invalid", { productTreeUnchanged: false }],
    ["lifecycle-evidence", "invalid", { lifecycle: lifecycle({ target: "browser-e2e-production" }) }],
    ["readiness-evidence", "invalid", { readiness: null }],
    [
      "startup",
      "fail",
      {
        lifecycle: lifecycle({
          services: [
            { name: "bootstrap-app-platform-api", status: "exited", exitedAt: "2026-11-02T09:59:00Z", exitCode: 1 },
          ],
        }),
        readiness: { ...readyReadiness, outcome: "failed" },
      },
    ],
    ["readiness", "fail", { readiness: { ...readyReadiness, outcome: "failed" } }],
    ["ci-branch", "invalid", { ciBranchObserved: false }],
    ["worker-evidence", "invalid", { workerLogBytes: 0 }],
    ["seed-evidence", "invalid", { seedReceipt: null }],
    ["seed", "fail", { seedReceipt: { ...completeSeed, complete: false } }],
    ["per-test-evidence", "invalid", { perTest: null }],
    [
      "post-readiness-loss",
      "fail",
      {
        lifecycle: lifecycle({
          services: [
            ...lifecycle().services.slice(0, 1),
            { name: "platform-api", status: "exited", exitedAt: "2026-11-02T10:02:30.000Z", exitCode: 1, signal: null },
          ],
        }),
      },
    ],
    ["zero-specs", "fail", { listedCount: 3 }],
    ["zero-specs", "fail", { perTest: summarizePerTest(report([])), listedCount: 0 }],
    [
      "sign-in",
      "fail",
      {
        suiteExitCode: 1,
        perTest: summarizePerTest(
          report([
            {
              title: "buyer @marketplace-account",
              status: "unexpected",
              results: [result("failed", "2026-11-02T10:01:00.000Z", 1_000, ["status=401"])],
            },
            {
              title: "seller @marketplace-account",
              status: "expected",
              results: [result("passed", "2026-11-02T10:02:00.000Z", 1_000)],
            },
          ]),
        ),
      },
    ],
    ["suite", "fail", { suiteExitCode: 1 }],
  ])("stops at the first causal edge %s (%s)", (edge, verdict, overrides) => {
    expect(classifyRun(passingInput(overrides))).toMatchObject({ verdict, firstCausalEdge: edge });
  });

  it("marks an unproven retained precondition invalid without hiding an earlier invalid verdict", () => {
    const summary = { index: 2, mode: "retained", classification: classifyRun(passingInput()) };
    expect(withRetainedPrecondition(summary, { proven: true, reasons: [] }).classification.verdict).toBe("pass");
    expect(withRetainedPrecondition(summary, { proven: false, reasons: ["x"] }).classification).toMatchObject({
      verdict: "invalid",
      firstCausalEdge: "retained-precondition",
    });
    const invalid = { ...summary, classification: classifyRun(passingInput({ ciBranchObserved: false })) };
    expect(withRetainedPrecondition(invalid, { proven: false, reasons: ["x"] }).classification.firstCausalEdge).toBe(
      "ci-branch",
    );
  });

  it("applies the stop conditions first-match: invalid, then a failed control, then both pass", () => {
    const run = (index, verdict, firstCausalEdge = null) => ({
      index,
      mode: probeRuns[index - 1].mode,
      classification: { verdict, firstCausalEdge },
    });
    expect(decideProbe({ invalidReasons: [], runs: [run(1, "pass"), run(2, "pass")] }).decision).toBe("BOTH_PASS");
    expect(decideProbe({ invalidReasons: [], runs: [run(1, "fail", "seed"), run(2, "pass")] })).toMatchObject({
      decision: "CONTROL_FAILED",
      reasons: ["run 1 (clean) failed at seed"],
    });
    expect(
      decideProbe({ invalidReasons: [], runs: [run(1, "fail", "seed"), run(2, "invalid", "retained-precondition")] })
        .decision,
    ).toBe("INVALID_CONTROL");
    expect(decideProbe({ invalidReasons: ["pre-seeded"], runs: [] }).decision).toBe("INVALID_CONTROL");
    expect(decideProbe({ invalidReasons: [], runs: [run(1, "pass")] }).decision).toBe("INVALID_CONTROL");
    expect([probeExitCode("BOTH_PASS"), probeExitCode("CONTROL_FAILED"), probeExitCode("INVALID_CONTROL")]).toEqual([
      0, 2, 3,
    ]);
  });

  it("detects the CI-only projection-wake branch by the launcher's own log line", () => {
    expect(readFileSync("scripts/dev-system.mjs", "utf8")).toContain(`\`${probeCiBranchMarker} \${primedCount}`);
  });
});
