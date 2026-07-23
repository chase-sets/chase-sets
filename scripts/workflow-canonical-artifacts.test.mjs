import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  checkWorkflowCanonicalArtifacts,
  createWorkflowCanonicalArtifactBaseline,
  evaluateWorkflowCanonicalArtifactRatchet,
  literalOutPaths,
  scanWorkflowCanonicalArtifacts,
} from "./workflow-canonical-artifacts.mjs";

const registryWorkflowFile = ".github/workflows/platform-registry-cleanup.yml";
const registryWorkflow = readFileSync(resolve(registryWorkflowFile), "utf8");

describe("workflow canonical artifact guard (#5952)", () => {
  it("parses both supported CLI output forms used by executable producers", () => {
    expect(
      literalOutPaths(`node ./producer.mjs --out evidence/split.json
node ./producer.mjs --out=evidence/equals.json`),
    ).toEqual(["evidence/equals.json", "evidence/split.json"]);
  });

  it("guards the historical registry path as one exact validated canonical payload", () => {
    const result = checkWorkflowCanonicalArtifacts(registryWorkflow, { workflowFile: registryWorkflowFile });

    expect(result.violations).toEqual([]);
    expect(result.surfaces).toEqual([
      expect.objectContaining({
        outPath: "artifacts/release-health/digitalocean-registry-cleanup.json",
        uploadPath: "artifacts/release-health/digitalocean-registry-cleanup.json",
        missingFileBehavior: "error",
        explicitlyValidated: true,
      }),
    ]);
  });

  it.each(["ignore", "warn"])(
    "historical real-path negative: diagnostics and a %s directory upload cannot replace the payload",
    (missingFileBehavior) => {
      const broken = registryWorkflow
        .replace("path: artifacts/release-health/digitalocean-registry-cleanup.json", "path: artifacts/release-health")
        .replace("if-no-files-found: error", `if-no-files-found: ${missingFileBehavior}`)
        .replace(
          "node ./scripts/digitalocean-registry-cleanup-record.mjs --record=artifacts/release-health/digitalocean-registry-cleanup.json",
          'mkdir -p artifacts/release-health\nprintf "diagnostic only\\n" > artifacts/release-health/diagnostic.txt',
        );
      const result = checkWorkflowCanonicalArtifacts(broken, { workflowFile: registryWorkflowFile });

      expect(result.passed).toBe(false);
      expect(result.violations).toEqual([
        expect.stringContaining(`if-no-files-found=${missingFileBehavior}`),
        expect.stringContaining("can be nonempty while canonical payload"),
      ]);
      expect(result.surfaces).toEqual([
        expect.objectContaining({
          outPath: "artifacts/release-health/digitalocean-registry-cleanup.json",
          uploadPath: "artifacts/release-health",
          explicitlyValidated: false,
        }),
      ]);
    },
  );

  it("arbitrary-path negative runs through real discovery and reports the scanned/total surface", () => {
    const root = mkdtempSync(join(tmpdir(), "workflow-artifact-guard-"));
    try {
      const workflowDirectory = join(root, ".github", "workflows");
      mkdirSync(workflowDirectory, { recursive: true });
      writeFileSync(
        join(workflowDirectory, "unrelated-name.yml"),
        `name: Arbitrary
jobs:
  evidence:
    steps:
      - name: Produce
        run: |
          node ./tool.mjs --out unusual/location/required.json
          mkdir -p unusual/location
          printf '{"status":"diagnostic"}\\n' > unusual/location/diagnostic.json
      - name: Upload configured directory
        uses: actions/upload-artifact@0000000000000000000000000000000000000000
        with:
          path: unusual/location
          if-no-files-found: ignore
`,
      );

      const result = scanWorkflowCanonicalArtifacts({ root });

      expect(result.discovery).toEqual({
        scannedFiles: 1,
        totalFiles: 1,
        scannedSurfaces: 1,
        totalSurfaces: 1,
      });
      expect(result.passed).toBe(false);
      expect(result.violations).toHaveLength(2);
      expect(result.violations.join("\n")).toContain("unusual/location/required.json");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("ratchets existing shape-discovered debt while rejecting regression, missing surfaces, and reduced coverage", () => {
    const current = scanWorkflowCanonicalArtifacts();
    const baseline = createWorkflowCanonicalArtifactBaseline(current);

    const unchanged = evaluateWorkflowCanonicalArtifactRatchet(current, baseline);
    expect(unchanged.passed).toBe(true);
    expect(unchanged.existingDebt).toHaveLength(21);
    expect(unchanged.newOrRegressed).toEqual([]);

    const worsenedFinding = {
      ...current,
      findings: current.findings.map((finding, index) => (index === 0 ? { ...finding, observed: "ignore" } : finding)),
    };
    expect(evaluateWorkflowCanonicalArtifactRatchet(worsenedFinding, baseline)).toMatchObject({
      passed: false,
      newOrRegressed: [expect.objectContaining({ observed: "ignore" })],
    });

    const missingSurface = { ...current, surfaces: current.surfaces.slice(1) };
    expect(evaluateWorkflowCanonicalArtifactRatchet(missingSurface, baseline)).toMatchObject({
      passed: false,
      missingExpectedSurfaces: [expect.any(Object)],
    });

    const reducedCoverage = {
      ...current,
      discovery: { ...current.discovery, scannedFiles: current.discovery.scannedFiles - 1 },
    };
    expect(evaluateWorkflowCanonicalArtifactRatchet(reducedCoverage, baseline)).toMatchObject({
      passed: false,
      coverageRegressions: [expect.stringContaining("scanned workflow/action files fell")],
    });
  });

  it("regenerates and checks the deterministic baseline through the guard command", () => {
    const root = mkdtempSync(join(tmpdir(), "workflow-artifact-command-"));
    try {
      const workflowDirectory = join(root, ".github", "workflows");
      const baselineDirectory = join(root, "scripts");
      mkdirSync(workflowDirectory, { recursive: true });
      mkdirSync(baselineDirectory, { recursive: true });
      writeFileSync(
        join(workflowDirectory, "shape-only.yml"),
        `jobs:
  evidence:
    steps:
      - run: node ./producer.mjs --out artifacts/required.json
      - uses: actions/upload-artifact@0000000000000000000000000000000000000000
        with:
          path: artifacts/required.json
          if-no-files-found: warn
`,
      );
      const args = [
        "./scripts/workflow-canonical-artifacts.mjs",
        "--root",
        root,
        "--baseline",
        "scripts/baseline.json",
      ];
      const write = spawnSync(process.execPath, [...args, "--write-baseline"], {
        cwd: process.cwd(),
        encoding: "utf8",
      });
      expect(write.status).toBe(0);
      expect(write.stdout).toContain("checked 1/1 discovered producer/upload surfaces");
      expect(write.stdout).toContain("existing baseline debt: 1");

      const check = spawnSync(process.execPath, args, { cwd: process.cwd(), encoding: "utf8" });
      expect(check.status).toBe(0);
      expect(check.stdout).toContain("existing baseline debt: 1");
      expect(check.stdout).toContain("new/regressed violations: 0");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
