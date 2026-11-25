import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import vm from "node:vm";
import { parse } from "yaml";
import ts from "@chase-sets/typescript-compiler-api";
import { describe, expect, it, vi } from "vitest";
import { resolveAdminWebRouteConfigRecords } from "../deployables/admin-web/app/host.ts";
import * as rehearsal from "../deployables/admin-web/e2e/support/whole-game-rehearsal.ts";

import {
  WholeGameRehearsalRefusal,
  assertPublishPreviewGuard,
  defaultWholeGameBudget,
  parseProviderParticipation,
  parseWholeGameBudget,
  parseWholeGameSettleInput,
  parseWholeGameStartInput,
  planScopePromotion,
  planWholeGameSettle,
  promotedCatalogItems,
  publishFilters,
  readAllCompletedPromoteJobs,
  startConfirmationRefusal,
  validateWholeGameReceipt,
  wholeGameReceiptSchemaVersion,
} from "../deployables/admin-web/e2e/support/whole-game-rehearsal.ts";

// Pure decisions behind the #9220 whole-game staging rehearsal journeys in
// deployables/admin-web/e2e/catalog-staging-provider-sync.uat.spec.ts.

function refusalCode(action) {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(WholeGameRehearsalRefusal);
    return error.code;
  }
  throw new Error("expected a whole-game refusal");
}

const preview = (overrides = {}) => ({
  planFingerprint: "sha256:fixture-plan",
  scopeCount: 3,
  confirmAllowed: true,
  providers: [{ providerKey: "tcgdex", units: 3, plannedRequests: 120 }],
  ...overrides,
});

const batch = (status, units, overrides = {}) => ({
  batchId: "batch-requested",
  status,
  circuitOpenProviders: [],
  units,
  ...overrides,
});
const unit = (scopeRecordId, state) => ({ scopeRecordId, state, providerKeys: ["scrydex"] });
const settleInput = (overrides = {}) => ({
  batchId: "batch-requested",
  retryFailed: false,
  resumeCancelled: false,
  ...overrides,
});

const promoteJob = (jobId, outcomes, overrides = {}) => ({
  jobId,
  kind: "merge-candidate-promote",
  scopeRecordId: "scope-1",
  status: "completed",
  result: { promoted: outcomes.length, outcomes },
  ...overrides,
});

const applied = (candidateId, appliedCatalogItemId, overrides = {}) => ({
  candidateId,
  status: "promoted",
  catalogItemId: null,
  appliedCatalogItemId,
  appliedMode: "create",
  approvalVersion: 2,
  planFingerprint: "sha256:approved-plan",
  ...overrides,
});

const journeySource = ts.createSourceFile(
  "journey.ts",
  readFileSync(
    new URL("../deployables/admin-web/e2e/catalog-staging-provider-sync.uat.spec.ts", import.meta.url),
    "utf8",
  ),
  ts.ScriptTarget.Latest,
  true,
);
const journeyFunction = (name) =>
  journeySource.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === name);

describe("restart-safe scope convergence", () => {
  const checkpoint = (overrides = {}) =>
    promoteJob("completed-between-dispatches", [], {
      createdAt: "2026-11-14T10:00:00Z",
      promotionApplicationVersion: 1,
      result: { promoted: 0, failed: 0, outcomes: [] },
      ...overrides,
    });

  it("reuses completed zero work instead of restarting the scope walk", () => {
    expect(planScopePromotion("scope-1", [], [checkpoint()], 0)).toEqual({
      kind: "reuse-completed-job",
      jobIds: ["completed-between-dispatches"],
    });
  });

  it.each([
    { promotionApplicationVersion: null },
    { createdAt: undefined },
    { createdAt: "invalid" },
    { result: { promoted: 1, failed: 0, outcomes: [] } },
    { result: { promoted: 0, failed: 1, outcomes: [] } },
    { result: { promoted: 0, failed: 0, outcomes: [{ status: "failed" }] } },
  ])("never reuses an unproven convergence checkpoint: %j", (override) => {
    expect(planScopePromotion("scope-1", [], [checkpoint(override)], 0).kind).toBe("submit-promote-all-ready");
  });

  it("new candidate changes invalidate history and active jobs take precedence", () => {
    expect(planScopePromotion("scope-1", [], [checkpoint()], 1).kind).toBe("submit-promote-all-ready");
    expect(planScopePromotion("scope-1", [], [checkpoint({ scopeRecordId: "other" })], 0).kind).toBe(
      "submit-promote-all-ready",
    );
    expect(
      planScopePromotion("scope-1", [checkpoint({ jobId: "active", status: "running" })], [checkpoint()], 0),
    ).toEqual({ kind: "adopt-active-job", jobIds: ["active"] });
  });

  it("a newer nonzero pass invalidates an older checkpoint", () => {
    const newer = checkpoint({ createdAt: "2026-11-14T11:00:00Z", result: { promoted: 1, outcomes: [] } });
    expect(planScopePromotion("scope-1", [], [checkpoint(), newer], 0).kind).toBe("submit-promote-all-ready");
  });

  it("seven jobs finishing between dispatches advance once per scope and then rerun without submission", async () => {
    const history = new Map();
    const submitted = [];
    let pending;
    const scopes = Array.from({ length: 7 }, (_, index) => `scope-${index + 1}`);
    const context = vm.createContext({
      ...rehearsal,
      Date,
      URLSearchParams,
      gotoWholeGamePage: async () => {},
      readWholeGameBatch: async () =>
        batch(
          "completed",
          scopes.map((scope) => unit(scope, "completed")),
        ),
      readActivePromoteJobs: async () => [],
      readWholeGameJson: async (_page, path) => {
        const url = new URL(path, rehearsal.wholeGameStagingOrigin);
        if (url.pathname.endsWith("bulk-jobs/active"))
          return { items: history.get(url.searchParams.get("scopeRecordId")) ?? [] };
        if (url.pathname.endsWith("merge-candidates")) return { total: 0, items: [] };
        throw new Error(`unexpected read ${path}`);
      },
      submitPromoteAllReady: async (_page, scopeRecordId) => {
        submitted.push(scopeRecordId);
        pending = checkpoint({ scopeRecordId, jobId: `job-${scopeRecordId}` });
        return pending.jobId;
      },
      waitForPromoteJob: async () => null,
    });
    const declarations = ["wholeGameSettle", "wholeGameQuery", "promoteJobsPath", "readReadyCandidateCount"]
      .map((name) => journeyFunction(name).getText(journeySource))
      .join("\n");
    vm.runInContext(ts.transpile(declarations, { target: ts.ScriptTarget.ES2022 }), context);
    const run = () =>
      context.wholeGameSettle(
        {},
        settleInput(),
        { sha: "a".repeat(40), runId: "123", runAttempt: "1" },
        { deadlineAt: Date.now() + 1000, pollMs: 1 },
        () => {},
      );
    for (const [index, scope] of scopes.entries()) {
      const result = await run();
      expect(result).toMatchObject({ state: "running", settle: { scopesPromoted: index, promoteJobsSubmitted: 1 } });
      expect(result.settle.scopeProgress.at(-1)).toMatchObject({
        scopeRecordId: scope,
        state: "promotion-running",
        jobIds: [`job-${scope}`],
      });
      expect(validateWholeGameReceipt(result)).toEqual([]);
      history.set(scope, [pending]);
    }
    for (let rerun = 0; rerun < 2; rerun += 1) {
      const result = await run();
      expect(result).toMatchObject({
        state: "settled",
        settle: { scopesPromoted: 7, promoteJobsSubmitted: 0, promotedThisDispatch: 0, published: 0 },
      });
      expect(
        result.settle.scopeProgress.every(
          (progress) => progress.completedJobsObserved === 1 && progress.state === "converged",
        ),
      ).toBe(true);
      expect(validateWholeGameReceipt(result)).toEqual([]);
    }
    expect(submitted).toEqual(scopes);
  });
});

describe("reference-only settle completeness", () => {
  const referenceOnly = (candidateId) => ({
    candidateId,
    status: "skipped-not-eligible",
    disposition: "reference-only",
    catalogItemId: null,
  });
  const convergedJob = (outcomes, overrides = {}) =>
    promoteJob("current-zero", outcomes, {
      createdAt: "2026-11-12T12:00:00Z",
      promotionApplicationVersion: 1,
      result: { promoted: 0, failed: 0, outcomes },
      ...overrides,
    });

  async function count(pages, jobs, status = "ready") {
    const reads = [];
    const context = vm.createContext({
      ...rehearsal,
      URLSearchParams,
      readWholeGameJson: async (_page, path) => {
        reads.push(path);
        const offset = Number(new URL(path, rehearsal.wholeGameStagingOrigin).searchParams.get("offset") ?? 0);
        const page = pages[offset] ?? { total: 1, items: [] };
        return { ...page, items: page.items.map((item) => ({ updated_at: "2026-11-11T12:00:00Z", ...item })) };
      },
      readWholeGameTotal: async () => pages[0].total,
    });
    const declarations = ["readReadyCandidateCount", "wholeGameQuery"]
      .map((name) => journeyFunction(name).getText(journeySource))
      .join("\n");
    vm.runInContext(ts.transpile(declarations, { target: ts.ScriptTarget.ES2022 }), context);
    return { remaining: await context.readReadyCandidateCount({}, "scope-1", jobs, undefined, status), reads };
  }

  it.each([
    ["2026-11-11T12:00:00Z", 1],
    ["2026-11-12T12:00:01Z", 1],
    ["invalid", 1],
    [undefined, 1],
  ])(
    "invalidates a checkpoint for approved-but-unapplied candidates absent from its outcomes (%s)",
    async (updated_at, remaining) => {
      const result = await count(
        { 0: { total: 1, items: [{ candidate_id: "approved", updated_at }] } },
        [convergedJob([])],
        "promoted",
      );
      expect(result.remaining).toBe(remaining);
      expect(new URL(result.reads[0], rehearsal.wholeGameStagingOrigin).searchParams.get("status")).toBe("promoted");
    },
  );

  it.each([
    ["2026-11-11T12:00:00Z", 0],
    ["2026-11-12T12:00:00Z", 1],
    ["2026-11-12T12:00:01Z", 1],
    ["invalid", 1],
    [undefined, 1],
  ])(
    "reuses a covered approved candidate only while strictly older than its checkpoint (%s)",
    async (updated_at, remaining) => {
      const job = convergedJob([referenceOnly("synthetic-approved")]);
      const result = await count(
        { 0: { total: 1, items: [{ candidate_id: "synthetic-approved", updated_at }] } },
        [job],
        "promoted",
      );
      expect(result.remaining).toBe(remaining);
      expect(planScopePromotion("scope-1", [], [job], result.remaining).kind).toBe(
        remaining === 0 ? "reuse-completed-job" : "submit-promote-all-ready",
      );
    },
  );

  it("does not borrow approved candidate coverage from an older zero checkpoint", async () => {
    const result = await count(
      { 0: { total: 1, items: [{ candidate_id: "synthetic-approved" }] } },
      [
        convergedJob([referenceOnly("synthetic-approved")], { jobId: "synthetic-older-zero" }),
        convergedJob([], { jobId: "synthetic-latest-zero", createdAt: "2026-11-12T13:00:00Z" }),
      ],
      "promoted",
    );
    expect(result.remaining).toBe(1);
  });

  it("does not leave the Time Spiral reference-only set candidate blocking settle", async () => {
    const candidateId = "cand_400f635bd596d757ecda7a4f";
    const result = await count({ 0: { total: 1, items: [{ candidate_id: candidateId }] } }, [
      convergedJob([referenceOnly(candidateId)]),
    ]);
    expect(result.remaining).toBe(0);
  });

  it("counts every unresolved ready candidate across pages, not unrelated disposition ids", async () => {
    const result = await count(
      {
        0: { total: 3, items: [{ candidate_id: "reference" }, { candidate_id: "unknown" }] },
        2: { total: 3, items: [{ candidate_id: "ordinary-skip" }] },
      },
      [
        convergedJob([
          referenceOnly("reference"),
          referenceOnly("not-ready"),
          {
            candidateId: "ordinary-skip",
            status: "skipped-not-eligible",
            catalogItemId: null,
          },
        ]),
      ],
    );
    expect(result.remaining).toBe(2);
    expect(result.reads).toHaveLength(2);
  });

  it.each([
    { createdAt: undefined },
    { createdAt: "invalid" },
    { status: "failed" },
    { scopeRecordId: "other-scope" },
    { promotionApplicationVersion: null },
    { result: { promoted: 1, failed: 0, outcomes: [referenceOnly("reference")] } },
    { result: { promoted: 0, failed: 1, outcomes: [referenceOnly("reference")] } },
  ])("does not exempt candidates from a non-converged or wrong-scope job: %j", async (override) => {
    const result = await count({ 0: { total: 1, items: [{ candidate_id: "reference" }] } }, [
      convergedJob([referenceOnly("reference")], override),
    ]);
    expect(result.remaining).toBe(1);
  });

  it.each(["2026-11-12T12:00:01Z", "invalid", undefined])(
    "keeps candidates edited after disposition or with unknown update time unresolved (%s)",
    async (updated_at) => {
      const result = await count({ 0: { total: 1, items: [{ candidate_id: "reference", updated_at }] } }, [
        convergedJob([referenceOnly("reference")]),
      ]);
      expect(result.remaining).toBe(1);
    },
  );

  it.each([
    { 0: { total: 2, items: [{ candidate_id: "reference" }] } },
    {
      0: { total: 2, items: [{ candidate_id: "reference" }] },
      1: { total: 2, items: [{ candidate_id: "reference" }] },
    },
    { 0: { total: 2, items: [{ candidate_id: "reference" }] }, 1: { total: 3, items: [{ candidate_id: "other" }] } },
  ])("refuses truncated, repeated or changing ready pagination", async (pages) => {
    await expect(count(pages, [convergedJob([referenceOnly("reference")])])).rejects.toMatchObject({
      code: "ready-candidates-incomplete",
    });
  });
});

describe("whole-game repair regressions", () => {
  it("uses registered admin routes for every whole-game page", () => {
    const routes = new Set(resolveAdminWebRouteConfigRecords().map((route) => `/${route.routePath}`));
    const paths = [];
    for (const name of ["wholeGameSettle", "submitPromoteAllReady", "publishThroughCatalogItems"]) {
      const visit = (node) => {
        if (ts.isTemplateExpression(node) && node.head.text.startsWith("/")) {
          const path = node.head.text.split("?")[0];
          if (path.startsWith("/catalog")) paths.push(path.endsWith("/") ? `${path}:id` : path);
        }
        ts.forEachChild(node, visit);
      };
      visit(journeyFunction(name));
    }
    expect(paths).toEqual(["/catalog/scopes/sync-batches", "/catalog/scopes/:id", "/catalog/catalog-items"]);
    for (const path of paths) expect(routes.has(path), path).toBe(true);
    expect(journeyFunction("publishThroughCatalogItems").getText(journeySource)).toContain(
      'clickWholeGameControl(page, page.getByRole("button", { name: "Actions", exact: true }).first(), runtime)',
    );
  });

  it("AC2 bounds a collapsed review-stage expansion before promotion", async () => {
    const declarations = ["expandWorkflowStage", "submitPromoteAllReady"]
      .map((name) => journeyFunction(name).getText(journeySource))
      .join("\n");
    let expanded = false;
    let posted = false;
    const trigger = {
      or: () => trigger,
      first: () => trigger,
      getByRole: () => trigger,
      getAttribute: async (name) => (name === "aria-expanded" && expanded ? "true" : "false"),
      click: async () => {},
    };
    const promoteButton = {};
    const form = {
      filter: () => form,
      getByRole: () => promoteButton,
    };
    const page = {
      url: () => rehearsal.wholeGameStagingOrigin,
      locator: (selector) => (selector.includes("workflow-stage") ? trigger : form),
      waitForTimeout: async () => {},
      getByRole: () => trigger,
    };
    const runtime = { deadlineAt: Date.now() + 1_000, pollMs: 1 };
    const context = vm.createContext({
      ...rehearsal,
      Date,
      Set,
      URLSearchParams,
      cssString: JSON.stringify,
      workflowStageNames: { "review-changes": /^Review changes\\b/i },
      pageReadyTimeoutMs: 1_000,
      syncTimeoutMs: 1_000,
      page,
      expect: () => ({
        toBeVisible: async () => {},
        toHaveAttribute: async () => {
          if (!expanded) {
            throw new Error("review-changes stage did not expand before its deadline");
          }
        },
        toHaveCount: async () => {},
      }),
      readAllCompletedPromoteJobs: async () => [],
      readWholeGameJson: async () => ({ items: [] }),
      gotoWholeGamePage: async () => {},
      isCortenAdminPage: async () => false,
      wholeGameRemainingMs: () => 1_000,
      clickWholeGameControl: async (_page, control) => {
        if (control === promoteButton && !expanded) throw new Error("click timeout");
        posted = true;
      },
      readActivePromoteJobs: async () => [],
    });
    vm.runInContext(ts.transpile(declarations, { target: ts.ScriptTarget.ES2022 }), context);
    await expect(context.submitPromoteAllReady(page, "scope-1", [], runtime)).rejects.toMatchObject({
      name: "TimeoutError",
    });
    expect(posted).toBe(false);
  });

  it("AC1 orders the origin assertion, review expansion, and promotion click", () => {
    const source = journeyFunction("submitPromoteAllReady").getText(journeySource);
    const count = source.indexOf("await expect(form).toHaveCount(1");
    const origin = source.indexOf("assertWholeGameOrigin(page.url())", count);
    const expansion = source.indexOf('expandWorkflowStage(page, "review-changes"', origin);
    const click = source.indexOf(
      'clickWholeGameControl(page, form.getByRole("button", { name: "Promote all ready"',
      expansion,
    );
    expect(count).toBeGreaterThanOrEqual(0);
    expect(origin).toBeGreaterThan(count);
    expect(expansion).toBeGreaterThan(origin);
    expect(click).toBeGreaterThan(expansion);
  });

  it.each(["full-game-start", "full-game-settle"])(
    "refuses automatic retries of %s before navigation or credentials",
    async (scope) => {
      let branch;
      const visit = (node) => {
        if (
          ts.isIfStatement(node) &&
          node.expression.getText(journeySource) === "isWholeGameJourneyScope(providerUatJourneyScope)"
        )
          branch = node.getText(journeySource);
        ts.forEachChild(node, visit);
      };
      visit(journeySource);
      expect(branch).toBeDefined();
      for (const retry of [1, 2]) {
        const signIn = vi.fn();
        const journey = vi.fn();
        const write = vi.fn();
        const context = vm.createContext({
          ...rehearsal,
          isWholeGameJourneyScope: (value) => rehearsal.wholeGameJourneyScopes.includes(value),
          page: {},
          providerUatJourneyScope: scope,
          testInfo: { retry, timeout: 1000 },
          startedAt: 0,
          wholeGameDeadlineMarginMs: 1,
          process: { env: { ADMIN_WEB_URL: rehearsal.wholeGameStagingOrigin } },
          signInWholeGame: signIn,
          runWholeGameJourney: journey,
          writeWholeGameReceipt: write,
        });
        vm.runInContext(
          ts.transpile(`async function attempt() { ${branch} }`, { target: ts.ScriptTarget.ES2022 }),
          context,
        );
        await expect(context.attempt()).rejects.toMatchObject({ code: "automatic-retry-refused" });
        expect(signIn).not.toHaveBeenCalled();
        expect(journey).not.toHaveBeenCalled();
        expect(write).not.toHaveBeenCalled();
      }
    },
  );

  it.each(["retry-unit", "resume"])(
    "reports a refused HTTP-200 %s command rather than a performed command",
    async (intent) => {
      for (const blockedBanner of [true, false]) {
        const form = { filter: () => form, getByRole: () => ({}) };
        const read = vi.fn(async () =>
          batch(blockedBanner ? "queued" : "cancelled", [unit("scope-1", blockedBanner ? "queued" : "failed")]),
        );
        const page = {
          url: () => rehearsal.wholeGameStagingOrigin,
          locator: () => form,
          getByText: () => ({ isVisible: async () => blockedBanner }),
          waitForResponse: async () => ({ status: () => 200 }),
        };
        const context = vm.createContext({
          ...rehearsal,
          cssString: JSON.stringify,
          expect: () => ({ toHaveCount: async () => {} }),
          pageReadyTimeoutMs: 1000,
          wholeGameRemainingMs: () => 1000,
          clickWholeGameControl: async () => {},
          readWholeGameBatch: read,
        });
        vm.runInContext(
          ts.transpile(journeyFunction("submitBatchCommand").getText(journeySource), {
            target: ts.ScriptTarget.ES2022,
          }),
          context,
        );
        await expect(
          context.submitBatchCommand(page, "batch-requested", { intent, scopeRecordId: "scope-1" }, "Command"),
        ).rejects.toMatchObject({ code: "batch-command-refused" });
      }
    },
  );
});

describe("amended AC3 completed application history", () => {
  it("uses applied identity for create intents and reconciles legacy approvals and repeated applications", () => {
    const legacy = promoteJob("legacy", [
      { candidateId: "candidate-1", status: "promoted", catalogItemId: "wrong-match" },
    ]);
    const current = promoteJob("current", [applied("candidate-1", "created-item")], { promotionApplicationVersion: 1 });
    expect(promotedCatalogItems([legacy, current, { ...current, jobId: "recovered-unit" }])).toEqual({
      catalogItemIds: ["created-item"],
      promotedOutcomes: 1,
      promotedWithoutCatalogItem: 0,
    });
    expect(promotedCatalogItems([legacy])).toEqual({
      catalogItemIds: [],
      promotedOutcomes: 0,
      promotedWithoutCatalogItem: 1,
    });
  });

  it.each([
    { appliedCatalogItemId: null },
    { appliedCatalogItemId: undefined },
    { appliedMode: null },
    { appliedMode: "invented" },
    { approvalVersion: null },
    { planFingerprint: null },
  ])("refuses malformed version-1 facts %j without falling back to catalogItemId", (override) => {
    expect(() =>
      promotedCatalogItems([
        promoteJob("bad", [applied("candidate-1", "created-item", { catalogItemId: "wrong-match", ...override })], {
          promotionApplicationVersion: 1,
        }),
      ]),
    ).toThrow(/promoted-catalog-item-unresolved/);
  });

  it.each([
    { appliedCatalogItemId: "other-item" },
    { appliedMode: "refresh" },
    { approvalVersion: 3 },
    { planFingerprint: "different-plan" },
  ])("refuses conflicting application identity %j", (override) => {
    expect(() =>
      promotedCatalogItems([
        promoteJob("one", [applied("candidate-1", "created-item")], { promotionApplicationVersion: 1 }),
        promoteJob("two", [applied("candidate-1", "created-item", override)], { promotionApplicationVersion: 1 }),
      ]),
    ).toThrow(/promoted-catalog-item-unresolved/);
  });
});

describe("AC7 exact staging admission", () => {
  const workflow = parse(
    readFileSync(new URL("../.github/workflows/catalog-staging-provider-uat.yml", import.meta.url), "utf8"),
  );
  const step = workflow.jobs["admit-reviewed-sha"].steps[0];
  it("routes both paid modes through the staging-only whole-game job", () => {
    const dispatch = workflow.on.workflow_dispatch.inputs;
    const job = workflow.jobs["staging-provider-uat"];
    const matrix = workflow.jobs["resolve-provider-uat-plan"].steps[0].run;
    for (const scope of ["full-game-preview", "full-game-confirm"]) {
      expect(dispatch.journey_scope.options).toContain(scope);
      expect(matrix).toContain(`|${scope}|`);
      expect(rehearsal.wholeGameJourneyScopes).toContain(scope);
    }
    expect(job["runs-on"]).toBe("ubuntu-24.04");
    expect(job.env.CATALOG_WHOLE_GAME_APPROVED_PREVIEW_FINGERPRINT).toBe("${{ inputs.approved_preview_fingerprint }}");
    expect(job.env.CATALOG_WHOLE_GAME_BUDGET).toBe("${{ inputs.budget }}");
  });
  it("uploads only the whole-game receipt even when the journey fails", () => {
    const upload = Object.values(workflow.jobs)
      .flatMap((job) => job.steps ?? [])
      .find((step) => step.name === "Upload whole-game rehearsal receipt");
    expect(upload.if).toBe("${{ always() && startsWith(matrix.journey_scope, 'full-game-') }}");
    expect(upload.with.path).toBe("artifacts/catalog-whole-game-rehearsal/receipt.json");
    expect(upload.with["if-no-files-found"]).toBe("error");
  });
  it.each([
    "https://production.invalid",
    "http://admin.staging.chasesets.com",
    "https://user@admin.staging.chasesets.com",
    "https://admin.staging.chasesets.com/",
    "https://admin.staging.chasesets.com?next=evil",
  ])("refuses %s before the credential job", (target) => {
    for (const scope of rehearsal.wholeGameJourneyScopes) {
      const failures = [];
      vm.runInNewContext(step.with.script, {
        process: {
          env: {
            EXPECTED_SHA: "a".repeat(40),
            RUN_SHA: "a".repeat(40),
            RUN_ATTEMPT: "1",
            CONFIRMATION: "run catalog staging provider uat",
            JOURNEY_SCOPE: scope,
            ADMIN_WEB_URL: target,
          },
        },
        core: { setFailed: (message) => failures.push(message) },
      });
      expect(failures).toEqual(["Whole-game and capture journeys require the exact staging origin."]);
    }
  });
  it("admits the exact staging origin and leaves other journeys unchanged", () => {
    for (const [scope, target] of [
      ["full-game-start", "https://admin.staging.chasesets.com"],
      ["full-game-preview", "https://admin.staging.chasesets.com"],
      ["full-game-confirm", "https://admin.staging.chasesets.com"],
      ["one-piece-launch", "https://synthetic.invalid"],
    ]) {
      const failures = [];
      vm.runInNewContext(step.with.script, {
        process: {
          env: {
            EXPECTED_SHA: "a".repeat(40),
            RUN_SHA: "a".repeat(40),
            RUN_ATTEMPT: "1",
            CONFIRMATION: "run catalog staging provider uat",
            JOURNEY_SCOPE: scope,
            ADMIN_WEB_URL: target,
          },
        },
        core: { setFailed: (message) => failures.push(message) },
      });
      expect(failures).toEqual([]);
    }
  });
  it("refuses a GitHub rerun of paid confirm", () => {
    const setFailed = vi.fn();
    vm.runInNewContext(step.with.script, {
      process: {
        env: {
          EXPECTED_SHA: "a".repeat(40),
          RUN_SHA: "a".repeat(40),
          RUN_ATTEMPT: "2",
          CONFIRMATION: "run catalog staging provider uat",
          JOURNEY_SCOPE: "full-game-confirm",
          ADMIN_WEB_URL: rehearsal.wholeGameStagingOrigin,
        },
      },
      core: { setFailed },
    });
    expect(setFailed.mock.calls).toEqual([["Paid whole-game confirmation requires a fresh dispatch, not a rerun."]]);
  });
  it("refuses redirected effective origins without invoking the guarded action", async () => {
    const action = vi.fn();
    expect(() => rehearsal.assertWholeGameOrigin("https://redirect.invalid/access/sign-in")).toThrow(
      /staging-origin-required/,
    );
    expect(action).not.toHaveBeenCalled();
  });
});

describe("AC8 bounded complete reads", () => {
  function settleProbe({
    delay = 0,
    stall = false,
    ready = [],
    zeroOutcomes = [],
    historicalOutcomes = [],
    failedJob,
    receiptPath,
  } = {}) {
    const file = readFileSync(
      new URL("../deployables/admin-web/e2e/catalog-staging-provider-sync.uat.spec.ts", import.meta.url),
      "utf8",
    );
    const source = ts.createSourceFile("journey.ts", file, ts.ScriptTarget.Latest, true);
    const names = new Set([
      "wholeGameSettle",
      "wholeGameQuery",
      "promoteJobsPath",
      "draftItemsPath",
      "readReadyCandidateCount",
      "runWholeGameJourney",
      "wholeGameRunIdentity",
      "writeWholeGameReceipt",
    ]);
    const functions = source.statements.filter((node) => ts.isFunctionDeclaration(node) && names.has(node.name?.text));
    expect(functions).toHaveLength(8);
    const declarations = functions.map((node) => node.getText(source)).join("\n");
    const jobs = [
      promoteJob(
        "history",
        [
          ...Array.from({ length: 10 }, (_, index) => applied(`candidate-${index}`, `item-${index}`)),
          ...historicalOutcomes,
        ],
        { promotionApplicationVersion: 1 },
      ),
    ];
    const zeroJob = promoteJob("zero", zeroOutcomes, {
      createdAt: "2026-11-12T12:00:00Z",
      promotionApplicationVersion: 1,
      result: { promoted: 0, failed: 0, outcomes: zeroOutcomes },
    });
    const reads = [];
    const publish = vi.fn();
    const writeReceipt = vi.fn((receipt) => {
      if (receiptPath) context.writeWholeGameReceipt(receipt);
    });
    let deadline;
    const read = async (_page, path) =>
      rehearsal.readBeforeWholeGameDeadline(deadline, async () => {
        reads.push(path);
        if (path.includes("merge-candidates?"))
          return { total: ready.length, items: ready.map((item) => ({ updated_at: "2026-11-11T12:00:00Z", ...item })) };
        if (path.includes("bulk-jobs/active")) {
          if (stall) return new Promise(() => {});
          return { items: jobs };
        }
        if (path.startsWith("/api/catalog/items/")) {
          await new Promise((resolve) => setTimeout(resolve, delay));
          return { catalog_item_id: path.split("/").at(-1), blueprint_id: "blueprint-1", language_code: "en" };
        }
        throw new Error(`unexpected fixture read ${path}`);
      });
    const context = vm.createContext({
      ...rehearsal,
      Date,
      Set,
      URLSearchParams,
      mkdirSync,
      dirname,
      writeFileSync,
      wholeGameReceiptPath: receiptPath,
      wholeGamePollMs: 1,
      wholeGameStart: async (_page, _input, run) =>
        receipt({
          ...run,
          journeyScope: "full-game-start",
          state: "confirmed",
          settle: null,
          preview: {
            planFingerprint: "sha256:fixture-plan",
            scopeCount: 3,
            providers: [{ providerKey: "tcgdex", units: 3, plannedRequests: 120 }],
          },
        }),
      gotoWholeGamePage: async () => {},
      readWholeGameBatch: async () => ({
        ...batch("completed", [unit("scope-1", "completed")]),
        planFingerprint: "sha256:fixture-plan",
      }),
      readActivePromoteJobs: async () => [],
      submitPromoteAllReady: async () => "zero",
      waitForPromoteJob: async () => failedJob ?? zeroJob,
      readWholeGameJson: read,
      readWholeGameTotal: async () => 0,
      publishThroughCatalogItems: publish,
    });
    vm.runInContext(ts.transpile(declarations, { target: ts.ScriptTarget.ES2022 }), context);
    const fixtureSink = source.statements
      .filter(ts.isVariableStatement)
      .flatMap((node) => [...node.declarationList.declarations])
      .find((node) => node.name.getText(source) === "fixtureReceiptSink");
    vm.runInContext(ts.transpile(`const ${fixtureSink.getText(source)};`), context);
    return {
      reads,
      publish,
      writeReceipt,
      runLive: (scope) => {
        deadline = Date.now() + 1000;
        return context.runWholeGameJourney({}, scope, deadline, writeReceipt, {
          GITHUB_SHA: "b".repeat(40),
          GITHUB_RUN_ID: "456",
          GITHUB_RUN_ATTEMPT: "1",
          CATALOG_WHOLE_GAME_BATCH_ID: "batch-requested",
          CATALOG_WHOLE_GAME_PRODUCT_DOMAIN: "one-piece",
        });
      },
      runFixture: () => {
        const calls = [];
        const visit = (node) => {
          if (
            ts.isCallExpression(node) &&
            node.expression.getText(source) === "wholeGameSettle" &&
            node.arguments[2]?.getText(source) === "fixtureRun"
          )
            calls.push(node);
          ts.forEachChild(node, visit);
        };
        visit(source);
        expect(calls.length).toBeGreaterThan(0);
        for (const call of calls) expect(call.arguments[4]?.getText(source)).toBe("fixtureReceiptSink");
        const failedFixture = calls.find(
          (call) =>
            call.arguments[0].getText(source) === "page" &&
            call.arguments[1].getText(source).includes('batchId: "batch-requested"'),
        );
        expect(failedFixture).toBeDefined();
        context.page = {};
        context.fixtureRun = { sha: "a".repeat(40), runId: "9220", runAttempt: "1" };
        context.fixtureRuntime = () => ({ deadlineAt: Date.now() + 1000, pollMs: 1 });
        deadline = Date.now() + 1000;
        return vm.runInContext(ts.transpile(failedFixture.getText(source)), context);
      },
      run: (budget) => {
        deadline = Date.now() + budget;
        return context.wholeGameSettle(
          {},
          settleInput(),
          { sha: "a".repeat(40), runId: "123", runAttempt: "1" },
          { deadlineAt: deadline, pollMs: 1 },
          writeReceipt,
        );
      },
    };
  }
  it.each(["full-game-settle", "full-game-start"])(
    "preserves the live %s receipt when the expected-failure fixture runs",
    async (scope) => {
      const directory = mkdtempSync(join(tmpdir(), "whole-game-isolation-"));
      const path = join(directory, "receipt.json");
      try {
        const probe = settleProbe({
          receiptPath: path,
          failedJob: promoteJob("live-failed-job", [
            {
              candidateId: "live-failed-candidate",
              status: "failed",
              diagnosticCode: "asset-processing-failed",
            },
          ]),
        });
        if (scope === "full-game-settle") {
          await expect(probe.runLive(scope)).rejects.toMatchObject({ code: "scope-promotion-failed" });
        } else {
          const started = await probe.runLive(scope);
          probe.writeReceipt(started);
        }
        const live = readFileSync(path, "utf8");
        expect(validateWholeGameReceipt(JSON.parse(live))).toEqual([]);
        expect(JSON.parse(live)).toMatchObject({
          journeyScope: scope,
          state: scope === "full-game-start" ? "confirmed" : "failed",
          sha: "b".repeat(40),
          runId: "456",
        });
        if (scope === "full-game-settle")
          expect(JSON.parse(live).promotionFailure.failedOutcomes).toEqual([
            { candidateId: "live-failed-candidate", reasonCode: "asset-processing-failed" },
          ]);
        expect(probe.writeReceipt).toHaveBeenCalledTimes(1);
        await expect(probe.runFixture()).rejects.toMatchObject({ code: "scope-promotion-failed" });
        expect(readFileSync(path, "utf8")).toBe(live);
        expect(probe.writeReceipt).toHaveBeenCalledTimes(1);
        expect(probe.publish).not.toHaveBeenCalled();
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );
  it("wires the canonical failure sink only at the live whole-game journey boundary", () => {
    const calls = [];
    const visit = (node) => {
      if (ts.isCallExpression(node) && node.expression.getText(journeySource) === "runWholeGameJourney")
        calls.push(node);
      ts.forEachChild(node, visit);
    };
    visit(journeySource);
    expect(calls).toHaveLength(1);
    expect(calls[0].arguments[3].getText(journeySource)).toBe("writeWholeGameReceipt");
    expect(journeyFunction("wholeGameSettle").getText(journeySource)).not.toContain("writeWholeGameReceipt");
  });
  it.each([
    {
      status: "completed",
      result: {
        promoted: 1,
        failed: 0,
        outcomes: [
          {
            candidateId: "candidate-asset",
            status: "failed",
            diagnosticCode: "asset-processing-failed",
            reason: "https://provider.invalid/private?secret=value",
          },
          {
            candidateId: "candidate-set",
            status: "failed",
            failureDiagnosticCode: "promotion-reference-target-unresolved",
            reason: "provider body",
          },
          {
            candidateId: "candidate-unknown",
            status: "failed",
            failureDiagnosticCode: "promotion-plan-blocked:private-value",
            reason: "provider body",
          },
          applied("candidate-ok", "item-ok"),
        ],
      },
    },
    { status: "failed", result: null },
    { status: "completed", result: { promoted: 0, failed: 1, outcomes: [] } },
  ])("records a redacted failure before refusing, never publishes: %j", async (override) => {
    const job = promoteJob("failed-job", [], override);
    const probe = settleProbe({ failedJob: job });
    await expect(probe.run(1000)).rejects.toMatchObject({ code: "scope-promotion-failed" });
    expect(probe.publish).not.toHaveBeenCalled();
    expect(probe.writeReceipt).toHaveBeenCalledTimes(1);
    const diagnostic = probe.writeReceipt.mock.calls[0][0];
    expect(diagnostic).toMatchObject({
      state: "failed",
      promotionFailure: {
        code: "scope-promotion-failed",
        scopeRecordId: "scope-1",
        jobId: "failed-job",
        jobStatus: job.status,
        failedOutcomes: job.result?.outcomes.some((outcome) => outcome.status === "failed")
          ? [
              { candidateId: "candidate-asset", reasonCode: "asset-processing-failed" },
              { candidateId: "candidate-set", reasonCode: "promotion-reference-target-unresolved" },
              { candidateId: "candidate-unknown", reasonCode: "unclassified" },
            ]
          : [],
      },
    });
    expect(validateWholeGameReceipt(diagnostic)).toEqual([]);
    expect(JSON.stringify(diagnostic)).not.toMatch(/provider|private|secret|reason"/);
  });
  it.each([
    [100, false, 250, 3],
    [0, true, 75, 0],
  ])("actual settle stops slow/stalled reads (%s, %s) within budget", async (delay, stall, budget, itemReads) => {
    vi.useFakeTimers();
    try {
      const probe = settleProbe({ delay, stall });
      const start = Date.now();
      const pending = probe.run(budget);
      await vi.advanceTimersByTimeAsync(budget);
      const result = await pending;
      expect(result.state).toBe("running");
      expect(Date.now() - start).toBe(budget);
      expect(probe.reads.filter((path) => path.startsWith("/api/catalog/items/"))).toHaveLength(itemReads);
      expect(probe.publish).not.toHaveBeenCalled();
      const count = probe.reads.length;
      await vi.advanceTimersByTimeAsync(1000);
      expect(probe.reads).toHaveLength(count);
    } finally {
      vi.useRealTimers();
    }
  });
  it("actual settle with complete within-budget history reaches settled", async () => {
    vi.useFakeTimers();
    try {
      const probe = settleProbe();
      const pending = probe.run(1000);
      await vi.runAllTimersAsync();
      expect(await pending).toMatchObject({ state: "settled", settle: { promotedOutcomes: 10, draftsRemaining: 0 } });
      expect(probe.reads.filter((path) => path.startsWith("/api/catalog/items/"))).toHaveLength(10);
    } finally {
      vi.useRealTimers();
    }
  });
  it.each([true, false])(
    "actual settle only exempts reference-only dispositions from its current pass (%s)",
    async (current) => {
      const outcome = {
        candidateId: "reference",
        status: "skipped-not-eligible",
        disposition: "reference-only",
        catalogItemId: null,
      };
      const probe = settleProbe({
        ready: [{ candidate_id: "reference" }],
        zeroOutcomes: current ? [outcome] : [],
        historicalOutcomes: [outcome],
      });
      expect(await probe.run(1000)).toMatchObject({
        state: current ? "settled" : "running",
        settle: { promotedThisDispatch: 0, published: 0, readyRemaining: current ? 0 : 1, draftsRemaining: 0 },
      });
    },
  );
  it("stops slow paginated reads at the deadline, never runs the publication continuation", async () => {
    vi.useFakeTimers();
    try {
      const read = vi.fn(async () => {
        await new Promise((resolve) => setTimeout(resolve, 100));
        return { items: [], cursor: "next" };
      });
      const publish = vi.fn();
      const deadline = Date.now() + 150;
      const pending = readAllCompletedPromoteJobs("scope-1", () =>
        rehearsal.readBeforeWholeGameDeadline(deadline, read),
      ).then(publish);
      const assertion = expect(pending).rejects.toBeInstanceOf(rehearsal.WholeGameDeadlineReached);
      await vi.advanceTimersByTimeAsync(150);
      await assertion;
      expect(read).toHaveBeenCalledTimes(2);
      expect(publish).not.toHaveBeenCalled();
      await expect(rehearsal.readBeforeWholeGameDeadline(deadline, read)).rejects.toBeInstanceOf(
        rehearsal.WholeGameDeadlineReached,
      );
      expect(read).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
  it("cancels one stalled read at the remaining budget", async () => {
    vi.useFakeTimers();
    try {
      let signal;
      const pending = rehearsal.readBeforeWholeGameDeadline(Date.now() + 75, (abort) => {
        signal = abort;
        return new Promise(() => {});
      });
      const assertion = expect(pending).rejects.toBeInstanceOf(rehearsal.WholeGameDeadlineReached);
      await vi.advanceTimersByTimeAsync(75);
      await assertion;
      expect(signal.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
  it("retains a within-budget complete history", async () => {
    const job = promoteJob("complete", [applied("candidate-1", "created-item")], { promotionApplicationVersion: 1 });
    const jobs = await readAllCompletedPromoteJobs("scope-1", () =>
      rehearsal.readBeforeWholeGameDeadline(Date.now() + 1000, async () => ({ items: [job] })),
    );
    expect(promotedCatalogItems(jobs).catalogItemIds).toEqual(["created-item"]);
  });
});

function receipt(overrides = {}) {
  return {
    schemaVersion: wholeGameReceiptSchemaVersion,
    journeyScope: "full-game-settle",
    sha: "a".repeat(40),
    runId: "9220",
    runAttempt: "1",
    batchId: "batch-requested",
    state: "settled",
    preview: null,
    settle: {
      batchStatus: "completed",
      units: { queued: 0, running: 0, completed: 2, failed: 0, cancelled: 0 },
      resumed: false,
      retriedUnits: 0,
      scopesPromoted: 1,
      promoteJobsSubmitted: 1,
      promoteJobsAdopted: 0,
      promotedThisDispatch: 4,
      promotedOutcomes: 4,
      promotedWithoutCatalogItem: 0,
      blueprints: 1,
      publishFilters: 1,
      publishPreviewed: 1,
      published: 4,
      readyRemaining: 0,
      draftsRemaining: 0,
    },
    ...overrides,
  };
}

describe("whole-game rehearsal inputs", () => {
  it("parses start and settle inputs and refuses malformed dispatch values", () => {
    expect(
      parseWholeGameStartInput({
        CATALOG_WHOLE_GAME_PRODUCT_DOMAIN: "one-piece",
        CATALOG_WHOLE_GAME_LANGUAGE_CODE: "ja",
        CATALOG_WHOLE_GAME_BUDGET: "scrydexRequestLimit=40, maxScopesPerTurn=2",
      }),
    ).toEqual({
      productDomain: "one-piece",
      languageCode: "ja",
      budget: { ...defaultWholeGameBudget, scrydexRequestLimit: 40, maxScopesPerTurn: 2 },
    });
    expect(parseWholeGameStartInput({ CATALOG_WHOLE_GAME_PRODUCT_DOMAIN: "pokemon" })).toMatchObject({
      languageCode: null,
      budget: defaultWholeGameBudget,
    });
    expect(refusalCode(() => parseWholeGameStartInput({}))).toBe("product-domain-required");
    expect(refusalCode(() => parseWholeGameBudget("scrydexRequestLimit=-1"))).toBe("budget-invalid");
    expect(refusalCode(() => parseWholeGameBudget("unknownLimit=1"))).toBe("budget-invalid");
    expect(
      parseWholeGameSettleInput({ CATALOG_WHOLE_GAME_BATCH_ID: "batch-1", CATALOG_WHOLE_GAME_RETRY_FAILED: "true" }),
    ).toEqual({ batchId: "batch-1", retryFailed: true, resumeCancelled: false });
    expect(refusalCode(() => parseWholeGameSettleInput({}))).toBe("batch-id-required");
    expect(
      refusalCode(() =>
        parseWholeGameSettleInput({
          CATALOG_WHOLE_GAME_BATCH_ID: "batch-1",
          CATALOG_WHOLE_GAME_RESUME_CANCELLED: "yes",
        }),
      ),
    ).toBe("boolean-input-invalid");
  });
});

describe("AC1 whole-game start confirmation", () => {
  it("reads rendered participation rows and refuses ordinary start when Scrydex participates", () => {
    expect(parseProviderParticipation("scrydex", "2 / 40")).toEqual({
      providerKey: "scrydex",
      units: 2,
      plannedRequests: 40,
    });
    expect(parseProviderParticipation("tcgdex", "3 / Unavailable").plannedRequests).toBeNull();
    expect(refusalCode(() => parseProviderParticipation("tcgdex", "three"))).toBe("preview-participation-unreadable");

    const scrydex = { providerKey: "scrydex", units: 2, plannedRequests: 40 };
    expect(startConfirmationRefusal(preview(), defaultWholeGameBudget)).toBeNull();
    expect(startConfirmationRefusal(preview({ providers: [scrydex] }), defaultWholeGameBudget)).toBe(
      "scrydex-credit-limit-zero",
    );
    expect(
      startConfirmationRefusal(preview({ providers: [scrydex] }), {
        ...defaultWholeGameBudget,
        scrydexRequestLimit: 50,
      }),
    ).toBe("scrydex-host-decision-required");
    expect(
      startConfirmationRefusal(preview({ providers: [{ ...scrydex, units: 0 }] }), defaultWholeGameBudget),
    ).toBeNull();
    expect(startConfirmationRefusal(preview({ confirmAllowed: false }), defaultWholeGameBudget)).toBe(
      "preview-not-confirmable",
    );
    expect(startConfirmationRefusal(preview({ scopeCount: 0 }), defaultWholeGameBudget)).toBe("preview-empty");
    expect(startConfirmationRefusal(preview({ scopeCount: Number.NaN }), defaultWholeGameBudget)).toBe(
      "preview-scope-count-unreadable",
    );
    expect(startConfirmationRefusal(preview({ planFingerprint: "" }), defaultWholeGameBudget)).toBe(
      "preview-fingerprint-unreadable",
    );
  });
});

describe("paid whole-game preview and confirm dispatches", () => {
  const fingerprint = "a".repeat(64);
  const scrydex = { providerKey: "scrydex", units: 2, plannedRequests: 41 };

  function startProbe(live = {}, hidden = {}) {
    const actions = [];
    const fields = {};
    const confirmForm = {
      count: async () => 1,
      locator: (selector) => ({
        inputValue: async () => {
          if (selector === 'input[name="planFingerprint"]') return hidden.fingerprint ?? fingerprint;
          if (selector === 'input[name="scrydexRequestLimit"]') return hidden.limit ?? "52";
          throw new Error(`unexpected confirm field ${selector}`);
        },
      }),
      getByRole: (_role, { name }) => ({ name }),
    };
    const form = {
      locator: (selector) => selector,
      getByLabel: (label) => ({ fill: async (value) => (fields[label] = value) }),
      getByRole: (_role, { name }) => ({ name }),
    };
    const page = {
      locator: (selector) => {
        expect(selector).toBe("form");
        return { filter: ({ has }) => (has.name === "Preview batch" ? form : confirmForm) };
      },
      getByRole: (_role, { name }) => ({ name }),
      url: () => `${rehearsal.wholeGameStagingOrigin}/catalog/scopes/sync-batches?batchId=batch-requested`,
      waitForURL: async () => {},
    };
    const context = vm.createContext({
      ...rehearsal,
      URL,
      expect: () => ({ toHaveCount: async () => {}, toHaveValue: async () => {} }),
      pageReadyTimeoutMs: 1,
      syncTimeoutMs: 1,
      gotoWholeGamePage: async () => {},
      namedFormControl: async (form, name) => form.locator(`input[name="${name}"]`),
      chooseDesignSystemSelect: async () => {},
      clickWholeGameControl: async (_page, control) => actions.push(control.name),
      readRenderedBatchPreview: async () => preview({ planFingerprint: fingerprint, providers: [scrydex], ...live }),
      readWholeGameBatch: async (_page, batchId) => {
        actions.push(`Read ${batchId}`);
        return { planFingerprint: fingerprint };
      },
    });
    const declarations = ["runWholeGameJourney", "wholeGameRunIdentity", "wholeGameStart"]
      .map((name) => journeyFunction(name).getText(journeySource))
      .join("\n");
    vm.runInContext(ts.transpile(declarations), context);
    return {
      actions,
      fields,
      run: (scope, env = {}) =>
        context.runWholeGameJourney(page, scope, 0, vi.fn(), {
          GITHUB_SHA: "b".repeat(40),
          GITHUB_RUN_ID: "456",
          GITHUB_RUN_ATTEMPT: "1",
          CATALOG_WHOLE_GAME_PRODUCT_DOMAIN: "one-piece",
          CATALOG_WHOLE_GAME_LANGUAGE_CODE: "en",
          CATALOG_WHOLE_GAME_BUDGET: "scrydexRequestLimit=52",
          CATALOG_WHOLE_GAME_APPROVED_PREVIEW_FINGERPRINT: fingerprint,
          ...env,
        }),
    };
  }

  it.each([false, true])("returns a redacted receipt and never confirms a preview (confirmable=%s)", async (ready) => {
    const probe = startProbe({ confirmAllowed: ready });
    const result = await probe.run("full-game-preview", {
      CATALOG_WHOLE_GAME_BUDGET: ready ? "scrydexRequestLimit=52" : "",
      CATALOG_WHOLE_GAME_APPROVED_PREVIEW_FINGERPRINT: "",
    });
    expect(probe.actions).toEqual(["Preview batch"]);
    expect(result).toEqual({
      schemaVersion: wholeGameReceiptSchemaVersion,
      journeyScope: "full-game-preview",
      sha: "b".repeat(40),
      runId: "456",
      runAttempt: "1",
      batchId: null,
      state: "previewed",
      preview: {
        planFingerprint: fingerprint,
        scopeCount: 3,
        providers: [scrydex],
        confirmAllowed: ready,
        scrydexRequestLimit: ready ? 52 : 0,
      },
      settle: null,
    });
    expect(validateWholeGameReceipt(result)).toEqual([]);
    expect(validateWholeGameReceipt({ ...result, batchId: "batch-requested" })).toContain("preview-only-batch-id");
  });

  it("confirms exactly once after a fresh match and rounds the 25% buffer up", async () => {
    const probe = startProbe();
    const result = await probe.run("full-game-confirm");
    expect(probe.fields).toMatchObject({ Language: "en", "Scrydex credit limit": "52" });
    expect(probe.actions).toEqual(["Preview batch", "Confirm and enqueue", "Read batch-requested"]);
    expect(result).toMatchObject({ journeyScope: "full-game-confirm", state: "confirmed", batchId: "batch-requested" });
    expect(validateWholeGameReceipt(result)).toEqual([]);
  });

  it("keeps the zero-limit no-Scrydex start and leaves paid units on hold in ordinary start", async () => {
    const noScrydex = startProbe({ providers: preview().providers });
    const result = await noScrydex.run("full-game-start", {
      CATALOG_WHOLE_GAME_BUDGET: "",
      CATALOG_WHOLE_GAME_APPROVED_PREVIEW_FINGERPRINT: "",
    });
    expect(noScrydex.fields["Scrydex credit limit"]).toBe("0");
    expect(noScrydex.actions).toEqual(["Preview batch", "Confirm and enqueue", "Read batch-requested"]);
    expect(result.preview).not.toHaveProperty("scrydexRequestLimit");
    expect(validateWholeGameReceipt(result)).toEqual([]);

    const paid = startProbe();
    await expect(paid.run("full-game-start")).rejects.toMatchObject({ code: "scrydex-host-decision-required" });
    expect(paid.actions).toEqual(["Preview batch"]);
  });

  it.each([
    [{ planFingerprint: "c".repeat(64) }, {}, {}, "scrydex-approved-fingerprint-mismatch"],
    [{}, {}, { CATALOG_WHOLE_GAME_BUDGET: "scrydexRequestLimit=51" }, "scrydex-approved-limit-mismatch"],
    [{}, {}, { CATALOG_WHOLE_GAME_BUDGET: "scrydexRequestLimit=53" }, "scrydex-approved-limit-mismatch"],
    [{}, {}, { CATALOG_WHOLE_GAME_BUDGET: "" }, "scrydex-approved-limit-mismatch"],
    [{ confirmAllowed: false }, {}, {}, "preview-not-confirmable"],
    [{ providers: [] }, {}, {}, "scrydex-participation-required"],
    [{ providers: [{ ...scrydex, plannedRequests: null }] }, {}, {}, "scrydex-estimate-unavailable"],
    [{}, { fingerprint: "c".repeat(64) }, {}, "scrydex-confirm-form-mismatch"],
    [{}, { limit: "53" }, {}, "scrydex-confirm-form-mismatch"],
  ])("refuses after live preview and never confirms (%j, %j, %j: %s)", async (live, hidden, env, code) => {
    const probe = startProbe(live, hidden);
    await expect(probe.run("full-game-confirm", env)).rejects.toMatchObject({ code });
    expect(probe.actions).toEqual(["Preview batch"]);
  });

  it.each(["", "invalid"])("requires a valid approval fingerprint before preview (%s)", async (approval) => {
    const probe = startProbe();
    await expect(
      probe.run("full-game-confirm", { CATALOG_WHOLE_GAME_APPROVED_PREVIEW_FINGERPRINT: approval }),
    ).rejects.toMatchObject({ code: "scrydex-approved-fingerprint-required" });
    expect(probe.actions).toEqual([]);
  });
});

describe("AC2 whole-game settle per batch state", () => {
  const completedAndFailed = [unit("scope-1", "completed"), unit("scope-2", "failed")];

  it.each([
    ["queued", {}, settleInput(), { kind: "exit-running", reason: "in-progress" }],
    ["running", {}, settleInput({ retryFailed: true }), { kind: "exit-running", reason: "in-progress" }],
    [
      "running",
      { circuitOpenProviders: ["scrydex"] },
      settleInput({ retryFailed: true }),
      { kind: "retry-failed-units", scopeRecordIds: ["scope-2"] },
    ],
    [
      "running",
      { circuitOpenProviders: ["scrydex"] },
      settleInput(),
      { kind: "promote-and-publish", scopeRecordIds: ["scope-1"], failedUnits: 1 },
    ],
    ["partial", {}, settleInput({ retryFailed: true }), { kind: "retry-failed-units", scopeRecordIds: ["scope-2"] }],
    ["partial", {}, settleInput(), { kind: "promote-and-publish", scopeRecordIds: ["scope-1"], failedUnits: 1 }],
    ["failed", {}, settleInput({ retryFailed: true }), { kind: "retry-failed-units", scopeRecordIds: ["scope-2"] }],
    ["failed", {}, settleInput(), { kind: "promote-and-publish", scopeRecordIds: ["scope-1"], failedUnits: 1 }],
    ["cancelled", {}, settleInput(), { kind: "exit-cancelled" }],
    ["cancelled", {}, settleInput({ resumeCancelled: true }), { kind: "resume" }],
  ])("%s batch %j with %j", (status, overrides, input, expected) => {
    expect(planWholeGameSettle(batch(status, completedAndFailed, overrides), input)).toEqual(expected);
  });

  it("promotes a completed batch even when retry was requested, and never treats running as failure", () => {
    expect(
      planWholeGameSettle(batch("completed", [unit("scope-1", "completed")]), settleInput({ retryFailed: true })),
    ).toEqual({ kind: "promote-and-publish", scopeRecordIds: ["scope-1"], failedUnits: 0 });
    expect(
      planWholeGameSettle(batch("running", [unit("scope-1", "failed")]), settleInput({ retryFailed: true })).kind,
    ).toBe("exit-running");
  });

  it("refuses a snapshot for any batch other than the requested batch_id", () => {
    expect(
      refusalCode(() =>
        planWholeGameSettle(
          batch("completed", [unit("scope-1", "completed")], { batchId: "batch-newer" }),
          settleInput(),
        ),
      ),
    ).toBe("batch-id-mismatch");
  });
});

describe("AC3 idempotent promotion and publication", () => {
  it("adopts a job a killed dispatch left running instead of submitting a second promotion", () => {
    const running = promoteJob("job-killed", [], { status: "running", result: null });
    expect(planScopePromotion("scope-1", [running])).toEqual({ kind: "adopt-active-job", jobIds: ["job-killed"] });
    expect(planScopePromotion("scope-1", [{ ...running, kind: "merge-candidate-defer" }])).toEqual({
      kind: "submit-promote-all-ready",
    });
    expect(planScopePromotion("scope-1", [{ ...running, scopeRecordId: "scope-2" }])).toEqual({
      kind: "submit-promote-all-ready",
    });
  });

  it("follows the completed-job cursor to the last page and fails closed on scope drift or a repeated cursor", async () => {
    const pages = {
      "": { items: [promoteJob("job-3", [{ status: "promoted", catalogItemId: "item-3" }])], cursor: "c1" },
      c1: {
        items: [
          promoteJob("job-2", [{ status: "promoted", catalogItemId: "item-2" }]),
          promoteJob("job-defer", [], { kind: "merge-candidate-defer" }),
        ],
        cursor: "c2",
      },
      c2: { items: [promoteJob("job-1", [{ status: "promoted", catalogItemId: "item-1" }])] },
    };
    const requested = [];
    const jobs = await readAllCompletedPromoteJobs("scope-1", async (cursor) => {
      requested.push(cursor);
      return pages[cursor ?? ""];
    });
    expect(requested).toEqual([null, "c1", "c2"]);
    expect(jobs.map((job) => job.jobId)).toEqual(["job-3", "job-2", "job-1"]);

    await expect(
      readAllCompletedPromoteJobs("scope-1", async () => ({
        items: [promoteJob("job-x", [], { scopeRecordId: "scope-9" })],
      })),
    ).rejects.toMatchObject({ code: "job-scope-mismatch" });
    await expect(
      readAllCompletedPromoteJobs("scope-1", async () => ({ items: [], cursor: "same" })),
    ).rejects.toMatchObject({ code: "job-cursor-repeated" });
  });

  it("collects distinct applied Catalog Items without using historical matches", () => {
    expect(
      promotedCatalogItems([
        promoteJob(
          "job-1",
          [
            applied("candidate-2", "item-2"),
            applied("candidate-1", "item-1"),
            { status: "skipped-not-eligible", catalogItemId: null },
          ],
          { promotionApplicationVersion: 1 },
        ),
        promoteJob("job-2", [applied("candidate-1", "item-1")], { promotionApplicationVersion: 1 }),
        promoteJob("legacy", [{ candidateId: "candidate-3", status: "promoted", catalogItemId: null }]),
      ]),
    ).toEqual({ catalogItemIds: ["item-1", "item-2"], promotedOutcomes: 2, promotedWithoutCatalogItem: 1 });
  });

  it("plans one draft filter per blueprint x batch provider source x language", () => {
    expect(
      publishFilters(
        [
          { blueprintId: "bp-2", languageCode: "en" },
          { blueprintId: "bp-1", languageCode: "ja" },
          { blueprintId: "bp-1", languageCode: "ja" },
          { blueprintId: null, languageCode: "en" },
        ],
        ["tcgdex", "scrydex", "tcgdex"],
      ),
    ).toEqual([
      { blueprintId: "bp-1", source: "scrydex", language: "ja", status: "draft" },
      { blueprintId: "bp-1", source: "tcgdex", language: "ja", status: "draft" },
      { blueprintId: "bp-2", source: "scrydex", language: "en", status: "draft" },
      { blueprintId: "bp-2", source: "tcgdex", language: "en", status: "draft" },
    ]);
  });
});

describe("AC4 publish preview guard", () => {
  const filter = { blueprintId: "bp-1", source: "scrydex", language: "en", status: "draft" };
  const previewOf = (count, mutate = () => ({})) => {
    const candidates = Array.from({ length: count }, (_, index) => ({
      catalog_item_id: `item-${index + 1}`,
      blueprint_id: "bp-1",
      source_providers: ["scrydex", "tcgdex"],
      ...mutate(index),
    }));
    return { item_ids: candidates.map((candidate) => candidate.catalog_item_id), total: count, candidates };
  };
  const guard = (value, blueprints = new Set(["bp-1"])) =>
    refusalCode(() => {
      assertPublishPreviewGuard(value, filter, blueprints);
      throw new WholeGameRehearsalRefusal("passed");
    });

  it("reads every candidate beyond the 20 rendered rows", () => {
    expect(guard(previewOf(25))).toBe("passed");
    expect(guard(previewOf(25, (index) => (index === 22 ? { source_providers: ["tcgdex"] } : {})))).toBe(
      "publish-preview-row-23-missing-provider-source",
    );
    expect(guard(previewOf(25, (index) => (index === 21 ? { blueprint_id: "bp-other-game" } : {})))).toBe(
      "publish-preview-row-22-foreign-blueprint",
    );
    expect(guard(previewOf(25), new Set(["bp-other-game"]))).toBe("publish-preview-row-1-foreign-blueprint");
  });

  it("refuses a preview response that is not complete", () => {
    expect(guard({ ...previewOf(25), total: 40 })).toBe("publish-preview-incomplete");
    expect(guard({ ...previewOf(25), item_ids: previewOf(24).item_ids })).toBe("publish-preview-incomplete");
  });
});

describe("AC5 support-safe receipt schema", () => {
  const displayIdentity = {
    missingTokens: ["ink-color", "rarity"],
    templateKey: null,
    templateReason: "missing-required-fields",
  };
  const displayIdentityFailure = {
    candidateId: "candidate-display",
    status: "failed",
    failureDiagnosticCode: "promotion-plan-blocked:display-identity-unresolvable",
  };

  const failureReceipt = () =>
    receipt({
      state: "failed",
      promotionFailure: rehearsal.wholeGamePromotionFailure(
        promoteJob("failed-job", [
          { candidateId: "candidate-1", status: "failed", diagnosticCode: "asset-processing-failed" },
          { candidateId: "candidate-2", status: "failed", reason: "untrusted error text" },
        ]),
      ),
    });

  it("writes and reads a validated failure receipt, refusing unsafe replacements before writing", () => {
    const directory = mkdtempSync(join(tmpdir(), "whole-game-failure-"));
    const path = join(directory, "receipt.json");
    try {
      const context = vm.createContext({
        validateWholeGameReceipt,
        mkdirSync,
        dirname,
        writeFileSync,
        wholeGameReceiptPath: path,
      });
      vm.runInContext(ts.transpile(journeyFunction("writeWholeGameReceipt").getText(journeySource)), context);
      const diagnostic = failureReceipt();
      context.writeWholeGameReceipt(diagnostic);
      expect(existsSync(path)).toBe(true);
      expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(diagnostic);
      const enriched = {
        ...diagnostic,
        promotionFailure: rehearsal.wholeGamePromotionFailure(
          promoteJob("failed-job", [
            { ...displayIdentityFailure, displayIdentity: { ...displayIdentity, templateTargetId: "not-forwarded" } },
            { ...displayIdentityFailure, candidateId: "candidate-old" },
            {
              ...displayIdentityFailure,
              candidateId: "candidate-unresolved-title",
              displayIdentity: {
                missingTokens: ["item.unknown"],
                templateKey: "synthetic-template",
                templateReason: "unresolved-title-tokens",
              },
            },
            {
              ...displayIdentityFailure,
              candidateId: "candidate-malformed",
              displayIdentity: {
                ...displayIdentity,
                missingTokens: ["https://provider.invalid/private"],
              },
            },
            {
              ...displayIdentityFailure,
              candidateId: "candidate-other",
              failureDiagnosticCode: "promotion-reference-target-unresolved",
              displayIdentity,
            },
          ]),
        ),
      };
      context.writeWholeGameReceipt(enriched);
      expect(JSON.parse(readFileSync(path, "utf8")).promotionFailure.failedOutcomes).toEqual([
        { candidateId: "candidate-display", reasonCode: displayIdentityFailure.failureDiagnosticCode, displayIdentity },
        { candidateId: "candidate-old", reasonCode: displayIdentityFailure.failureDiagnosticCode },
        {
          candidateId: "candidate-unresolved-title",
          reasonCode: displayIdentityFailure.failureDiagnosticCode,
          displayIdentity: {
            missingTokens: ["item.unknown"],
            templateKey: "synthetic-template",
            templateReason: "unresolved-title-tokens",
          },
        },
        { candidateId: "candidate-malformed", reasonCode: displayIdentityFailure.failureDiagnosticCode },
        { candidateId: "candidate-other", reasonCode: "promotion-reference-target-unresolved" },
      ]);
      const unsafe = { ...diagnostic, promotionFailure: { ...diagnostic.promotionFailure, reason: "provider body" } };
      expect(() => context.writeWholeGameReceipt(unsafe)).toThrow(/schema validation/);
      expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(enriched);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each([
    [{ ...displayIdentity, title: "provider body" }, displayIdentityFailure.failureDiagnosticCode],
    [
      { ...displayIdentity, missingTokens: ["https://provider.invalid/private"] },
      displayIdentityFailure.failureDiagnosticCode,
    ],
    [{ ...displayIdentity, templateKey: "private provider title" }, displayIdentityFailure.failureDiagnosticCode],
    [{ ...displayIdentity, missingTokens: ["field.bearer"] }, displayIdentityFailure.failureDiagnosticCode],
    [{ ...displayIdentity, templateReason: "provider body" }, displayIdentityFailure.failureDiagnosticCode],
    [displayIdentity, "asset-processing-failed"],
  ])("rejects unsafe or misplaced display evidence: %j", (evidence, reasonCode) => {
    const diagnostic = failureReceipt();
    Object.assign(diagnostic.promotionFailure.failedOutcomes[0], { displayIdentity: evidence, reasonCode });
    expect(validateWholeGameReceipt(diagnostic)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^promotionFailure\.failedOutcomes\.0\.displayIdentity(?:\.keys)?$/),
      ]),
    );
  });

  it.each([
    ["reasonCode", "https://provider.invalid/private"],
    ["reasonCode", "new-unclassified-code"],
    ["candidateId", "x".repeat(129)],
    ["candidateId", "https://provider.invalid/candidate"],
    ["candidateId", "candidate-secret"],
    ["reason", "provider body"],
  ])("rejects unsafe or non-contract outcome evidence: %s", (key, value) => {
    const diagnostic = failureReceipt();
    diagnostic.promotionFailure.failedOutcomes[0][key] = value;
    expect(validateWholeGameReceipt(diagnostic).length).toBeGreaterThan(0);
  });

  it("never accepts failure evidence as settled or failed without evidence", () => {
    expect(validateWholeGameReceipt({ ...failureReceipt(), state: "settled" })).toContain("promotionFailure.state");
    expect(validateWholeGameReceipt(receipt({ state: "failed" }))).toContain("promotionFailure.state");
    expect(validateWholeGameReceipt({ ...failureReceipt(), settle: null })).toContain("promotionFailure.settle");
  });

  it("accepts complete start and settle receipts", () => {
    expect(validateWholeGameReceipt(receipt())).toEqual([]);
    expect(
      validateWholeGameReceipt(
        receipt({
          journeyScope: "full-game-start",
          state: "confirmed",
          settle: null,
          preview: {
            planFingerprint: "sha256:fixture-plan",
            scopeCount: 3,
            providers: [{ providerKey: "scrydex", units: 2, plannedRequests: null }],
          },
        }),
      ),
    ).toEqual([]);
  });

  it("rejects unsafe text, unknown fields and a settled claim with remaining work", () => {
    expect(validateWholeGameReceipt(receipt({ batchId: "https://admin.example/batch" }))).toEqual(
      expect.arrayContaining(["batchId", "support-unsafe-text"]),
    );
    expect(validateWholeGameReceipt({ ...receipt(), rawPayload: {} })).toContain("receipt.keys");
    expect(validateWholeGameReceipt(receipt({ settle: { ...receipt().settle, title: "Card" } }))).toContain(
      "settle.keys",
    );
    expect(validateWholeGameReceipt(receipt({ settle: { ...receipt().settle, draftsRemaining: 2 } }))).toContain(
      "settled-with-remaining-work",
    );
    expect(
      validateWholeGameReceipt(receipt({ settle: { ...receipt().settle, promotedWithoutCatalogItem: 1 } })),
    ).toContain("settled-with-remaining-work");
    expect(validateWholeGameReceipt(receipt({ sha: "main" }))).toContain("sha");
    expect(validateWholeGameReceipt(receipt({ state: "refused" }))).toContain("state");
  });
});
