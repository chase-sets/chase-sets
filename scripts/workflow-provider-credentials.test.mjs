import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { checkWorkflowProviderCredentials } from "./workflow-provider-credentials.mjs";

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
    expect(result.checkedSteps).toHaveLength(16);
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
