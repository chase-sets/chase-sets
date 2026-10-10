import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { repoRoot } from "./lib/repo.mjs";

const workflowPath = ".github/workflows/catalog-completion-report.yml";
const source = readFileSync(path.join(repoRoot, workflowPath), "utf8");
const workflow = parse(source);
const job = workflow.jobs["completion-report"];
// Windows resolves a bare `bash` to the WSL launcher, which drops the child env.
const bashLauncher = process.platform === "win32" ? "C:\\Program Files\\Git\\usr\\bin\\bash.exe" : "bash";

function step(name) {
  const found = job.steps.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`Missing step ${name}`);
  return found;
}

// Run a workflow step's own script with no inherited database credential or CA.
function runStep(name, env) {
  const scrubbed = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/DATABASE_URL|^PG/.test(key)));
  return spawnSync(bashLauncher, ["-c", step(name).run], { encoding: "utf8", env: { ...scrubbed, ...env } });
}

describe("catalog completion report workflow contract", () => {
  let dir;

  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), "catalog-completion-workflow-"));
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("is dispatch-only with a closed environment choice and a required batch id", () => {
    expect(Object.keys(workflow.on)).toEqual(["workflow_dispatch"]);
    const inputs = workflow.on.workflow_dispatch.inputs;
    expect(inputs.environment).toMatchObject({ required: true, type: "choice", options: ["staging", "production"] });
    expect(inputs.batch_id).toMatchObject({ required: true, type: "string" });
    expect(inputs.manifest_run_id.required).toBe(false);
    expect(inputs.manifest_artifact.required).toBe(false);
    expect(workflow.permissions).toEqual({});
    expect(job.permissions).toEqual({ contents: "read", actions: "read" });
    expect(job.environment).toBe("${{ inputs.environment }}");
  });

  it("exports only the catalog context URL", () => {
    const exports = job.steps.filter(
      (candidate) => candidate.uses === "./.github/actions/export-managed-postgres-authority",
    );
    expect(exports).toHaveLength(1);
    expect(exports[0].with).toEqual({
      environment: "${{ env.TARGET_ENVIRONMENT }}",
      contexts: "catalog",
      "connection-mode": "direct",
    });
    const referencedUrls = new Set(source.match(/DATABASE_URL_[A-Z_]+/g) ?? []);
    expect([...referencedUrls]).toEqual(["DATABASE_URL_CATALOG"]);
  });

  it("fails by name with the Catalog credential withheld", () => {
    const result = runStep("Require catalog database authority", {});
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("catalog-database-url-missing");
  });

  it("fails by name with the managed CA withheld or absent", () => {
    const withheld = runStep("Require catalog database authority", { DATABASE_URL_CATALOG: "synthetic-url" });
    expect(withheld.status).toBe(1);
    expect(withheld.stderr).toContain("managed-postgres-ca-missing");

    const absent = runStep("Require catalog database authority", {
      DATABASE_URL_CATALOG: "synthetic-url",
      PGSSLROOTCERT: path.join(dir, "missing-ca.pem"),
    });
    expect(absent.status).toBe(1);
    expect(absent.stderr).toContain("managed-postgres-ca-missing");

    const caPath = path.join(dir, "ca.pem");
    writeFileSync(caPath, "SYNTHETIC CA\n");
    const present = runStep("Require catalog database authority", {
      DATABASE_URL_CATALOG: "synthetic-url",
      PGSSLROOTCERT: caPath,
    });
    expect(present.status).toBe(0);
  });

  it("rejects a malformed batch id before any authority is exported", () => {
    const result = runStep("Validate report inputs", { BATCH_ID: "batch;rm -rf /", MANIFEST_ARTIFACT: "" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("batch-id-invalid");
    expect(job.steps.findIndex((candidate) => candidate.name === "Validate report inputs")).toBe(0);
  });

  it("runs the database-mode report from env, never interpolating inputs into scripts", () => {
    const report = step("Generate catalog completion report").run;
    expect(report).toContain("pnpm run ops catalog:production-completion-report --");
    expect(report).toContain("--facts database");
    expect(report).toContain('--batch-id "$BATCH_ID"');
    expect(report).toContain('elif [ "$status" -eq 2 ]; then');
    for (const candidate of job.steps.filter((entry) => typeof entry.run === "string")) {
      expect(candidate.run).not.toContain("${{");
    }
  });

  it("removes the CA and uploads the report artifact", () => {
    const cleanup = step("Remove managed Postgres CA");
    expect(cleanup.if).toBe("${{ always() }}");
    expect(cleanup.run).toContain('rm -f -- "$PGSSLROOTCERT"');
    const upload = step("Upload catalog completion report");
    expect(upload.with).toMatchObject({
      path: "artifacts/catalog-completion-report/catalog-completion-report.json",
      "if-no-files-found": "error",
    });
  });
});
