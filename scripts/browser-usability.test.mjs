import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { adjudicateProbe, compareProbes, localOrigin, prepareProbe, validatePreflight } from "./browser-usability.mjs";
import { selectBrowserUsabilityGoals } from "./browser-usability-goals.mjs";
import { createBrowserUsabilitySession } from "./browser-usability-session.mjs";

const head = "a".repeat(40);
const origin = "http://localhost:9753";
const roots = [];
function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "browser-usability-"));
  roots.push(root);
  writeFileSync(path.join(root, "proof.txt"), "synthetic independent fixture evidence\n");
  const preflight = {
    head,
    origin,
    role: "buyer",
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
  const manifest = prepareProbe({ goalId: "find-card", origin, preflight, evidenceDirectory: root, directory, head });
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
