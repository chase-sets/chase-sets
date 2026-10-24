import { readFileSync } from "node:fs";
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
          if (!expanded) throw new rehearsal.WholeGameDeadlineReached();
        },
        toHaveCount: async () => {},
      }),
      readAllCompletedPromoteJobs: async () => [],
      readWholeGameJson: async () => ({ items: [] }),
      gotoWholeGamePage: async () => {},
      wholeGameRemainingMs: () => 1_000,
      clickWholeGameControl: async (_page, control) => {
        if (control === promoteButton && !expanded) throw new Error("click timeout");
        posted = true;
      },
      readActivePromoteJobs: async () => [],
    });
    vm.runInContext(ts.transpile(declarations, { target: ts.ScriptTarget.ES2022 }), context);
    const startedAt = Date.now();
    await expect(
      context.submitPromoteAllReady(page, "scope-1", [], runtime),
    ).rejects.toBeInstanceOf(rehearsal.WholeGameDeadlineReached);
    expect(Date.now() - startedAt).toBeLessThan(10_000);
    expect(posted).toBe(false);
  });

  it("AC1 orders the origin assertion, review expansion, and promotion click", () => {
    const source = journeyFunction("submitPromoteAllReady").getText(journeySource);
    const count = source.indexOf("await expect(form).toHaveCount(1");
    const origin = source.indexOf("assertWholeGameOrigin(page.url())", count);
    const expansion = source.indexOf('expandWorkflowStage(page, "review-changes"', origin);
    const click = source.indexOf('clickWholeGameControl(page, form.getByRole("button", { name: "Promote all ready"', expansion);
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
  it.each([
    "https://production.invalid",
    "http://admin.staging.chasesets.com",
    "https://user@admin.staging.chasesets.com",
    "https://admin.staging.chasesets.com/",
    "https://admin.staging.chasesets.com?next=evil",
  ])("refuses %s before the credential job", (target) => {
    const failures = [];
    vm.runInNewContext(step.with.script, {
      process: {
        env: {
          EXPECTED_SHA: "a".repeat(40),
          RUN_SHA: "a".repeat(40),
          CONFIRMATION: "run catalog staging provider uat",
          JOURNEY_SCOPE: "full-game-settle",
          ADMIN_WEB_URL: target,
        },
      },
      core: { setFailed: (message) => failures.push(message) },
    });
    expect(failures).toHaveLength(1);
  });
  it("admits the exact staging origin and leaves other journeys unchanged", () => {
    for (const [scope, target] of [
      ["full-game-start", "https://admin.staging.chasesets.com"],
      ["one-piece-launch", "https://synthetic.invalid"],
    ]) {
      const failures = [];
      vm.runInNewContext(step.with.script, {
        process: {
          env: {
            EXPECTED_SHA: "a".repeat(40),
            RUN_SHA: "a".repeat(40),
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
  it("refuses redirected effective origins without invoking the guarded action", async () => {
    const action = vi.fn();
    expect(() => rehearsal.assertWholeGameOrigin("https://redirect.invalid/access/sign-in")).toThrow(
      /staging-origin-required/,
    );
    expect(action).not.toHaveBeenCalled();
  });
});

describe("AC8 bounded complete reads", () => {
  function settleProbe({ delay = 0, stall = false } = {}) {
    const file = readFileSync(
      new URL("../deployables/admin-web/e2e/catalog-staging-provider-sync.uat.spec.ts", import.meta.url),
      "utf8",
    );
    const source = ts.createSourceFile("journey.ts", file, ts.ScriptTarget.Latest, true);
    const names = new Set(["wholeGameSettle", "wholeGameQuery", "promoteJobsPath", "draftItemsPath"]);
    const functions = source.statements.filter((node) => ts.isFunctionDeclaration(node) && names.has(node.name?.text));
    expect(functions).toHaveLength(4);
    const declarations = functions.map((node) => node.getText(source)).join("\n");
    const jobs = [
      promoteJob(
        "history",
        Array.from({ length: 10 }, (_, index) => applied(`candidate-${index}`, `item-${index}`)),
        { promotionApplicationVersion: 1 },
      ),
    ];
    const zeroJob = promoteJob("zero", [], { promotionApplicationVersion: 1 });
    const reads = [];
    const publish = vi.fn();
    let deadline;
    const read = async (_page, path) =>
      rehearsal.readBeforeWholeGameDeadline(deadline, async () => {
        reads.push(path);
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
      gotoWholeGamePage: async () => {},
      readWholeGameBatch: async () => ({
        ...batch("completed", [unit("scope-1", "completed")]),
        planFingerprint: "sha256:fixture-plan",
      }),
      readActivePromoteJobs: async () => [],
      submitPromoteAllReady: async () => "zero",
      waitForPromoteJob: async () => zeroJob,
      readWholeGameJson: read,
      readReadyCandidateCount: async () => 0,
      readWholeGameTotal: async () => 0,
      publishThroughCatalogItems: publish,
    });
    vm.runInContext(ts.transpile(declarations, { target: ts.ScriptTarget.ES2022 }), context);
    return {
      reads,
      publish,
      run: (budget) => {
        deadline = Date.now() + budget;
        return context.wholeGameSettle(
          {},
          settleInput(),
          { sha: "a".repeat(40), runId: "123", runAttempt: "1" },
          { deadlineAt: deadline, pollMs: 1 },
        );
      },
    };
  }
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
  it("reads rendered participation rows and refuses confirmation when Scrydex participates with a zero limit", () => {
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
        scrydexRequestLimit: 40,
      }),
    ).toBeNull();
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
