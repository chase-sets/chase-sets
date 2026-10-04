import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  adjudicateProbe,
  compareProbes,
  localOrigin,
  main,
  prepareProbe,
  validatePreflight,
} from "./browser-usability.mjs";
import {
  auditBrowserUsabilityRoutes,
  browserUsabilityGoal,
  browserUsabilityGoalModules,
  browserUsabilityGoals,
  selectBrowserUsabilityGoals,
  validateBrowserUsabilityGoalModules,
} from "./browser-usability-goals.mjs";
import { createBrowserUsabilitySession } from "./browser-usability-session.mjs";

const head = "a".repeat(40);
const origin = "http://localhost:9753";
const roots = [];
function fixture(goalId = "find-card") {
  const root = mkdtempSync(path.join(os.tmpdir(), "browser-usability-"));
  roots.push(root);
  writeFileSync(path.join(root, "proof.txt"), "synthetic independent fixture evidence\n");
  const preflight = {
    head,
    origin,
    role: browserUsabilityGoal(goalId).role,
    environment: "isolated-synthetic",
    observedAt: new Date().toISOString(),
    fixtureId: "fixture-v1",
    harness: "cua-test-v1",
    viewport: "1280x720",
    locale: "en-US",
    timezone: "UTC",
    cachePolicy: "warm",
    taskContext: "Signed-in synthetic buyer.",
    checks: Object.fromEntries(
      ["services", "projections", "fixture", "exclusiveSession"].map((key) => [
        key,
        { status: "pass", evidence: "proof.txt" },
      ]),
    ),
  };
  const directory = path.join(root, "run");
  const manifest = prepareProbe({ goalId, origin, preflight, evidenceDirectory: root, directory, head });
  return { root, directory, preflight, manifest };
}
function tab() {
  return {
    goto: vi.fn(),
    close: vi.fn(),
    click: vi.fn(),
    typeText: vi.fn(),
    getScreenshot: vi.fn(async () => Buffer.from("synthetic screenshot")),
    getAXState: vi.fn(async () => "visible state"),
  };
}
function evidence(f, verdict = "verified-complete") {
  return {
    runId: f.manifest.runId,
    head,
    reviewer: "independent-moderator",
    verdict,
    runSha256: createHash("sha256")
      .update(readFileSync(path.join(f.directory, "run.json")))
      .digest("hex"),
    checks: Object.fromEntries(
      ["variant", "availability-and-price"].map((id) => [
        id,
        { status: "pass", reason: "Independently observed synthetic fixture.", evidence: "proof.txt" },
      ]),
    ),
  };
}
afterEach(() => {
  vi.useRealTimers();
  // Each root is created by mkdtemp above, never derived from user input.
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("goal selection and preflight", () => {
  it("opts only the four existing goals into shared selection and selects new goals by prefix or exact route", () => {
    const extra = {
      id: "fixture-goal",
      paths: ["fixture/features/", "packages/design-system/"],
      routes: { "fixture/route.tsx": "outcome", "packages/design-system/src/button.tsx": "outcome" },
    };
    const goals = [...browserUsabilityGoals, extra];
    expect(
      selectBrowserUsabilityGoals(["packages/design-system/src/button.tsx"], goals)
        .map((goal) => goal.id)
        .sort(),
    ).toEqual(["buyer-shipment", "condition-policy", "find-card", "seller-away"]);
    expect(selectBrowserUsabilityGoals(["fixture/features/action.mjs"], goals)).toEqual([extra]);
    expect(selectBrowserUsabilityGoals(["fixture/route.tsx"], goals)).toEqual([extra]);
    expect(selectBrowserUsabilityGoals(["fixture/route.tsx.extra"], goals)).toEqual([]);
  });
  it.each(["find-card", "seller-away", "fixture-permits"])(
    "writes ordered goal permissions without moderator oracle or routes for %s",
    (goalId) => {
      const synthetic = {
        ...browserUsabilityGoals.find((goal) => goal.id === "seller-away"),
        id: "fixture-permits",
        permits: "You may schedule time away for the dates in your task context.",
      };
      if (goalId === synthetic.id) browserUsabilityGoals.push(synthetic);
      try {
        const f = fixture(goalId);
        const brief = readFileSync(path.join(f.directory, "participant.md"), "utf8");
        const readOnly =
          "Read-only by default: no purchases, messages, reviews, reports, or account, listing, or settings changes.";
        const boundary =
          "Never confirm a payment, buy postage, publish or sync to an external channel, send a message, or submit a password or other credential. Stop at the last screen before any of these and report what it would do.";
        expect(brief).toContain(readOnly);
        expect(brief.indexOf(boundary)).toBeGreaterThan(brief.indexOf(readOnly));
        const uncertainty = "Stop on uncertainty rather than expanding scope.";
        expect(brief).toContain(uncertainty);
        expect(brief.indexOf(uncertainty)).toBeGreaterThan(brief.indexOf(boundary));
        const goal = browserUsabilityGoal(goalId);
        if (goal.permits) {
          const exception = `Exception for this goal only: ${goal.permits} The moderator restores it afterwards.`;
          expect(brief.indexOf(exception)).toBeGreaterThan(brief.indexOf(readOnly));
          expect(brief.indexOf(exception)).toBeLessThan(brief.indexOf(boundary));
        } else expect(brief).not.toContain("Exception for this goal only:");
        expect(brief).not.toContain("Only the seller-away goal");
        expect(brief).not.toContain("Do not enter credentials");
        expect(brief).not.toContain('"oracle"');
        expect(brief).not.toContain('"routes"');
        for (const value of Object.values(goal.oracle)) expect(brief).not.toContain(value);
        for (const route of Object.keys(goal.routes)) expect(brief).not.toContain(route);
      } finally {
        if (goalId === synthetic.id) browserUsabilityGoals.pop();
      }
    },
  );
  it("selects owning flows and broadens shared UI changes, not unrelated runtime work", () => {
    expect(selectBrowserUsabilityGoals(["bounded-contexts/fulfillment/features/x.ts"]).map((g) => g.id)).toEqual([
      "buyer-shipment",
    ]);
    expect(selectBrowserUsabilityGoals(["packages/design-system/src/button.tsx"])).toHaveLength(4);
    expect(selectBrowserUsabilityGoals(["infrastructure/subscriptions.ts"])).toEqual([]);
  });
  it.each([
    "https://staging.chasesets.com",
    "http://localhost.evil.test",
    "http://user:pass@localhost:9753",
    "http://localhost:9753/path",
    "http://localhost:9753?token=x",
  ])("rejects unsafe origin %s", (url) => {
    expect(() => localOrigin(url)).toThrow();
  });
  it("requires fresh matching fixture, role, commit and healthy projections", () => {
    const { preflight } = fixture();
    const options = { head, origin, role: "buyer" };
    expect(() => validatePreflight(preflight, options)).not.toThrow();
    for (const patch of [
      { head: "b".repeat(40) },
      { role: "seller" },
      { environment: "staging" },
      { observedAt: "bad" },
      { observedAt: "2000-01-01" },
    ]) {
      expect(() => validatePreflight({ ...preflight, ...patch }, options)).toThrow();
    }
    preflight.checks.projections.status = "unknown";
    expect(() => validatePreflight(preflight, options)).toThrow(/projections/);
  });
  it("separates goal-only brief from private checks and refuses overwritten runs", () => {
    const f = fixture();
    const brief = readFileSync(path.join(f.directory, "participant.md"), "utf8");
    expect(brief).not.toContain("availability-and-price");
    expect(brief).not.toContain("proof.txt");
    expect(() =>
      prepareProbe({
        goalId: "find-card",
        origin,
        preflight: f.preflight,
        evidenceDirectory: f.root,
        directory: f.directory,
        head,
      }),
    ).toThrow(/new output/);
  });
  it("refuses missing and path-escaping evidence", () => {
    const f = fixture();
    f.preflight.checks.fixture.evidence = "missing.txt";
    expect(() =>
      prepareProbe({
        goalId: "find-card",
        origin,
        preflight: f.preflight,
        evidenceDirectory: f.root,
        directory: path.join(f.root, "other"),
        head,
      }),
    ).toThrow();
    f.preflight.checks.fixture.evidence = path.join(f.root, "proof.txt");
    expect(() =>
      prepareProbe({
        goalId: "find-card",
        origin,
        preflight: f.preflight,
        evidenceDirectory: f.root,
        directory: path.join(f.root, "other"),
        head,
      }),
    ).toThrow(/relative/);
  });
});

describe("surface contracts and coverage", () => {
  const modules = () => structuredClone(browserUsabilityGoalModules);
  it("validates all five shipped modules and defaults moderator authentication by role", () => {
    expect(() => validateBrowserUsabilityGoalModules(modules())).not.toThrow();
    expect(browserUsabilityGoal("condition-policy").startSignedIn).toBe(false);
    expect(browserUsabilityGoal("find-card").startSignedIn).toBe(true);
    expect(browserUsabilityGoal("seller-away").startSignedIn).toBe(true);
  });
  it.each([
    ["Duplicate goal id", (m) => m[1].goals.push(structuredClone(m[1].goals[0]))],
    [
      "Invalid role",
      (m) => {
        m[0].goals[0].role = "admin";
      },
    ],
    [
      "Invalid host",
      (m) => {
        m[0].goals[0].host = "external";
      },
    ],
    [
      "Missing oracle",
      (m) => {
        delete m[0].goals[0].oracle.deadline;
      },
    ],
    [
      "Missing oracle",
      (m) => {
        m[0].goals[0].oracle.deadline = " ";
      },
    ],
    [
      "Missing oracle",
      (m) => {
        m[0].goals[0].oracle.deadline = 1;
      },
    ],
    [
      "Extra oracle key",
      (m) => {
        m[0].goals[0].oracle.extra = "private";
      },
    ],
    [
      "Route outside scope",
      (m) => {
        m[0].goals[0].routes["bounded-contexts/ordering/routes/account-purchase.tsx"] = "deadline";
      },
    ],
    [
      "Route maps to unknown check",
      (m) => {
        m[0].goals[0].routes["bounded-contexts/public-presence/routes/marketplace/help.tsx"] = "extra";
      },
    ],
    [
      "Paths must be non-empty",
      (m) => {
        m[0].goals[0].paths = [];
      },
    ],
    [
      "Paths must be non-empty",
      (m) => {
        m[0].goals[0].paths = [""];
      },
    ],
    [
      "startSignedIn must be a boolean",
      (m) => {
        m[0].goals[0].startSignedIn = "false";
      },
    ],
    [
      "Goal text contains a URL path token",
      (m) => {
        m[0].goals[0].goal += " Visit /help.";
      },
    ],
    [
      "Exclusion outside scope",
      (m) => {
        m[0].excludedRoutes = [
          { path: "bounded-contexts/ordering/routes/account-purchase.tsx", reason: "layout-only" },
        ];
      },
    ],
    [
      "Invalid exclusion reason",
      (m) => {
        m[0].excludedRoutes = [
          { path: "bounded-contexts/public-presence/routes/marketplace/home.tsx", reason: "not-needed" },
        ];
      },
    ],
    [
      "Invalid exclusion reason",
      (m) => {
        m[0].excludedRoutes = [
          { path: "bounded-contexts/public-presence/routes/marketplace/home.tsx", reason: "fixture-gap: " },
        ];
      },
    ],
    [
      "Route both claimed and excluded",
      (m) => {
        m[0].excludedRoutes = [
          { path: "bounded-contexts/public-presence/routes/marketplace/help.tsx", reason: "layout-only" },
        ];
      },
    ],
  ])("rejects %s with a named message (%#)", (message, mutate) => {
    const candidate = modules();
    mutate(candidate);
    expect(() => validateBrowserUsabilityGoalModules(candidate)).toThrow(message);
  });
  it.each(["layout-only", "redirect-only", "error-page", "provider-step-only", "fixture-gap: missing synthetic state"])(
    "accepts exclusion reason %s",
    (reason) => {
      const candidate = modules();
      candidate[0].excludedRoutes = [{ path: "bounded-contexts/public-presence/routes/marketplace/home.tsx", reason }];
      expect(() => validateBrowserUsabilityGoalModules(candidate)).not.toThrow();
    },
  );
  it("accepts operator roles, all hosts, and an explicit signed-out non-guest", () => {
    for (const host of ["marketplace", "public-web", "admin-web"]) {
      const candidate = modules();
      Object.assign(candidate[0].goals[0], { role: "operator", host, startSignedIn: false });
      expect(() => validateBrowserUsabilityGoalModules(candidate)).not.toThrow();
    }
  });
  it("reports unscoped and doubly scoped route fixtures and ignores tests and non-routes", () => {
    const candidate = modules();
    const route = "bounded-contexts/public-presence/routes/marketplace/home.tsx";
    candidate[1].routeScope.push(candidate[0].routeScope[0]);
    const result = auditBrowserUsabilityRoutes(
      [
        route,
        "bounded-contexts/unknown/routes/page.tsx",
        "bounded-contexts/unknown/routes/page.test.tsx",
        "packages/design-system/button.tsx",
      ],
      candidate,
    ).coverage;
    expect(result.unscoped).toEqual(["bounded-contexts/unknown/routes/page.tsx"]);
    expect(result.invalid).toEqual([{ path: route, reason: "multiple scopes", surfaces: ["guest", "buyer"] }]);
    expect(result.surfaces.guest.unclaimed).toContain(route);
  });
  it("counts claimed and excluded routes once per surface", () => {
    const candidate = modules();
    const claimed = "bounded-contexts/public-presence/routes/marketplace/help.tsx";
    const excluded = "bounded-contexts/public-presence/routes/marketplace/home.tsx";
    candidate[0].excludedRoutes.push({ path: excluded, reason: "layout-only" });
    expect(auditBrowserUsabilityRoutes([claimed, excluded], candidate).coverage.surfaces.guest).toEqual({
      inScope: 2,
      claimed: 1,
      excluded: 1,
      unclaimed: [],
    });
  });
  it("partitions representative route fixtures across all five surfaces", () => {
    const result = auditBrowserUsabilityRoutes([
      "bounded-contexts/public-presence/routes/marketplace/home.tsx",
      "bounded-contexts/ordering/routes/account-purchase.tsx",
      "bounded-contexts/marketplace/routes/account-listings.tsx",
      "bounded-contexts/catalog/routes/scopes.tsx",
      "deployables/admin-web/app/routes/layout.tsx",
    ]).coverage;
    expect(result.unscoped).toEqual([]);
    expect(result.invalid).toEqual([]);
    expect(Object.values(result.surfaces).map((surface) => surface.inScope)).toEqual([1, 1, 1, 1, 1]);
  });
  it("supports advisory surface filtering without gating production coverage", () => {
    const result = main(["audit"]).coverage;
    expect(main(["audit", "--surface", "seller"]).coverage.surfaces).toEqual({ seller: result.surfaces.seller });
    expect(() => main(["audit", "--surface", "unknown"])).toThrow("Unknown browser usability surface");
  });
});

describe("code-owned browser recorder", () => {
  it("records observations, errors, action counts, and final evidence without entered values", async () => {
    const f = fixture();
    const browser = tab();
    const session = createBrowserUsabilitySession({ directory: f.directory, tab: browser });
    expect((await session.start()).state).toBe("visible state");
    browser.click.mockRejectedValueOnce(new Error("sensitive raw error text"));
    await expect(session.act("click", [4], "visible product")).rejects.toThrow();
    await expect(session.act("click", [4], "visible product")).rejects.toThrow(/Observe/);
    await session.observe();
    await session.act("typeText", [5, "private entered value"], "search field");
    const result = await session.finish({ status: "complete", answer: "No stock.", obstacles: ["One tool error."] });
    expect(result.status).toBe("unadjudicated");
    expect(browser.close).toHaveBeenCalledOnce();
    const bytes = readFileSync(path.join(f.directory, "run.json"), "utf8");
    const run = JSON.parse(bytes);
    expect(run.actions).toBe(2);
    expect(run.calls.filter((c) => c.status === "error")).toHaveLength(1);
    expect(run.screenshots).toHaveLength(3);
    expect(run.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(bytes).not.toContain("private entered");
    expect(bytes).not.toContain("sensitive raw error");
    await expect(session.observe()).rejects.toThrow(/finished/);
  });
  it("enforces timeout while the model is idle without a participant finish call", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const browser = tab();
    let clock = 0;
    createBrowserUsabilitySession({ directory: f.directory, tab: browser, now: () => clock });
    clock = 360_001;
    await vi.advanceTimersByTimeAsync(360_001);
    const run = JSON.parse(readFileSync(path.join(f.directory, "run.json")));
    expect(run.status).toBe("timed-out");
    expect(run.elapsedMs).toBe(360_001);
    expect(browser.close).toHaveBeenCalledOnce();
  });
  it("bounds a hanging tool call and keeps timeout terminal after a late result", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const browser = tab();
    let resolve;
    browser.goto.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const session = createBrowserUsabilitySession({ directory: f.directory, tab: browser });
    const pending = session.start();
    const assertion = expect(pending).rejects.toThrow(/budget/);
    await vi.advanceTimersByTimeAsync(360_001);
    await assertion;
    resolve();
    await Promise.resolve();
    const run = JSON.parse(readFileSync(path.join(f.directory, "run.json")));
    expect(run.status).toBe("timed-out");
    expect(run.calls[0].status).toBe("interrupted");
    await expect(session.finish({ status: "complete", answer: "Late" })).rejects.toThrow();
  });
  it("refuses unsupported actions, missing visible targets, parallel calls and excess actions", async () => {
    const f = fixture();
    f.manifest.maxActions = 1;
    writeFileSync(path.join(f.directory, "manifest.json"), JSON.stringify(f.manifest));
    const session = createBrowserUsabilitySession({ directory: f.directory, tab: tab() });
    const pending = session.start();
    await expect(session.observe()).rejects.toThrow(/sequential/);
    await pending;
    await expect(session.act("goto", ["http://external.test"], "guessed route")).rejects.toThrow(/Unsupported/);
    await expect(session.act("click", [1], "")).rejects.toThrow(/visible/);
    await session.act("click", [1], "visible button");
    await expect(session.act("click", [1], "visible button")).rejects.toThrow(/budget/);
    expect(JSON.parse(readFileSync(path.join(f.directory, "run.json"))).reason).toBe("action-budget");
  });
});

describe("independent adjudication", () => {
  it("requires every outcome check, exact run bytes, and separate adjudication", async () => {
    const f = fixture();
    const session = createBrowserUsabilitySession({ directory: f.directory, tab: tab() });
    await session.start();
    await session.finish({ status: "complete", answer: "Found requested variant, no inventory." });
    const valid = evidence(f);
    const judge = (value) => adjudicateProbe({ directory: f.directory, evidence: value, evidenceDirectory: f.root });
    expect(() => judge({ ...valid, runSha256: "wrong" })).toThrow(/exact run/);
    expect(() => judge({ ...valid, reviewer: "participant" })).toThrow(/cannot adjudicate/);
    expect(() => judge({ ...valid, checks: {} })).toThrow(/Missing outcome/);
    expect(() =>
      judge({ ...valid, checks: { ...valid.checks, variant: { ...valid.checks.variant, status: "unknown" } } }),
    ).toThrow(/Only an independently/);
    expect(judge(valid).verdict).toBe("verified-complete");
    expect(() => judge(valid)).toThrow();
  });
  it("does not upgrade partial participant completion to a verified pass", async () => {
    const f = fixture();
    const session = createBrowserUsabilitySession({ directory: f.directory, tab: tab() });
    await session.start();
    await session.finish({ status: "partial", answer: "Price unknown." });
    expect(() => adjudicateProbe({ directory: f.directory, evidence: evidence(f), evidenceDirectory: f.root })).toThrow(
      /Only an independently/,
    );
    expect(
      adjudicateProbe({ directory: f.directory, evidence: evidence(f, "partial"), evidenceDirectory: f.root }).verdict,
    ).toBe("partial");
  });
});

describe("correctness-conditioned timing", () => {
  function run(id, elapsedMs, verdict = "verified-complete") {
    return {
      manifest: { runId: id, goalId: "find-card", model: "gpt-6-luna", effort: "medium" },
      run: { status: "finished", elapsedMs },
      adjudication: { verdict },
    };
  }
  const baseline = () => [1, 2, 3, 4, 5].map((id) => run(String(id), 300_000));
  it("flags five-to-fifteen minutes, while excluding fast wrong results", () => {
    expect(compareProbes(run("candidate", 900_000), baseline()).status).toBe("timing-warning");
    expect(compareProbes(run("candidate", 10_000, "incorrect"), baseline()).status).toBe("noncompletion");
  });
  it("requires both relative and absolute thresholds", () => {
    expect(
      compareProbes(
        run("candidate", 60_000),
        baseline().map((r) => ({ ...r, run: { ...r.run, elapsedMs: 20_000 } })),
      ).status,
    ).toBe("within-threshold");
    expect(compareProbes(run("candidate", 350_000), baseline()).status).toBe("within-threshold");
  });
  it("excludes mismatched configurations, duplicate runs, and noncompletions", () => {
    const candidate = run("candidate", 900_000);
    const base = baseline();
    base[0].manifest.effort = "high";
    base[1].adjudication.verdict = "incorrect";
    base[2].run.status = "timed-out";
    expect(compareProbes(candidate, [...base, base[3], candidate])).toMatchObject({
      status: "insufficient-baseline",
      matchingCorrectRuns: 2,
    });
  });
  it.each(["scenarioSha256", "startPath", "role", "budgetMs", "maxActions", "goalSha256"])(
    "starts a new baseline when %s changes",
    (key) => {
      const candidate = run("candidate", 900_000);
      candidate.manifest[key] = "changed";
      expect(compareProbes(candidate, baseline()).status).toBe("insufficient-baseline");
    },
  );
});
