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
const seedPacksWorkflowFile = ".github/workflows/platform-seed-packs-apply.yml";
const seedPacksWorkflow = readFileSync(resolve(seedPacksWorkflowFile), "utf8");

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

describe("seed-pack plan/apply provider credential contract (issue #5874)", () => {
  const candidateFiles = [
    [workflowFile, workflow],
    [seedPacksWorkflowFile, seedPacksWorkflow],
  ];

  it("selects provider-touching steps by command shape and scans every contract candidate file", () => {
    let scanned = 0;
    for (const [file, source] of candidateFiles) {
      const result = checkWorkflowProviderCredentials(source, { workflowFile: file });
      expect(result.checkedSteps.length, `${file} must contain provider-tool steps`).toBeGreaterThan(0);
      expect(result.violations, file).toEqual([]);
      scanned += 1;
    }
    // eslint-disable-next-line no-console
    console.log(`provider credential contract: scanned ${scanned}/${candidateFiles.length} candidate files`);
    expect(scanned).toBe(candidateFiles.length);
  });

  it("requires backend and DigitalOcean provider inputs on both plan and apply", () => {
    const result = checkWorkflowProviderCredentials(seedPacksWorkflow, { workflowFile: seedPacksWorkflowFile });
    const providerSteps = result.checkedSteps.filter((checked) =>
      ["Terraform plan seed packs", "Terraform apply seed packs"].includes(checked.name),
    );

    expect(providerSteps).toHaveLength(2);
    for (const checked of providerSteps) {
      expect(checked.requiredEnv).toEqual([
        "AWS_ACCESS_KEY_ID",
        "AWS_SECRET_ACCESS_KEY",
        "TF_VAR_digitalocean_token",
        "TF_VAR_spaces_access_id",
        "TF_VAR_spaces_secret_key",
      ]);
    }
  });

  it("negative control: withholding the API token from the real plan step names the missing input", () => {
    const stripped = stripStepEnvKey(seedPacksWorkflow, "Terraform plan seed packs", "TF_VAR_digitalocean_token");
    const result = checkWorkflowProviderCredentials(stripped, { workflowFile: seedPacksWorkflowFile });

    expect(result.passed).toBe(false);
    expect(result.violations).toEqual([
      expect.stringContaining(
        "provider-touching step 'Terraform plan seed packs' invokes terraform but does not declare step env: TF_VAR_digitalocean_token",
      ),
    ]);
  });

  it("negative control: withholding a Spaces provider key from the real apply step names the missing input", () => {
    const stripped = stripStepEnvKey(seedPacksWorkflow, "Terraform apply seed packs", "TF_VAR_spaces_secret_key");
    const result = checkWorkflowProviderCredentials(stripped, { workflowFile: seedPacksWorkflowFile });

    expect(result.passed).toBe(false);
    expect(result.violations).toEqual([
      expect.stringContaining(
        "provider-touching step 'Terraform apply seed packs' invokes terraform but does not declare step env: TF_VAR_spaces_secret_key",
      ),
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
    expect(
      nodeScriptInvocations(
        'node "$GITHUB_WORKSPACE/scripts/release-qualification-record.mjs" write\nnode ${GITHUB_WORKSPACE}/scripts/terraform-plan-inspection.mjs',
      ),
    ).toEqual(["scripts/release-qualification-record.mjs", "scripts/terraform-plan-inspection.mjs"]);
    expect(spacesCredentialEnvNames(readFileSync(resolve("scripts/release-qualification-record.mjs"), "utf8"))).toEqual(
      ["RELEASE_EVIDENCE_SPACES_ACCESS_ID", "RELEASE_EVIDENCE_SPACES_SECRET_KEY"],
    );
  });

  it("every real workflow and composite action threads the dedicated evidence credentials wherever they are used", () => {
    const workflowDir = resolve(".github/workflows");
    const candidateFiles = readdirSync(workflowDir)
      .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
      .map((name) => `.github/workflows/${name}`);
    const actionsDir = resolve(".github/actions");
    for (const entry of readdirSync(actionsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      for (const candidate of ["action.yml", "action.yaml"]) {
        try {
          readFileSync(resolve(actionsDir, entry.name, candidate), "utf8");
          candidateFiles.push(`.github/actions/${entry.name}/${candidate}`);
        } catch {
          // action manifest under the other extension
        }
      }
    }
    expect(candidateFiles.length).toBeGreaterThan(20);
    expect(candidateFiles).toContain(".github/actions/setup-pnpm-workspace/action.yml");

    for (const file of candidateFiles) {
      const result = checkWorkflowSpacesEvidenceCredentials(readFileSync(resolve(file), "utf8"), {
        workflowFile: file,
      });
      expect(result.violations, file).toEqual([]);
    }
  });

  it("parses composite-action run steps at their shallower indent (real discovery, not path keywords)", () => {
    const composite = `name: Example composite
runs:
  using: composite
  steps:
    - name: Persist qualification record
      shell: bash
      run: |
        node scripts/release-qualification-record.mjs write --record record.json
`;
    const result = checkWorkflowSpacesEvidenceCredentials(composite, {
      workflowFile: ".github/actions/example/action.yml",
    });

    expect(result.passed).toBe(false);
    expect(result.violations).toEqual([
      expect.stringContaining(
        "step 'Persist qualification record' uses dedicated Spaces evidence credentials but does not declare step env: RELEASE_EVIDENCE_SPACES_ACCESS_ID, RELEASE_EVIDENCE_SPACES_SECRET_KEY",
      ),
    ]);
  });

  it("negative control: the $GITHUB_WORKSPACE invocation idiom is resolved, not skipped", () => {
    const workspaceIdiom = `jobs:
  qualify:
    steps:
      - name: Persist release qualification record
        run: |
          (
            cd "$tmp"
            node "$GITHUB_WORKSPACE/scripts/release-qualification-record.mjs" write --record record.json
          )
`;
    const result = checkWorkflowSpacesEvidenceCredentials(workspaceIdiom, {
      workflowFile: ".github/workflows/platform-merge-gate.yml",
    });

    expect(result.passed).toBe(false);
    expect(result.violations).toEqual([
      expect.stringContaining(
        "does not declare step env: RELEASE_EVIDENCE_SPACES_ACCESS_ID, RELEASE_EVIDENCE_SPACES_SECRET_KEY",
      ),
    ]);
  });

  it("fails closed on a node script invocation the guard cannot resolve and inspect", () => {
    const unresolvable = `jobs:
  qualify:
    steps:
      - name: Run generated helper
        run: node "$RUNNER_TEMP/generated-helper.mjs"
`;
    const result = checkWorkflowSpacesEvidenceCredentials(unresolvable, {
      workflowFile: ".github/workflows/platform-merge-gate.yml",
    });

    expect(result.passed).toBe(false);
    expect(result.violations).toEqual([
      expect.stringContaining(
        "invokes node script '$RUNNER_TEMP/generated-helper.mjs' that does not resolve in the repository",
      ),
    ]);
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
