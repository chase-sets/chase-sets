import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  operatorEvidenceIdentity,
  operatorFileInventory,
  prepareOperatorEvidence,
  scanOperatorPayload,
} from "./prepare-operator-extension-evidence.mjs";

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "synthetic-operator-evidence-"));
  roots.push(root);
  const input = join(root, "input"),
    output = join(root, "output"),
    dist = join(root, "dist");
  mkdirSync(input);
  mkdirSync(dist);
  for (const path of ["manifest.json", "background.js", "popup.html", "sandbox.html"])
    writeFileSync(join(dist, path), "synthetic-build");
  const identity = {
    sourceHead: "1".repeat(40),
    checkoutHead: "2".repeat(40),
    runId: "123",
    runAttempt: "2",
    job: "e2e",
    jobIndex: "3",
    suite: "tcgplayer_operator_extension",
  };
  const producer = {
    schemaVersion: 1,
    identity,
    status: "passed",
    tests: [
      { id: "build", retry: 0, status: "passed", durationMs: 10 },
      { id: "chromium", retry: 0, status: "passed", durationMs: 20 },
    ],
  };
  const handoff = {
    schemaVersion: 1,
    identity,
    extensionId: "ghemdloifdkoadnapmigabiekchlholm",
    version: "0.1.0",
    twoBuildsIdentical: true,
    files: operatorFileInventory(dist),
  };
  const progress = {
    identity,
    handoffSenders: [
      {
        case: "staging-top-frame",
        delivered: true,
        origin: "https://admin.staging.chasesets.com",
        url: "https://admin.staging.chasesets.com/catalog/providers/tcgplayer",
        frameId: 0,
        tabPresent: true,
        id: null,
        outcome: "paired",
      },
      {
        case: "production-top-frame",
        delivered: true,
        origin: "https://admin.chasesets.com",
        url: "https://admin.chasesets.com/catalog/providers/tcgplayer",
        frameId: 0,
        tabPresent: true,
        id: null,
        outcome: "paired",
      },
      {
        case: "staging-other-path",
        delivered: true,
        origin: "https://admin.staging.chasesets.com",
        url: "https://admin.staging.chasesets.com/catalog/providers/other",
        frameId: 0,
        tabPresent: true,
        id: null,
        outcome: "refused",
      },
      {
        case: "staging-same-origin-subframe",
        delivered: true,
        origin: "https://admin.staging.chasesets.com",
        url: "https://admin.staging.chasesets.com/catalog/providers/tcgplayer",
        frameId: 6,
        tabPresent: true,
        id: null,
        outcome: "refused",
      },
      {
        case: "staging-about-blank-child",
        delivered: false,
        origin: null,
        url: null,
        frameId: null,
        tabPresent: null,
        id: null,
        outcome: "undelivered",
      },
      {
        case: "staging-sandboxed-opaque-frame",
        delivered: true,
        origin: "null",
        url: "https://admin.staging.chasesets.com/catalog/providers/tcgplayer",
        frameId: 10,
        tabPresent: true,
        id: null,
        outcome: "refused",
      },
      {
        case: "http-staging-top-frame",
        delivered: false,
        origin: null,
        url: null,
        frameId: null,
        tabPresent: null,
        id: null,
        outcome: "undelivered",
      },
      {
        case: "disallowed-origin-top-frame",
        delivered: false,
        origin: null,
        url: null,
        frameId: null,
        tabPresent: null,
        id: null,
        outcome: "undelivered",
      },
    ],
    stages: [
      "launch",
      "launched",
      "worker",
      "setup-connected",
      "popup-open",
      "paired",
      "isolated",
      "compatible-reloaded",
      "unknown-reloaded",
      "unknown-popup-opened",
      "unknown-popup-attached",
      "unknown-sandbox-ready",
      "unknown-status-proved",
      "unknown-record-preserved",
      "reload-proved",
    ],
  };
  const save = () => {
    writeFileSync(join(input, "producer.json"), JSON.stringify(producer));
    writeFileSync(join(input, "handoff.json"), JSON.stringify(handoff));
    writeFileSync(join(input, "chromium-stages.json"), JSON.stringify(progress));
  };
  save();
  return { input, output, dist, identity, producerOutcome: "success", producer, handoff, progress, save };
}

describe("operator-only hosted evidence", () => {
  it("accepts delayed correct exact-head output without elapsed-time assertions", () => {
    const f = fixture();
    const runGit = (_file, args, options) =>
      options.timeout === undefined && options.killSignal === undefined
        ? { status: 0, stdout: `${f.identity.checkoutHead}\n` }
        : {
            status: null,
            signal: "SIGTERM",
            stdout: "",
            error: Object.assign(new Error("spawnSync git ETIMEDOUT"), { code: "ETIMEDOUT" }),
          };
    const env = {
      OPERATOR_EVIDENCE_SOURCE_HEAD: f.identity.sourceHead,
      GITHUB_RUN_ID: f.identity.runId,
      GITHUB_RUN_ATTEMPT: f.identity.runAttempt,
      GITHUB_JOB: f.identity.job,
      OPERATOR_EVIDENCE_JOB_INDEX: f.identity.jobIndex,
    };
    expect(operatorEvidenceIdentity(f.input, env, { runGit })).toEqual(f.identity);
  });

  it.each([
    ["malformed identity", () => ({ status: 0, stdout: "not-a-head\n" }), "malformed HEAD"],
    ["nonzero", () => ({ status: 1, stdout: "", stderr: "fatal" }), "status 1"],
    ["terminated", () => ({ status: null, signal: "SIGTERM", stdout: "" }), "terminated by SIGTERM"],
    ["error", () => ({ status: null, stdout: "", error: new Error("spawnSync git ETIMEDOUT") }), "ETIMEDOUT"],
    ["missing", () => undefined, "no result"],
  ])("rejects %s exact-head Git state", (_name, runGit, message) => {
    expect(() => operatorEvidenceIdentity(fixture().input, {}, { runGit })).toThrow(message);
  });

  it("does not retain the removed exact-head deadline", async () => {
    const source = readFileSync("scripts/lib/git-listing.mjs", "utf8");
    expect(source).not.toMatch(/(?:timeout|killSignal)\s*:/);
  });

  it("publishes only validated closed JSON with source and distinct checkout/run/job identity and every emitted digest", () => {
    const f = fixture();
    const summary = prepareOperatorEvidence(f);
    expect(summary).toMatchObject({
      candidateVerified: true,
      installationAuthority: false,
      identity: f.identity,
      handoff: f.handoff,
      handoffSenders: f.progress.handoffSenders,
    });
    expect(readdirSync(f.output).sort()).toEqual(["scan.json", "summary.json"]);
    for (const name of readdirSync(f.output))
      expect(scanOperatorPayload(readFileSync(join(f.output, name)))).toEqual({ cookieMarkers: 0, grantMarkers: 0 });
  });
  it("includes canonical UI font assets in the complete build inventory without uploading their bytes", () => {
    const f = fixture();
    for (const format of ["woff", "woff2"])
      writeFileSync(join(f.dist, `synthetic-design-system-font.${format}`), "synthetic-font");
    f.handoff.files = operatorFileInventory(f.dist);
    f.save();
    const summary = prepareOperatorEvidence(f);
    expect(summary.handoff.files).toEqual(operatorFileInventory(f.dist));
    expect(readdirSync(f.output).sort()).toEqual(["scan.json", "summary.json"]);
  });
  it("retains controlled failure and retry outcomes even when production retries are zero, never installation authority", () => {
    const f = fixture();
    f.producer.status = "failed";
    f.producer.tests[1].status = "failed";
    f.producer.tests.push({ id: "chromium", retry: 1, status: "passed", durationMs: 21 });
    f.save();
    const result = prepareOperatorEvidence({ ...f, producerOutcome: "failure" });
    expect(result).toMatchObject({
      candidateVerified: false,
      installationAuthority: false,
      producerOutcome: "failure",
    });
    expect(result.tests.map(({ status }) => status)).toEqual(["passed", "failed", "passed"]);
  });
  it("allows safe early failure capture without a build but never empty-green", () => {
    const f = fixture();
    rmSync(join(f.input, "handoff.json"));
    rmSync(join(f.input, "chromium-stages.json"));
    f.producer.status = "failed";
    f.producer.tests = [{ id: "build", retry: 0, status: "failed", durationMs: 1 }];
    writeFileSync(join(f.input, "producer.json"), JSON.stringify(f.producer));
    expect(prepareOperatorEvidence({ ...f, producerOutcome: "failure" })).toMatchObject({
      handoff: null,
      candidateVerified: false,
    });
  });
  it.each([
    "unknown-popup-opened",
    "unknown-popup-attached",
    "unknown-sandbox-ready",
    "unknown-status-proved",
    "unknown-record-preserved",
  ])("retains the fixed %s failure boundary without claiming completed reload", (stage) => {
    const f = fixture();
    f.progress.stages = f.progress.stages.slice(0, f.progress.stages.indexOf(stage) + 1);
    f.save();
    expect(() => prepareOperatorEvidence(f)).toThrow("Operator evidence refused");
    f.producer.status = "failed";
    f.producer.tests[1].status = "failed";
    f.save();
    expect(prepareOperatorEvidence({ ...f, producerOutcome: "failure" })).toMatchObject({
      stages: f.progress.stages,
      reloadProved: false,
      candidateVerified: false,
      installationAuthority: false,
    });
  });
  it("refuses a successful job paired with a failed producer", () => {
    const f = fixture();
    f.producer.status = "failed";
    f.save();
    expect(() => prepareOperatorEvidence(f)).toThrow("Operator evidence refused");
  });
  it.each([
    "missing",
    "short",
    "extra",
    "unknown-case",
    "order",
    "extra-key",
    "nested",
    "origin",
    "url",
    "frame",
    "tab",
    "id",
    "delivery",
    "outcome",
    "undelivered-fields",
    "identity",
    "marker",
  ])("refuses %s attributed-sender matrix without publishing bytes", (fault) => {
    const f = fixture();
    const rows = f.progress.handoffSenders;
    if (fault === "missing") delete f.progress.handoffSenders;
    if (fault === "short") rows.pop();
    if (fault === "extra") rows.push({ ...rows[0] });
    if (fault === "unknown-case") rows[0].case = "unknown";
    if (fault === "order") [rows[0], rows[1]] = [rows[1], rows[0]];
    if (fault === "extra-key") rows[0].grant = "unknown";
    if (fault === "nested") rows[0].origin = { value: rows[0].origin };
    if (fault === "origin") rows[0].origin = "https://admin.chasesets.com";
    if (fault === "url") rows[0].url += "/other";
    if (fault === "frame") rows[3].frameId = 0;
    if (fault === "tab") rows[0].tabPresent = false;
    if (fault === "id") rows[0].id = "foreign";
    if (fault === "delivery") rows[2].delivered = false;
    if (fault === "outcome") rows[2].outcome = "paired";
    if (fault === "undelivered-fields") rows[4].origin = "null";
    if (fault === "identity") f.progress.identity = { ...f.identity, sourceHead: "3".repeat(40) };
    if (fault === "marker") rows[0].origin = "A".repeat(43);
    f.save();
    expect(() => prepareOperatorEvidence(f)).toThrow("Operator evidence refused");
    expect(readdirSync(join(f.output, "..")).includes("output")).toBe(false);
  });
  it.each(["sourceHead", "checkoutHead", "runId", "runAttempt", "job", "jobIndex", "suite"])(
    "refuses stale %s binding",
    (key) => {
      const f = fixture();
      f.handoff.identity = { ...f.identity, [key]: "stale" };
      f.save();
      expect(() => prepareOperatorEvidence(f)).toThrow("Operator evidence refused");
    },
  );
  it.each([
    "cookie",
    "grant",
    "archive",
    "unlisted",
    "missing",
    "digest",
    "extra-field",
    "title",
    "reload",
    "build",
    "retry",
    "empty",
    "stage-code",
    "stage-order",
  ])("refuses %s evidence without publishing bytes", (fault) => {
    const f = fixture();
    if (fault === "cookie" || fault === "grant")
      writeFileSync(
        join(f.input, "sandbox-status.png"),
        fault === "cookie" ? ["SYNTHETIC", "OPERATOR", "COOKIE", "CHROMIUM"].join("_") : "A".repeat(43),
      );
    if (fault === "archive" || fault === "unlisted")
      writeFileSync(join(f.input, fault === "archive" ? "trace.zip" : "unknown.json"), "unknown");
    if (fault === "digest") writeFileSync(join(f.dist, "background.js"), "changed");
    if (fault === "extra-field") f.handoff.secret = "hostile";
    if (fault === "title") f.producer.tests[0].title = "hostile";
    if (fault === "reload") f.progress.stages.pop();
    if (fault === "build") f.handoff.twoBuildsIdentical = false;
    if (fault === "retry") f.producer.tests[1].retry = 1;
    if (fault === "empty") f.producer.tests = [];
    if (fault === "stage-code") f.progress.stages[10] = "unrecognized-stage";
    if (fault === "stage-order")
      [f.progress.stages[10], f.progress.stages[11]] = [f.progress.stages[11], f.progress.stages[10]];
    f.save();
    if (fault === "missing") rmSync(join(f.input, "producer.json"));
    expect(() => prepareOperatorEvidence(f)).toThrow("Operator evidence refused");
    expect(readdirSync(join(f.output, "..")).includes("output")).toBe(false);
  });
});
