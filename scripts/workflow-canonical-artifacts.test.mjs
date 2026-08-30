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
      expect(spawnSync("git", ["init", "--quiet"], { cwd: root, encoding: "utf8" }).status).toBe(0);
      expect(
        spawnSync("git", ["add", ".github/workflows/unrelated-name.yml"], { cwd: root, encoding: "utf8" }).status,
      ).toBe(0);

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

    expect(current.discovery).toMatchObject({ scannedFiles: 60, scannedSurfaces: 25, totalSurfaces: 25 });
    expect(current.findings).toHaveLength(21);
    expect(current.surfaces).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          workflowFile: ".github/workflows/platform-production.yml",
          outPath: "artifacts/release-health/production-kubernetes-deployment-transition.json",
        }),
        expect.objectContaining({
          workflowFile: ".github/workflows/backlog-roadmap-status.yml",
          outPath: "artifacts/roadmap-refined-inventory-authority/roadmap-refined-inventory-authority-probe.json",
          uploadPath: "artifacts/roadmap-refined-inventory-authority/roadmap-refined-inventory-authority-probe.json",
          missingFileBehavior: "error",
          explicitlyValidated: true,
        }),
      ]),
    );

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

    const rawPlaywrightRegression = {
      ...current,
      playwrightUploadFence: {
        ...current.playwrightUploadFence,
        findings: [
          {
            file: ".github/workflows/fifth-producer.yml",
            owner: "e2e",
            step: "Upload evidence",
            uploadPath: "artifacts/playwright/**",
            analysis: "glob can include a disabled raw root",
          },
        ],
      },
    };
    expect(evaluateWorkflowCanonicalArtifactRatchet(rawPlaywrightRegression, baseline)).toMatchObject({
      passed: false,
      playwrightUploadFenceRegressions: [expect.stringContaining("fifth-producer.yml")],
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
      expect(spawnSync("git", ["init", "--quiet"], { cwd: root, encoding: "utf8" }).status).toBe(0);
      expect(
        spawnSync("git", ["add", ".github/workflows/shape-only.yml"], { cwd: root, encoding: "utf8" }).status,
      ).toBe(0);
      writeFileSync(
        join(baselineDirectory, "baseline.json"),
        `${JSON.stringify(createWorkflowCanonicalArtifactBaseline(scanWorkflowCanonicalArtifacts({ root })), null, 2)}\n`,
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
      expect(write.stdout).toContain("parsed 1/1 tracked workflow/action files");
      expect(write.stdout).toContain("existing baseline debt: 1");

      const check = spawnSync(process.execPath, args, { cwd: process.cwd(), encoding: "utf8" });
      expect(check.status).toBe(0);
      expect(check.stdout).toContain("existing baseline debt: 1");
      expect(check.stdout).toContain("new/regressed violations: 0");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses predecessor-baseline missing, decoy-directory, and weakened-upload mutants byte-identically", () => {
    const root = mkdtempSync(join(tmpdir(), "workflow-artifact-predecessor-"));
    try {
      const workflowDirectory = join(root, ".github", "workflows");
      const scriptsDirectory = join(root, "scripts");
      mkdirSync(workflowDirectory, { recursive: true });
      mkdirSync(scriptsDirectory, { recursive: true });
      const workflowPath = join(workflowDirectory, "structural-authority.yml");
      const compliant = `jobs:
  authority:
    steps:
      - name: Produce
        run: node ./producer.mjs --out artifacts/authority/payload.json
      - name: Validate
        run: node ./validator.mjs --input artifacts/authority/payload.json
      - name: Upload
        uses: actions/upload-artifact@0000000000000000000000000000000000000000
        with:
          path: artifacts/authority/payload.json
          if-no-files-found: error
`;
      writeFileSync(workflowPath, compliant);
      expect(spawnSync("git", ["init", "--quiet"], { cwd: root, encoding: "utf8" }).status).toBe(0);
      expect(
        spawnSync("git", ["add", ".github/workflows/structural-authority.yml"], { cwd: root, encoding: "utf8" }).status,
      ).toBe(0);
      const baselinePath = join(scriptsDirectory, "baseline.json");
      writeFileSync(
        baselinePath,
        `${JSON.stringify(createWorkflowCanonicalArtifactBaseline(scanWorkflowCanonicalArtifacts({ root })), null, 2)}\n`,
      );
      const predecessorBytes = readFileSync(baselinePath, "utf8");
      const args = [
        "./scripts/workflow-canonical-artifacts.mjs",
        "--root",
        root,
        "--baseline",
        "scripts/baseline.json",
        "--write-baseline",
      ];
      const mutants = [
        compliant.replace("path: artifacts/authority/payload.json", "path: artifacts/authority/missing.json"),
        compliant
          .replace("path: artifacts/authority/payload.json", "path: artifacts/authority")
          .replace(
            "node ./validator.mjs --input artifacts/authority/payload.json",
            "node ./validator.mjs --input artifacts/authority/decoy.json",
          ),
        compliant.replace("if-no-files-found: error", "if-no-files-found: warn"),
      ];
      for (const mutant of mutants) {
        writeFileSync(workflowPath, mutant);
        const result = spawnSync(process.execPath, args, { cwd: process.cwd(), encoding: "utf8" });
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain("refusing to replace a predecessor baseline that rejects the candidate");
        expect(readFileSync(baselinePath, "utf8")).toBe(predecessorBytes);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
