import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import { gitListingOptions } from "./lib/git-listing.mjs";
import {
  checkWorkflowCanonicalArtifacts,
  createWorkflowCanonicalArtifactBaseline,
  evaluateWorkflowCanonicalArtifactRatchet,
  literalOutPaths,
  scanWorkflowCanonicalArtifacts,
} from "./workflow-canonical-artifacts.mjs";

const registryWorkflowFile = ".github/workflows/platform-registry-cleanup.yml";
const registryWorkflow = readFileSync(resolve(registryWorkflowFile), "utf8");

function trackedActionsYaml() {
  const result = spawnSync("git", ["ls-files", "-z", "--", ".github"], gitListingOptions({ encoding: "utf8" }));
  expect(result.status).toBe(0);
  return result.stdout
    .split("\0")
    .filter((path) => /^\.github\/(?:workflows|actions)\/.+\.ya?ml$/i.test(path))
    .sort();
}

function debtKey({ workflowFile, outPath, uploadPath, kind }) {
  return [workflowFile, outPath, uploadPath, kind].join("\u0000");
}

describe("workflow canonical artifact guard (#5952)", () => {
  it("keeps the real Linux timeout verifier path-filtered, bounded and nongoverning", () => {
    const source = readFileSync(".github/workflows/browser-boundary-timeout-verifier.yml", "utf8");
    const workflow = parse(source);
    expect(Object.keys(workflow.on)).toEqual(["pull_request"]);
    expect(workflow.on.pull_request.paths).toContain("scripts/provider-browser-install-*.mjs");
    const job = workflow.jobs.timeout;
    expect(job["runs-on"]).toBe("ubuntu-24.04");
    expect(job["timeout-minutes"]).toBe(15);
    expect(job.env.INSTALLER_TIMEOUT_SECONDS).toBe("600");
    const timeout = job.steps.find((step) => step.id === "timeout");
    expect(timeout.run).toBe("node scripts/provider-browser-install-timeout-verifier.mjs");
    expect(job.steps.find((step) => step.id === "controls").if).toBe("steps.timeout.outcome == 'success'");
    const guard = job.steps.at(-1);
    expect(guard.if).toBe("always()");
    expect(guard.run).toContain('test "$TIMEOUT_PROVEN" = true');
    expect(guard.run).toContain('test "$CONTROLS_OUTCOME" = skipped');
    expect(checkWorkflowCanonicalArtifacts(source).violations).toEqual([]);
  });

  it("parses both supported CLI output forms used by executable producers", () => {
    expect(
      literalOutPaths(`node ./producer.mjs --out evidence/split.json
node ./producer.mjs --out=evidence/equals.json`),
    ).toEqual(["evidence/equals.json", "evidence/split.json"]);
  });

  it("normalizes a quoted $GITHUB_WORKSPACE output to the workspace-relative upload path (#8026)", () => {
    expect(
      literalOutPaths(`node ./producer.mjs --out "$GITHUB_WORKSPACE/evidence/split.json"
node ./producer.mjs --out="\${GITHUB_WORKSPACE}/evidence/equals.json"`),
    ).toEqual(["evidence/equals.json", "evidence/split.json"]);
    for (const nonLiteral of [
      'node ./producer.mjs --out "$OTHER/evidence/x.json"',
      'node ./producer.mjs --out "$GITHUB_WORKSPACE_EVIL/evidence/x.json"',
      'node ./producer.mjs --out "${GITHUB_WORKSPACE_EVIL}/evidence/x.json"',
      "node ./producer.mjs --out '$GITHUB_WORKSPACE/evidence/x.json'",
      "node ./producer.mjs --out $GITHUB_WORKSPACE/evidence/x.json",
      'node ./producer.mjs --out "$GITHUB_WORKSPACE/$RUN/x.json"',
    ]) {
      expect(literalOutPaths(nonLiteral), nonLiteral).toEqual([]);
    }
  });

  it("resolves relative producer output against the step working directory (#8026)", () => {
    const workflow = (out, uploadPath = "artifacts/required.json") => `jobs:
  evidence:
    steps:
      - name: Produce from a trusted checkout
        working-directory: trusted
        run: node ./producer.mjs --out ${out}
      - name: Upload
        uses: actions/upload-artifact@0000000000000000000000000000000000000000
        with:
          path: ${uploadPath}
          if-no-files-found: error
`;
    const surfaces = (source) =>
      checkWorkflowCanonicalArtifacts(source).surfaces.map(({ outPath, uploadPath }) => ({ outPath, uploadPath }));

    expect(surfaces(workflow('"$GITHUB_WORKSPACE/artifacts/required.json"'))).toEqual([
      { outPath: "artifacts/required.json", uploadPath: "artifacts/required.json" },
    ]);
    // A relative payload lands inside the working directory, so the workspace upload never sees it.
    expect(surfaces(workflow("artifacts/required.json"))).toEqual([]);
    expect(surfaces(workflow("./artifacts/required.json", "trusted/artifacts/required.json"))).toEqual([
      { outPath: "trusted/artifacts/required.json", uploadPath: "trusted/artifacts/required.json" },
    ]);
  });

  it("pairs the trusted-checkout merge qualification candidate with its exact fail-closed upload (#8026)", () => {
    const file = ".github/workflows/platform-pr.yml";
    const workflow = readFileSync(resolve(file), "utf8");
    const outPath = "artifacts/merge-qualification-candidate/candidate.json";
    const candidate = (source) =>
      checkWorkflowCanonicalArtifacts(source, { workflowFile: file }).surfaces.filter(
        (surface) => surface.outPath === outPath,
      );

    expect(candidate(workflow)).toEqual([
      expect.objectContaining({ outPath, uploadPath: outPath, missingFileBehavior: "error" }),
    ]);
    const relativeOut = workflow.replace(`--out "$GITHUB_WORKSPACE/${outPath}"`, `--out "${outPath}"`);
    expect(relativeOut).not.toBe(workflow);
    expect(candidate(relativeOut)).toEqual([]);
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

  it("guards the nongoverning browser-boundary diagnostic summary as one exact fail-closed payload (#9259)", () => {
    const file = ".github/workflows/browser-boundary-diagnostics.yml";
    const workflow = readFileSync(resolve(file), "utf8");
    const outPath = "artifacts/browser-boundary-diagnostics/summary.json";

    const result = checkWorkflowCanonicalArtifacts(workflow, { workflowFile: file });
    expect(result.violations).toEqual([]);
    expect(result.surfaces).toEqual([
      expect.objectContaining({
        outPath,
        uploadPath: outPath,
        missingFileBehavior: "error",
        explicitlyValidated: true,
      }),
    ]);

    // Missing or partial evidence cannot hide behind a directory or a lenient upload.
    for (const [mutant, expected] of [
      [workflow.replace("if-no-files-found: error", "if-no-files-found: warn"), ["if-no-files-found=warn"]],
      [
        workflow
          .replace(`path: ${outPath}`, "path: artifacts/browser-boundary-diagnostics")
          .replace(`test -s ${outPath}`, "true"),
        ["can be nonempty while canonical payload"],
      ],
      [
        workflow
          .replace(`path: ${outPath}`, "path: artifacts/browser-boundary-diagnostics")
          .replace(`test -s ${outPath}`, "true")
          .replace("if-no-files-found: error", "if-no-files-found: ignore"),
        ["if-no-files-found=ignore", "can be nonempty while canonical payload"],
      ],
    ]) {
      const broken = checkWorkflowCanonicalArtifacts(mutant, { workflowFile: file });
      expect(broken.passed).toBe(false);
      expect(broken.violations).toEqual(expected.map((text) => expect.stringContaining(text)));
    }
  });

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
        files: [".github/workflows/unrelated-name.yml"],
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
    const committedBaseline = JSON.parse(
      readFileSync(resolve("scripts/workflow-canonical-artifacts-baseline.json"), "utf8"),
    );
    const tracked = trackedActionsYaml();

    // Discovery is the git-tracked Actions corpus and its per-file surfaces, never a pinned corpus total.
    expect(current.discovery.files).toEqual(tracked);
    expect(current.playwrightUploadFence.census.files).toEqual(tracked);
    expect(current.surfaces).toEqual(
      tracked.flatMap(
        (workflowFile) =>
          checkWorkflowCanonicalArtifacts(readFileSync(resolve(workflowFile), "utf8"), { workflowFile }).surfaces,
      ),
    );
    expect(current.discovery).toEqual({
      files: tracked,
      scannedFiles: tracked.length,
      totalFiles: tracked.length,
      scannedSurfaces: current.surfaces.length,
      totalSurfaces: current.surfaces.length,
    });
    // Existing debt is the committed keyed set: new debt fails the ratchet, and fixed debt must shrink the baseline.
    expect(current.findings.map(debtKey).sort()).toEqual(committedBaseline.findings.map(debtKey).sort());
    expect(evaluateWorkflowCanonicalArtifactRatchet(current, committedBaseline)).toMatchObject({
      passed: true,
      newOrRegressed: [],
      missingExpectedSurfaces: [],
      coverageRegressions: [],
      playwrightUploadFenceRegressions: [],
    });
    expect(
      current.findings.filter((finding) => /platform-merge-qualification(?:-observer)?\.yml/.test(finding.message)),
    ).toEqual([]);
    const idleDraftRecord = {
      workflowFile: ".github/workflows/platform-preview-cleanup.yml",
      outPath: "artifacts/release-health/platform-preview-idle-drafts.json",
      uploadPath: "artifacts/release-health/platform-preview-idle-drafts.json",
      missingFileBehavior: "error",
    };
    // The re-check in the dispatched run and the scheduled retirement job each upload their own record.
    expect(current.surfaces.filter(({ outPath }) => outPath === idleDraftRecord.outPath)).toEqual([
      expect.objectContaining(idleDraftRecord),
      expect.objectContaining(idleDraftRecord),
    ]);
    expect(current.surfaces).toEqual(
      expect.arrayContaining([
        ...["metadata", "report"].map((name) =>
          expect.objectContaining({
            workflowFile: ".github/workflows/platform-credential-health.yml",
            outPath: `artifacts/credential-health/${name}.json`,
            uploadPath: `artifacts/credential-health/${name}.json`,
            missingFileBehavior: "error",
          }),
        ),
        expect.objectContaining({
          workflowFile: ".github/workflows/browser-boundary-diagnostics.yml",
          outPath: "artifacts/browser-boundary-diagnostics/summary.json",
          missingFileBehavior: "error",
          explicitlyValidated: true,
        }),
        expect.objectContaining({
          workflowFile: ".github/workflows/platform-production.yml",
          outPath: "artifacts/release-health/production-kubernetes-deployment-transition.json",
        }),
        expect.objectContaining({
          workflowFile: ".github/workflows/platform-pr.yml",
          outPath: "artifacts/merge-qualification-candidate/candidate.json",
          uploadPath: "artifacts/merge-qualification-candidate/candidate.json",
          missingFileBehavior: "error",
        }),
        // Each environment's activation and in-run replay are validated before the status directory upload.
        ...["staging", "production"].flatMap((environment) =>
          ["activation", "replay"].map((name) =>
            expect.objectContaining({
              workflowFile: ".github/workflows/platform-production.yml",
              outPath: `artifacts/agent-grant-revocation/${environment}/${name}.json`,
              uploadPath: `artifacts/agent-grant-revocation/${environment}`,
              missingFileBehavior: "error",
              explicitlyValidated: true,
            }),
          ),
        ),
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
    expect(unchanged.existingDebt.map(debtKey).sort()).toEqual(committedBaseline.findings.map(debtKey).sort());
    expect(unchanged.newOrRegressed).toEqual([]);

    const newDebt = {
      ...current,
      findings: [...current.findings, { ...current.findings[0], outPath: "artifacts/unbaselined/new-debt.json" }],
    };
    expect(evaluateWorkflowCanonicalArtifactRatchet(newDebt, committedBaseline)).toMatchObject({
      passed: false,
      newOrRegressed: [expect.objectContaining({ outPath: "artifacts/unbaselined/new-debt.json" })],
    });

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

    // Omitting any one tracked file fails by membership even when the scanned count is unchanged.
    for (const omitted of tracked) {
      const omittedFile = {
        ...current,
        discovery: { ...current.discovery, files: current.discovery.files.filter((file) => file !== omitted) },
      };
      expect(evaluateWorkflowCanonicalArtifactRatchet(omittedFile, baseline), omitted).toMatchObject({
        passed: false,
        coverageRegressions: [`tracked workflow/action file '${omitted}' was not scanned`],
      });
    }

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
