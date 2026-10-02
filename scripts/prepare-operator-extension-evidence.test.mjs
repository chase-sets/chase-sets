import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
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
    stages: [
      "launch",
      "launched",
      "worker",
      "setup-connected",
      "cookies-proved",
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
  it("publishes only validated closed JSON with source and distinct checkout/run/job identity and every emitted digest", () => {
    const f = fixture();
    const summary = prepareOperatorEvidence(f);
    expect(summary).toMatchObject({
      candidateVerified: true,
      installationAuthority: false,
      identity: f.identity,
      handoff: f.handoff,
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
  it("refuses a successful job paired with a failed producer", () => {
    const f = fixture();
    f.producer.status = "failed";
    f.save();
    expect(() => prepareOperatorEvidence(f)).toThrow("Operator evidence refused");
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
    f.save();
    if (fault === "missing") rmSync(join(f.input, "producer.json"));
    expect(() => prepareOperatorEvidence(f)).toThrow("Operator evidence refused");
    expect(readdirSync(join(f.output, "..")).includes("output")).toBe(false);
  });
});
