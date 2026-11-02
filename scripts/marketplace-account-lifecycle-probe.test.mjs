import { existsSync, readFileSync } from "node:fs";
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
  evaluateRepairedHead,
  evaluateRetainedPrecondition,
  evaluateSeedReceipt,
  listedTests,
  postgresVolumeName,
  probeBaseline,
  probeCiBranchMarker,
  probeExitCode,
  probeModeFor,
  probeOwnedPaths,
  probeRepairPaths,
  probeRepairSupportPaths,
  probeRuns,
  probeSuiteGrep,
  probeSuiteId,
  requiredSeedStreams,
  seedReceiptCatalogItemIds,
  seedReceiptIdentities,
  summarizePerTest,
  withRetainedPrecondition,
} from "./marketplace-account-lifecycle-probe.mjs";
import { releaseQualificationScopeRegistry } from "./release-qualification-scope.mjs";

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
    expect(checkout.with).toMatchObject({ "fetch-depth": 0, "persist-credentials": false });
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
    expect(releaseQualificationScopeRegistry.workflows["marketplace-account-lifecycle-probe.yml"]).toBe("ci");
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

  it("pins the immutable baseline classification and chooses the mode by the checked-out head alone", () => {
    expect(probeBaseline).toEqual({
      head: "be20aeed5f3108b1106676572c80bd7f823ae194",
      runId: "41403552667",
      jobId: "125140419898",
      artifactId: "13123187369",
      artifactSha256: "803f3aa0d5024ca129475f9a574d2e96e393c8ada4b8e6f3ffb3d4992f873093",
      decision: "CONTROL_FAILED",
    });
    expect(Object.isFrozen(probeBaseline)).toBe(true);
    expect(probeModeFor(probeBaseline.head)).toBe("baseline");
    expect(probeModeFor("0".repeat(40))).toBe("repaired");
    expect(probeModeFor(probeBaseline.head.toUpperCase())).toBe("repaired");
  });

  it("joins a repaired head to the baseline and to the bound repair footprint only", () => {
    const repairHead = "1".repeat(40);
    const footprint = [...probeOwnedPaths, ...probeRepairPaths, ...probeRepairSupportPaths];
    for (const repairPath of [...probeRepairPaths, ...probeRepairSupportPaths])
      expect(existsSync(repairPath)).toBe(true);
    expect(evaluateRepairedHead({ head: repairHead, baselineIsAncestor: true, changedPaths: footprint })).toEqual({
      proven: true,
      reasons: [],
    });
    expect(
      evaluateRepairedHead({ head: repairHead, baselineIsAncestor: true, changedPaths: [probeRepairPaths[2]] }).proven,
    ).toBe(true);
    const outsidePath = "deployables/marketplace/playwright.config.ts";
    const refusals = [
      [{ head: probeBaseline.head, baselineIsAncestor: true, changedPaths: footprint }, "ran at the baseline head"],
      [{ head: repairHead, baselineIsAncestor: false, changedPaths: footprint }, "is not an ancestor"],
      [
        { head: repairHead, baselineIsAncestor: true, changedPaths: [...footprint, outsidePath] },
        `beyond the bound repair footprint: ${outsidePath}`,
      ],
      [
        { head: repairHead, baselineIsAncestor: true, changedPaths: [...probeOwnedPaths, ...probeRepairSupportPaths] },
        "changes no repair path",
      ],
      [{ head: repairHead, baselineIsAncestor: true, changedPaths: [] }, "changes no repair path"],
    ];
    for (const [input, reason] of refusals) {
      const result = evaluateRepairedHead(input);
      expect(result.proven).toBe(false);
      expect(result.reasons.join("; ")).toContain(reason);
    }
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
    const baseline = (input) => decideProbe({ mode: "baseline", ...input });
    expect(baseline({ invalidReasons: [], runs: [run(1, "pass"), run(2, "pass")] }).decision).toBe("BOTH_PASS");
    expect(baseline({ invalidReasons: [], runs: [run(1, "fail", "seed"), run(2, "pass")] })).toMatchObject({
      decision: "CONTROL_FAILED",
      reasons: ["run 1 (clean) failed at seed"],
    });
    expect(
      baseline({ invalidReasons: [], runs: [run(1, "fail", "seed"), run(2, "invalid", "retained-precondition")] })
        .decision,
    ).toBe("INVALID_CONTROL");
    expect(baseline({ invalidReasons: ["pre-seeded"], runs: [] }).decision).toBe("INVALID_CONTROL");
    expect(baseline({ invalidReasons: [], runs: [run(1, "pass")] }).decision).toBe("INVALID_CONTROL");
    expect([probeExitCode("BOTH_PASS"), probeExitCode("CONTROL_FAILED"), probeExitCode("INVALID_CONTROL")]).toEqual([
      0, 2, 3,
    ]);
  });

  it("gives a repaired head only its own verdict: pass on both runs, otherwise fail or invalid, never a baseline decision", () => {
    const run = (index, verdict, firstCausalEdge = null) => ({
      index,
      mode: probeRuns[index - 1].mode,
      classification: { verdict, firstCausalEdge },
    });
    const repaired = (input) => decideProbe({ mode: "repaired", ...input });
    expect(repaired({ invalidReasons: [], runs: [run(1, "pass"), run(2, "pass")] }).decision).toBe("REPAIRED_PASS");
    expect(repaired({ invalidReasons: [], runs: [run(1, "pass"), run(2, "fail", "suite")] })).toMatchObject({
      decision: "REPAIRED_FAIL",
      reasons: ["run 2 (retained) failed at suite"],
    });
    expect(
      repaired({ invalidReasons: [], runs: [run(1, "fail", "sign-in"), run(2, "fail", "suite")] }).reasons,
    ).toEqual(["run 1 (clean) failed at sign-in", "run 2 (retained) failed at suite"]);
    expect(repaired({ invalidReasons: ["wrong head"], runs: [run(1, "pass"), run(2, "pass")] }).decision).toBe(
      "INVALID_CONTROL",
    );
    expect(repaired({ invalidReasons: [], runs: [run(1, "pass")] }).decision).toBe("INVALID_CONTROL");
    for (const runs of [
      [run(1, "pass"), run(2, "pass")],
      [run(1, "fail", "seed"), run(2, "pass")],
    ])
      expect(["BOTH_PASS", "CONTROL_FAILED"]).not.toContain(repaired({ invalidReasons: [], runs }).decision);
    expect(() => decideProbe({ invalidReasons: [], runs: [] })).toThrow("Unknown probe mode");
    expect([probeExitCode("REPAIRED_PASS"), probeExitCode("REPAIRED_FAIL")]).toEqual([0, 2]);
  });

  it("detects the CI-only projection-wake branch by the launcher's own log line", () => {
    expect(readFileSync("scripts/dev-system.mjs", "utf8")).toContain(`\`${probeCiBranchMarker} \${primedCount}`);
  });
});
