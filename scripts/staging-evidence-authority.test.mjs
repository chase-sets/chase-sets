import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  parseInputs,
  runStagingEvidenceAuthority,
  STAGING_EVIDENCE_AUTHORITY_RUNNER_PATH,
} from "./staging-evidence-authority.mjs";

const head = "a".repeat(40);
const baseEnv = (root) => ({
  PROBE_BASE_URL: "https://marketplace.staging.chasesets.com",
  PROBE_ENVIRONMENT: "staging",
  PROBE_HEAD: head,
  PROBE_WORKTREE: root,
  PROBE_GOVERNED_PATHS: "scripts/foo.mjs",
  PROBE_OUT_FILE: join(root, "receipt.json"),
  PROBE_LOG_FILE: join(root, "authority.ndjson"),
  DEPLOY_MAX_AGE_SECONDS: "604800",
  PROBE_REQUEST_TIMEOUT_MS: "1000",
  PROBE_TOTAL_BUDGET_MS: "5000",
  PROBE_RUNNER_PATH: STAGING_EVIDENCE_AUTHORITY_RUNNER_PATH,
  GITHUB_TOKEN: "github-token-marker",
  MARKETPLACE_E2E_EMAIL: "probe@example.test",
  MARKETPLACE_E2E_PASSWORD: "password-marker",
});

describe("staging evidence authority inputs", () => {
  it("resolves argv over environment and requires every governed input", () => {
    const root = mkdtempSync(join(tmpdir(), "authority-input-"));
    const env = baseEnv(root);
    expect(parseInputs(["--head", "b".repeat(40), "--governed-path", "scripts/bar.mjs"], env).head).toBe(
      "b".repeat(40),
    );
    expect(() => parseInputs(["--runner-path", "scripts/other.mjs"], env)).toThrow("input-invalid");
    expect(() => parseInputs(["--marketplace-e2e-password", "secret"], env)).toThrow("input-forbidden-in-argv");
  });
});

describe("staging evidence authority composition", () => {
  it("runs mode first and sign-in last, and refuses a mode stop", async () => {
    const root = mkdtempSync(join(tmpdir(), "authority-order-"));
    const env = baseEnv(root);
    const calls = [];
    const run = await runStagingEvidenceAuthority({
      env,
      cwd: root,
      readExecutedBytes: async () => {
        calls.push("bytes");
        return {
          outcome: "ok",
          executedBytes: { files: [], head, mergedIntoOriginMain: true, porcelainEmpty: true, worktreeRoot: root },
        };
      },
      observeProviderMode: async () => {
        calls.push("mode");
        return { stop: "live-mode-detected", httpStatus: 200, degradedCheckNames: [] };
      },
    });
    expect(calls).toEqual(["bytes", "mode"]);
    expect(run.exitCode).toBe(1);
    expect(run.value).toMatchObject({ result: "failed", ready: false, stop: "live-mode-detected" });
  });

  it("emits a single closed refusal object for missing inputs", async () => {
    const run = await runStagingEvidenceAuthority({ argv: ["--environment", "staging"], env: {} });
    expect(run.exitCode).toBe(2);
    expect(run.value).toMatchObject({
      version: "staging-evidence-authority/v1",
      result: "refused",
      ready: false,
      stop: "input-missing",
    });
    expect(Object.keys(run.value).sort()).toEqual(
      ["detail", "finishedAt", "ready", "result", "startedAt", "stop", "version"].sort(),
    );
  });
});
