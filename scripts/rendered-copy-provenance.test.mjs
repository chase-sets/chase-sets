import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  attributeRenderedCopy,
  classifyRenderedCopyDrift,
  rejectCandidateDerivedBaseline,
  renderedCopyCaptureArtifactName,
  renderedCopyClasses,
  renderedCopyFiles,
  renderedCopyGuardFootprint,
  renderedCopyOwnerRules,
  renderedCopySweepSpecs,
  renderedCopyToolPaths,
  renderedCopyTuples,
  validateCaptureRecord,
  validateOwnerMap,
  validateRenderedCopyProvenance,
} from "../infrastructure/playwright-evidence/rendered-copy.ts";
import { batchE2eSuiteIds, e2eSuites } from "./e2e-suites.mjs";

// The committed-file entrypoint: reads the toggle, baseline and record at two
// refs and checks them with the pure lifecycle validator and real git objects.
function gitRepo(cwd, headRef = "HEAD") {
  const run = (args) => spawnSync("git", args, { cwd, encoding: "utf8" });
  const out = (args) => {
    const result = run(args);
    return result.status === 0 ? result.stdout.trim() : null;
  };
  return {
    head: out(["rev-parse", "--verify", `${headRef}^{commit}`]),
    objectType: (sha) => (/^[0-9a-f]{40}$/.test(sha) ? out(["cat-file", "-t", sha]) : null),
    treeOf: (commit) => out(["rev-parse", "--verify", `${commit}^{tree}`]),
    blobAt: (commit, file) => out(["rev-parse", "--verify", `${commit}:${file}`]),
    isAncestor: (ancestor, descendant) => run(["merge-base", "--is-ancestor", ancestor, descendant]).status === 0,
    diffNames: (base, head) => {
      const names = out(["diff", "--name-only", `${base}...${head}`]);
      return names === null ? null : names.split("\n").filter(Boolean).sort();
    },
  };
}

function committedFiles(cwd, ref) {
  const read = (file) => {
    const result = spawnSync("git", ["show", `${ref}:${file}`], { cwd, encoding: "utf8" });
    return result.status === 0 ? JSON.parse(result.stdout) : undefined;
  };
  return {
    toggle: read(renderedCopyFiles.collect),
    baseline: read(renderedCopyFiles.baseline),
    record: read(renderedCopyFiles.capture),
  };
}

// Hosted pull_request checkouts are merge refs and merge_group checkouts sit on
// the queue base, so the first parent is main; elsewhere use the merge-base.
function frozenRef(cwd, event) {
  const verify = (ref) => spawnSync("git", ["rev-parse", "--verify", `${ref}^{commit}`], { cwd, encoding: "utf8" });
  if (event === "pull_request" || event === "merge_group") return verify("HEAD^1").status === 0 ? "HEAD^1" : null;
  const base = spawnSync("git", ["merge-base", "HEAD", "origin/main"], { cwd, encoding: "utf8" });
  return base.status === 0 ? base.stdout.trim() : null;
}

function checkCommittedRenderedCopy({ cwd, event, headRef = "HEAD", mainRef = frozenRef(cwd, event) }) {
  return validateRenderedCopyProvenance({
    event,
    head: committedFiles(cwd, headRef),
    main: mainRef ? committedFiles(cwd, mainRef) : {},
    repo: gitRepo(cwd, headRef),
  });
}

const sha = (seed) => seed.repeat(40).slice(0, 40);
const zero = Object.fromEntries(renderedCopyClasses.map((kind) => [kind, 0]));
const browserSuites = e2eSuites
  .filter(({ deployable }) => deployable === "marketplace" || deployable === "admin-web")
  .map(({ id }) => id);
const offers = "/account/offers/submitted";
const integrations = "/catalog/integrations";

// A complete, valid capture over the 32-tuple census with three fields: one
// anticipated Offer owner, the conditional Catalog attention owner and one
// unanticipated Catalog field the host must file before INTEGRATED.
function buildRecord({ base, head, diff, toolBlob, specBlob }) {
  const fields = [
    {
      page: offers,
      class: "seed-id",
      selector: "main",
      label: null,
      prefix: "off_",
      token: "SB8-COPY-01",
      issue: 9937,
      count: 2,
      samples: ["off_seed_surging_sparks_restock"],
    },
    {
      page: integrations,
      class: "iso-instant",
      selector: '[data-catalog-attention-queue="true"]',
      label: null,
      prefix: null,
      token: "SB8-COPY-06",
      issue: 8720,
      count: 1,
      samples: ["2026-10-17T21:22"],
    },
    {
      page: integrations,
      class: "iso-instant",
      selector: "main",
      label: "Changed",
      prefix: null,
      token: null,
      issue: null,
      count: 1,
      samples: ["2026-10-17T21:23"],
    },
  ];
  const batches = batchE2eSuiteIds(browserSuites).map((batch, jobIndex) => {
    const suites = batch.split(",");
    const owned = renderedCopyTuples.filter((tuple) => suites.includes(tuple.suite));
    const listing = [{ path: "deployables/marketplace/e2e/browse.spec.ts", blob: specBlob, tests: 2 }];
    for (const deployable of ["marketplace", "admin-web"]) {
      const count = owned.filter((tuple) => tuple.deployable === deployable).length;
      if (count > 0) listing.push({ path: renderedCopySweepSpecs[deployable], blob: specBlob, tests: count + 1 });
    }
    return {
      batch,
      jobIndex,
      eligibility: "owning",
      attempt: 1,
      checkout: sha("d"),
      artifact: {
        name: renderedCopyCaptureArtifactName(4242, 1, jobIndex),
        sha256: sha("e").repeat(2).slice(0, 64),
        bytes: 4096,
      },
      listing,
      owned,
    };
  });
  const tuples = batches.flatMap(({ batch, jobIndex, owned, listing }) =>
    owned.map((tuple) => {
      const start = listing
        .slice(
          0,
          listing.findIndex((group) => group.path === renderedCopySweepSpecs[tuple.deployable]),
        )
        .reduce((sum, group) => sum + group.tests, 0);
      const position = start + 1 + owned.filter((entry) => entry.deployable === tuple.deployable).indexOf(tuple);
      const counts = { ...zero };
      for (const field of fields.filter((entry) => entry.page === tuple.page)) counts[field.class] += field.count;
      return {
        ...tuple,
        retry: 0,
        durationMs: 60_000,
        position,
        witness: tuple.page === "/account/sell-list" ? "sell-list-empty" : "populated",
        counts,
        batch,
        jobIndex,
      };
    }),
  );
  return {
    schema: "rendered-copy-capture/v1",
    run: {
      workflow: "platform-pr.yml",
      event: "pull_request",
      id: 4242,
      attempt: 1,
      capturedAt: "2026-10-18T05:00:00.000Z",
    },
    checkout: { commit: sha("d"), tree: sha("f"), parents: [base.commit, head.commit] },
    base,
    head,
    diff,
    tools: renderedCopyToolPaths.map((file) => ({ path: file, blob: toolBlob(file) })),
    batches: [
      ...batches.map(({ owned: _owned, ...batch }) => batch),
      {
        batch: "platform_mcp_sdk",
        jobIndex: 6,
        eligibility: "nonowning",
        attempt: null,
        checkout: null,
        artifact: null,
        listing: [],
      },
      {
        batch: "tcgplayer_operator_extension",
        jobIndex: 7,
        eligibility: "scope-skipped",
        attempt: null,
        checkout: null,
        artifact: null,
        listing: [],
      },
    ],
    tuples,
    fields,
    baseAbsent: renderedCopyOwnerRules
      .filter((rule) => !fields.some((field) => field.token === rule.token && field.issue === rule.issue))
      .map(({ token, page, class: kind, issue }) => ({ token, page, class: kind, issue })),
  };
}

const integratedBaseline = (record, gapIssue = 10001) => ({
  schema: "rendered-copy-baseline/v1",
  rows: record.fields
    .map(({ page, class: kind, selector, label, prefix, token, issue, count }) => ({
      page,
      class: kind,
      selector,
      label,
      prefix,
      token,
      issue: issue ?? gapIssue,
      maxCount: count,
    }))
    .sort((left, right) =>
      left.page < right.page
        ? -1
        : left.page > right.page
          ? 1
          : left.class < right.class
            ? -1
            : left.class > right.class
              ? 1
              : left.issue - right.issue,
    ),
});

const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const clone = (value) => structuredClone(value);
const messages = (result) => result.violations.join("\n");

describe("committed rendered-copy files", () => {
  it("pass the full-history lifecycle check on this trigger path", () => {
    const event = process.env.GITHUB_EVENT_NAME ?? "local";
    const result = checkCommittedRenderedCopy({ cwd: process.cwd(), event });
    console.log(`rendered-copy committed state ${result.state} on ${event}`);
    expect(result.violations).toEqual([]);
    expect(["ABSENT", "PROPOSED", "INTEGRATED", "LANDED", "STEADY_STATE"]).toContain(result.state);
  });

  it("pins the census, classes, owners and footprint the record binds", () => {
    expect(renderedCopyTuples).toHaveLength(32);
    expect(new Set(renderedCopyTuples.map((tuple) => `${tuple.deployable} ${tuple.persona} ${tuple.page}`)).size).toBe(
      32,
    );
    expect([...new Set(renderedCopyTuples.map((tuple) => tuple.suite))].sort()).toEqual([
      "admin_access",
      "admin_commerce",
      "admin_growth",
      "admin_support",
      "catalog_admin_integrations",
      "catalog_admin_modeling",
      "marketplace_account",
      "marketplace_seller",
    ]);
    expect(renderedCopyClasses).toHaveLength(6);
    expect(renderedCopyOwnerRules.map(({ token, page, class: kind, issue }) => [token, page, kind, issue])).toEqual([
      ["SB8-COPY-01", offers, "seed-id", 9937],
      ["SB8-COPY-02", "/account/channels/connection-seed-tcgplayer-manual", "iso-instant", 9938],
      ["SB8-COPY-03", "/account/channels/publication/connection-seed-tcgplayer-manual", "seed-id", 8776],
      ["SB8-COPY-04", "/growth/google-shopping", "seed-id", 8867],
      ["SB8-COPY-05", "/access/accounts/acc_seed_demo_account?tab=audit", "typed-id", 8721],
      ["SB8-COPY-06", integrations, "iso-instant", 8720],
      ["SB8-COPY-06", integrations, "iso-instant", 9939],
    ]);
    for (const rule of renderedCopyOwnerRules)
      expect(
        renderedCopyTuples.some((tuple) => tuple.page === rule.page),
        rule.token,
      ).toBe(true);
    const tracked = new Set(execFileSync("git", ["ls-files"], { encoding: "utf8" }).split("\n"));
    for (const file of renderedCopyToolPaths) expect(tracked.has(file), file).toBe(true);
    for (const file of renderedCopyToolPaths.filter((entry) => entry !== "playwright.config.ts")) {
      expect(renderedCopyGuardFootprint, file).toContain(file);
    }
  });
});

describe("rendered-copy lifecycle over real git objects", () => {
  let repo;
  let refs;
  let record;
  const run = (...args) =>
    execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const write = (file, content) => {
    mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
    writeFileSync(path.join(repo, file), content);
  };
  const commit = (message) => {
    run("add", "--all");
    run(
      "-c",
      "user.name=fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--quiet",
      "--allow-empty",
      "-m",
      message,
    );
    return run("rev-parse", "HEAD");
  };
  const variant = (from, files) => {
    run("checkout", "--quiet", "--detach", from);
    for (const [file, content] of Object.entries(files)) {
      if (content === null) rmSync(path.join(repo, file), { force: true });
      else write(file, typeof content === "string" ? content : json(content));
    }
    return commit("variant");
  };
  const check = (headRef, mainRef, event = "pull_request") =>
    checkCommittedRenderedCopy({ cwd: repo, event, headRef, mainRef });

  beforeAll(() => {
    repo = mkdtempSync(path.join(os.tmpdir(), "rendered-copy-provenance-"));
    run("init", "--quiet");
    write("bounded-contexts/catalog/product.ts", "export const value = 1;\n");
    write("deployables/marketplace/e2e/browse.spec.ts", "browse\n");
    for (const file of renderedCopyToolPaths) write(file, `${file} v1\n`);
    const B = commit("B");
    run("checkout", "--quiet", "-b", "side");
    write("bounded-contexts/catalog/product.ts", "export const value = 2;\n");
    const X = commit("X");
    run("checkout", "--quiet", "--detach", B);
    write("infrastructure/playwright-evidence/rendered-copy.ts", "rendered-copy v2\n");
    write(renderedCopyFiles.collect, json({ schema: "rendered-copy-collect/v1", enabled: true }));
    write(renderedCopyFiles.baseline, json({ schema: "rendered-copy-baseline/v1", rows: [] }));
    const H = commit("H capture head");
    const tree = (commit) => run("rev-parse", `${commit}^{tree}`);
    record = buildRecord({
      base: { commit: B, tree: tree(B) },
      head: { commit: H, tree: tree(H) },
      diff: [
        renderedCopyFiles.baseline,
        renderedCopyFiles.collect,
        "infrastructure/playwright-evidence/rendered-copy.ts",
      ].sort(),
      toolBlob: (file) => run("rev-parse", `${H}:${file}`),
      specBlob: run("rev-parse", `${H}:deployables/marketplace/e2e/browse.spec.ts`),
    });
    const I = variant(H, {
      [renderedCopyFiles.capture]: record,
      [renderedCopyFiles.baseline]: integratedBaseline(record),
      [renderedCopyFiles.collect]: null,
    });
    refs = { B, X, H, I, tree };
  });
  afterAll(() => rmSync(repo, { recursive: true, force: true }));

  it("walks PROPOSED -> INTEGRATED -> LANDED -> STEADY_STATE", () => {
    expect(check(refs.H, refs.B)).toEqual({ state: "PROPOSED", violations: [] });
    expect(check(refs.I, refs.B)).toEqual({ state: "INTEGRATED", violations: [] });
    expect(check(refs.I, refs.B, "merge_group")).toEqual({ state: "LANDED", violations: [] });
    expect(check(refs.I, refs.I)).toEqual({ state: "STEADY_STATE", violations: [] });
    expect(check(refs.B, refs.B)).toEqual({ state: "ABSENT", violations: [] });
  });

  it("validateRenderedCopyProvenance fails a wrong B tree through the committed-file entrypoint", () => {
    const mutant = clone(record);
    mutant.base.tree = refs.tree(refs.H);
    const head = variant(refs.I, { [renderedCopyFiles.capture]: mutant });
    expect(messages(check(head, refs.B))).toContain(`is not the tree of B ${refs.B}`);
  });

  it.each([
    [
      "non-ancestor B",
      (mutant) => {
        mutant.base = { commit: refs.X, tree: refs.tree(refs.X) };
        mutant.checkout.parents = [refs.X, refs.H];
      },
      "is not an ancestor of",
    ],
    [
      "missing blob",
      (mutant) => {
        mutant.tools[0].blob = sha("9");
      },
      `blob ${sha("9")} is missing`,
    ],
    [
      "wrong attempt",
      (mutant) => {
        mutant.batches[2].attempt = 2;
      },
      "mixed attempts",
    ],
    [
      "parents not [B, PR head]",
      (mutant) => {
        mutant.checkout.parents = [refs.H, refs.B];
      },
      "must be [B, PR head]",
    ],
    [
      "product diff",
      (mutant) => {
        mutant.diff = [...mutant.diff, "bounded-contexts/catalog/product.ts"].sort();
      },
      "product diff outside the guard footprint: bounded-contexts/catalog/product.ts",
    ],
  ])("rejects the %s mutant", (_name, mutate, expected) => {
    const mutant = clone(record);
    mutate(mutant);
    const head = variant(refs.I, { [renderedCopyFiles.capture]: mutant });
    expect(messages(check(head, refs.B))).toContain(expected);
  });

  it("rejects a present toggle on an enforced committed-record head and on every merge_group", () => {
    const enabled = { [renderedCopyFiles.collect]: { schema: "rendered-copy-collect/v1", enabled: true } };
    expect(messages(check(variant(refs.I, enabled), refs.B))).toContain(
      "an enforced committed-record head requires its absence",
    );
    expect(messages(check(refs.H, refs.B, "merge_group"))).toContain("every merge_group requires its absence");
    const disabled = { [renderedCopyFiles.collect]: { schema: "rendered-copy-collect/v1", enabled: false } };
    expect(messages(check(variant(refs.H, disabled), refs.B))).toContain("a present toggle must enable capture");
  });

  it("passes an unchanged-record tool edit and a later decrement, and rejects increases and new keys", () => {
    const decremented = integratedBaseline(record);
    decremented.rows.find((row) => row.page === offers).maxCount = 1;
    const tool = { "infrastructure/playwright-evidence/rendered-copy.ts": "rendered-copy v3\n" };
    const edited = variant(refs.I, tool);
    expect(check(edited, refs.I)).toEqual({ state: "STEADY_STATE", violations: [] });
    const lowered = variant(edited, { [renderedCopyFiles.baseline]: decremented });
    expect(check(lowered, edited)).toEqual({ state: "STEADY_STATE", violations: [] });
    const raised = variant(lowered, { [renderedCopyFiles.baseline]: integratedBaseline(record) });
    expect(messages(check(raised, lowered))).toContain("increases from 1 to 2 without an authorized capture");
    const extra = integratedBaseline(record);
    extra.rows.push({
      page: "/support",
      class: "seed-id",
      selector: "main",
      label: null,
      prefix: null,
      token: null,
      issue: 10002,
      maxCount: 1,
    });
    expect(messages(check(variant(refs.I, { [renderedCopyFiles.baseline]: extra }), refs.I))).toContain(
      "new key /support seed-id",
    );
  });

  it("keeps landed history immutable and refuses tool drift between capture and integration", () => {
    const rewritten = clone(record);
    rewritten.fields[0].count = 3;
    rewritten.tuples.find((tuple) => tuple.page === offers).counts["seed-id"] = 3;
    const rewrittenBaseline = integratedBaseline(rewritten);
    const head = variant(refs.I, {
      [renderedCopyFiles.capture]: rewritten,
      [renderedCopyFiles.baseline]: rewrittenBaseline,
    });
    expect(messages(check(head, refs.I))).toContain("history is immutable");
    const drifted = variant(refs.I, { "scripts/run-e2e-suite.mjs": "changed after capture\n" });
    expect(messages(check(drifted, refs.B))).toContain("scripts/run-e2e-suite.mjs changed after capture");
  });

  it("requires the baseline to equal the record and every unanticipated field to cite a filed gap", () => {
    const short = integratedBaseline(record);
    short.rows = short.rows.filter((row) => row.token !== null);
    const failure = messages(
      check(
        variant(refs.H, {
          [renderedCopyFiles.capture]: record,
          [renderedCopyFiles.baseline]: short,
          [renderedCopyFiles.collect]: null,
        }),
        refs.B,
      ),
    );
    expect(failure).toContain("requires a filed fixed-scope gap cited by the baseline before INTEGRATED");
    expect(failure).toContain("baseline is missing captured");
  });

  it("forces INVALIDATED -> PROPOSED on unchanged-main drift and attributes candidate product diffs", () => {
    const baseline = integratedBaseline(record);
    const observed = baseline.rows.map(({ maxCount, issue: _issue, ...field }) => ({
      ...field,
      count: field.page === offers ? 3 : maxCount,
    }));
    const main = sha("7");
    const invalidated = classifyRenderedCopyDrift({
      record,
      baseline,
      observed,
      productDiff: [renderedCopyFiles.baseline],
      main,
    });
    expect(invalidated).toMatchObject({ state: "INVALIDATED", next: "PROPOSED", range: `${refs.B}..${main}` });
    expect(invalidated.drift).toEqual([
      `${offers} seed-id field selector="main" prefix="off_" SB8-COPY-01: baseline 2, observed 3`,
    ]);
    expect(
      classifyRenderedCopyDrift({
        record,
        baseline,
        observed,
        productDiff: ["bounded-contexts/catalog/product.ts"],
        main,
      }).state,
    ).toBe("CANDIDATE_DRIFT");
    expect(
      classifyRenderedCopyDrift({
        record,
        baseline,
        observed: baseline.rows.map(({ maxCount, issue: _issue, ...field }) => ({ ...field, count: maxCount })),
        productDiff: [],
        main,
      }).state,
    ).toBe("MATCH");
  });
});

describe("validateCaptureRecord", () => {
  const base = { commit: sha("1"), tree: sha("2") };
  const head = { commit: sha("3"), tree: sha("4") };
  const valid = () =>
    buildRecord({ base, head, diff: [renderedCopyFiles.baseline], toolBlob: () => sha("5"), specBlob: sha("6") });

  it("accepts a complete capture, including nonowning and scope-skipped batches as ineligible", () => {
    expect(validateCaptureRecord(valid())).toEqual([]);
  });

  it.each([
    ["wrong parents", (record) => (record.checkout.parents = [head.commit, base.commit]), "must be [B, PR head]"],
    [
      "product diff",
      (record) => (record.diff = ["bounded-contexts/catalog/product.ts"]),
      "product diff outside the guard footprint",
    ],
    ["incomplete tuples", (record) => record.tuples.pop(), "incomplete census"],
    ["incomplete classes", (record) => delete record.tuples[0].counts["iso-instant"], 'missing key "iso-instant"'],
    ["missing predecessor", (record) => record.batches[0].listing.shift(), "a predecessor is missing or reordered"],
    ["missing predecessor blob", (record) => (record.batches[0].listing[0].blob = ""), "missing predecessor blob"],
    ["missing artifact", (record) => (record.batches[1].artifact = null), "missing its capture artifact"],
    ["missing digest", (record) => (record.batches[1].artifact.sha256 = ""), "missing digest"],
    ["mixed attempts", (record) => (record.batches[1].attempt = 2), "mixed attempts"],
    ["mixed checkouts", (record) => (record.batches[1].checkout = sha("8")), "mixed checkouts"],
    [
      "duplicate owners",
      (record) => record.fields.push({ ...record.fields[0], selector: "section" }),
      "duplicate owner",
    ],
    ["nested unknown key", (record) => (record.tuples[0].counts.extra = 0), 'unknown key "extra"'],
    ["date-only instant", (record) => (record.run.capturedAt = "2026-10-18"), "timezone-bearing instant"],
    [
      "local instant without zone",
      (record) => (record.run.capturedAt = "2026-10-18T05:00:00"),
      "timezone-bearing instant",
    ],
    ["out-of-range duration", (record) => (record.tuples[0].durationMs = 25 * 60 * 1000), "must be under 25 minutes"],
    [
      "diagnostics-only artifact",
      (record) => (record.batches[0].artifact.name = "responsive-evidence-4242-1-0"),
      "diagnostics cannot substitute",
    ],
    [
      "eligible batch missing its part",
      (record) => Object.assign(record.batches[0], { artifact: null, listing: [] }),
      "missing its capture artifact",
    ],
    [
      "owning batch marked nonowning",
      (record) => (record.batches[0].eligibility = "nonowning"),
      "an owning batch is eligible, not nonowning",
    ],
    [
      "retried tuple counted twice",
      (record) => record.tuples.push(clone(record.tuples[0])),
      "retried tuples must count once",
    ],
    ["split owners that do not sum", (record) => (record.fields[0].count = 1), "fields sum to 1 but 2 were observed"],
  ])("rejects %s", (_name, mutate, expected) => {
    const record = valid();
    mutate(record);
    expect(validateCaptureRecord(record).join("\n")).toContain(expected);
  });
});

describe("rejectCandidateDerivedBaseline", () => {
  const record = buildRecord({
    base: { commit: sha("1"), tree: sha("2") },
    head: { commit: sha("3"), tree: sha("4") },
    diff: [],
    toolBlob: () => sha("5"),
    specBlob: sha("6"),
  });

  it("accepts base-captured values and a later decrement of the frozen baseline", () => {
    const frozen = integratedBaseline(record);
    expect(rejectCandidateDerivedBaseline({ baseline: frozen, record })).toEqual([]);
    const lowered = clone(frozen);
    lowered.rows[0].maxCount -= 1;
    expect(rejectCandidateDerivedBaseline({ baseline: lowered, record, frozenBaseline: frozen })).toEqual([]);
  });

  it("rejects candidate-derived increases, new keys and re-owned fields", () => {
    const candidate = integratedBaseline(record);
    candidate.rows[0].maxCount += 1;
    expect(rejectCandidateDerivedBaseline({ baseline: candidate, record }).join("\n")).toContain(
      "increases above captured count",
    );
    const added = integratedBaseline(record);
    added.rows.push({ ...added.rows[0], page: "/support", issue: 10003 });
    expect(rejectCandidateDerivedBaseline({ baseline: added, record }).join("\n")).toContain("new key /support");
    const reowned = integratedBaseline(record);
    reowned.rows.find((row) => row.token === "SB8-COPY-01").issue = 8744;
    expect(rejectCandidateDerivedBaseline({ baseline: reowned, record }).join("\n")).toContain(
      "its captured owner is 9937",
    );
  });
});

describe("validateOwnerMap and the reviewed owner rule", () => {
  const occurrence = (text, within, label = null, region = "main", kind = "iso-instant") => ({
    class: kind,
    text,
    region,
    label,
    path: "body > main",
    within,
  });
  const integrationRules = renderedCopyOwnerRules.filter((rule) => rule.page === integrations);
  const selectors = [...new Set(integrationRules.map((rule) => rule.selector))];
  // `within` mirrors the in-page closest() checks: the attention panel sits inside main.
  const inAttention = selectors.map(() => true);
  const outsideAttention = selectors.map((selector) => selector === "main");

  it("routes the conditional Catalog fields to their exact owners and reports unanticipated fields", () => {
    const { fields, violations } = attributeRenderedCopy(
      integrations,
      [
        occurrence("2026-10-17T21:22", inAttention),
        occurrence("2026-10-17T21:20", outsideAttention, "Recent count spend"),
        occurrence("2026-10-17T21:23", outsideAttention, "Changed"),
      ],
      renderedCopyOwnerRules,
    );
    expect(violations).toEqual([]);
    expect(fields.map(({ selector, label, token, issue, count }) => [selector, label, token, issue, count])).toEqual([
      ['[data-catalog-attention-queue="true"]', null, "SB8-COPY-06", 8720, 1],
      ["main", "Changed", null, null, 1],
      ["main", "Recent count spend", "SB8-COPY-06", 9939, 1],
    ]);
    const tuples = [{ page: integrations, counts: { ...zero, "iso-instant": 3 } }];
    expect(validateOwnerMap({ fields, tuples })).toEqual([]);
    expect(validateOwnerMap({ fields, tuples, baseline: [] }).join("\n")).toContain(
      'unanticipated /catalog/integrations iso-instant field selector="main" label="Changed" (unanticipated) requires a filed fixed-scope gap',
    );
  });

  it("refuses an occurrence two owners claim and a prefix-less value riding a prefixed owner", () => {
    const both = attributeRenderedCopy(
      integrations,
      [occurrence("2026-10-17T21:22", inAttention, "Recent count spend")],
      renderedCopyOwnerRules,
    );
    expect(both.violations.join("\n")).toContain("duplicate owners");
    const seller = attributeRenderedCopy(
      offers,
      [occurrence("acc_seed_seller", [true], null, "main", "seed-id")],
      renderedCopyOwnerRules,
    );
    expect(seller.fields).toEqual([
      expect.objectContaining({ token: null, issue: null, samples: ["acc_seed_seller"] }),
    ]);
  });

  it("fails duplicate owners and owners that do not sum to the observed count", () => {
    const field = {
      page: offers,
      class: "seed-id",
      selector: "main",
      label: null,
      prefix: "off_",
      token: "SB8-COPY-01",
      issue: 9937,
      count: 2,
      samples: ["off_seed_x"],
    };
    const tuples = [{ page: offers, counts: { ...zero, "seed-id": 2 } }];
    expect(validateOwnerMap({ fields: [field, { ...field, selector: "section" }], tuples }).join("\n")).toContain(
      "duplicate owner",
    );
    expect(validateOwnerMap({ fields: [{ ...field, count: 1 }], tuples }).join("\n")).toContain(
      "fields sum to 1 but 2 were observed",
    );
  });
});
