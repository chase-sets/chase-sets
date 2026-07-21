import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  checkWorkflowProviderCredentials,
  checkWorkflowSpacesEvidenceCredentials,
  nodeScriptInvocations,
  spacesCredentialEnvNames,
} from "./workflow-provider-credentials.mjs";

const workflowFile = ".github/workflows/platform-staging-reset.yml";
const workflow = readFileSync(resolve(workflowFile), "utf8");

function stripStepEnvKey(source, stepName, envKey) {
  const stepStart = source.indexOf(`      - name: ${stepName}`);
  expect(stepStart, `expected workflow step '${stepName}'`).toBeGreaterThanOrEqual(0);
  const nextStep = source.indexOf("\n      - ", stepStart + 1);
  const stepEnd = nextStep >= 0 ? nextStep : source.length;
  const step = source.slice(stepStart, stepEnd);
  const strippedStep = step.replace(new RegExp(`^ {10}${envKey}:.*\\r?\\n`, "m"), "");
  expect(strippedStep, `expected '${envKey}' in workflow step '${stepName}'`).not.toBe(step);
  return source.slice(0, stepStart) + strippedStep + source.slice(stepEnd);
}

describe("platform staging reset provider credential contract", () => {
  it("threads provider credentials into every Terraform, doctl, and AWS-style tool step", () => {
    const result = checkWorkflowProviderCredentials(workflow, { workflowFile });

    expect(result.violations).toEqual([]);
    expect(result.passed).toBe(true);
    expect(result.checkedSteps).toHaveLength(17);
  });

  it("negative control: catches the credentials-not-threaded class when a provider step loses one key", () => {
    const strippedWorkflow = stripStepEnvKey(workflow, "Verify staging catalog asset CDN", "AWS_ACCESS_KEY_ID");
    const result = checkWorkflowProviderCredentials(strippedWorkflow, { workflowFile });

    expect(result.passed).toBe(false);
    expect(result.violations).toEqual([
      expect.stringContaining(
        "provider-touching step 'Verify staging catalog asset CDN' invokes terraform/doctl but does not declare step env: AWS_ACCESS_KEY_ID",
      ),
    ]);
  });

  it("guards unnamed inline tool steps instead of relying on step names", () => {
    const inlineWorkflow = `jobs:
  test:
    steps:
      - run: aws s3 ls
`;

    expect(checkWorkflowProviderCredentials(inlineWorkflow).violations).toEqual([
      expect.stringContaining("provider-touching step 'unnamed step' invokes aws but does not declare step env"),
    ]);
  });
});

describe("dedicated Spaces evidence credential contract (release qualification, #5836)", () => {
  const mergeGateStep = (envLines) => `jobs:
  qualify:
    steps:
      - name: Persist release qualification record
${envLines}        run: |
          node scripts/release-qualification-record.mjs write --record "$RUNNER_TEMP/record.json"
`;
  const bothEnv = `        env:
          RELEASE_EVIDENCE_SPACES_ACCESS_ID: \${{ secrets.RELEASE_EVIDENCE_SPACES_ACCESS_ID }}
          RELEASE_EVIDENCE_SPACES_SECRET_KEY: \${{ secrets.RELEASE_EVIDENCE_SPACES_SECRET_KEY }}
`;

  it("selects its surface by code shape: node-script invocations and credential-shaped env names", () => {
    expect(
      nodeScriptInvocations('node scripts/release-qualification-record.mjs write\nnode "./scripts/other tool.mjs"'),
    ).toEqual(["scripts/other tool.mjs", "scripts/release-qualification-record.mjs"]);
    expect(spacesCredentialEnvNames(readFileSync(resolve("scripts/release-qualification-record.mjs"), "utf8"))).toEqual(
      ["RELEASE_EVIDENCE_SPACES_ACCESS_ID", "RELEASE_EVIDENCE_SPACES_SECRET_KEY"],
    );
  });

  it("every real workflow threads the dedicated evidence credentials wherever they are used", () => {
    const workflowDir = resolve(".github/workflows");
    const workflowFiles = readdirSync(workflowDir).filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"));
    expect(workflowFiles.length).toBeGreaterThan(20);

    for (const file of workflowFiles) {
      const result = checkWorkflowSpacesEvidenceCredentials(readFileSync(resolve(workflowDir, file), "utf8"), {
        workflowFile: `.github/workflows/${file}`,
      });
      expect(result.violations, `.github/workflows/${file}`).toEqual([]);
    }
  });

  it("negative control: a realistic merge-gate step invoking the real record script without env is rejected", () => {
    const result = checkWorkflowSpacesEvidenceCredentials(mergeGateStep(""), {
      workflowFile: ".github/workflows/platform-merge-gate.yml",
    });

    expect(result.passed).toBe(false);
    expect(result.violations).toEqual([
      expect.stringContaining(
        "step 'Persist release qualification record' uses dedicated Spaces evidence credentials but does not declare step env: RELEASE_EVIDENCE_SPACES_ACCESS_ID, RELEASE_EVIDENCE_SPACES_SECRET_KEY",
      ),
    ]);
  });

  it("negative control: withholding one of the two credentials flags exactly the missing one", () => {
    const oneEnv = `        env:
          RELEASE_EVIDENCE_SPACES_ACCESS_ID: \${{ secrets.RELEASE_EVIDENCE_SPACES_ACCESS_ID }}
`;
    const result = checkWorkflowSpacesEvidenceCredentials(mergeGateStep(oneEnv), {
      workflowFile: ".github/workflows/platform-merge-gate.yml",
    });

    expect(result.passed).toBe(false);
    expect(result.violations).toEqual([
      expect.stringContaining("does not declare step env: RELEASE_EVIDENCE_SPACES_SECRET_KEY"),
    ]);
  });

  it("accepts the step once both dedicated credentials are threaded", () => {
    const result = checkWorkflowSpacesEvidenceCredentials(mergeGateStep(bothEnv), {
      workflowFile: ".github/workflows/platform-merge-gate.yml",
    });

    expect(result.violations).toEqual([]);
    expect(result.passed).toBe(true);
    expect(result.checkedSteps).toEqual([
      expect.objectContaining({
        name: "Persist release qualification record",
        requiredEnv: ["RELEASE_EVIDENCE_SPACES_ACCESS_ID", "RELEASE_EVIDENCE_SPACES_SECRET_KEY"],
      }),
    ]);
  });

  it("negative control: an inline shell reference to a dedicated credential requires step env too", () => {
    const inline = `jobs:
  qualify:
    steps:
      - name: Inline credential use
        run: |
          curl -H "auth: $RELEASE_EVIDENCE_SPACES_SECRET_KEY" https://example.invalid
`;
    const result = checkWorkflowSpacesEvidenceCredentials(inline, {
      workflowFile: ".github/workflows/platform-merge-gate.yml",
    });

    expect(result.violations).toEqual([
      expect.stringContaining("does not declare step env: RELEASE_EVIDENCE_SPACES_SECRET_KEY"),
    ]);
  });

  it("does not burden steps invoking scripts that read no Spaces evidence credentials", () => {
    const benign = `jobs:
  release:
    steps:
      - name: Validate promoted release record
        run: node scripts/promoted-release.mjs validate --record record.json
`;
    const result = checkWorkflowSpacesEvidenceCredentials(benign, {
      workflowFile: ".github/workflows/platform-production.yml",
    });

    expect(result.checkedSteps).toEqual([]);
    expect(result.passed).toBe(true);
  });
});
