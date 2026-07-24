import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  DESTRUCTIVE_OPERATION_EXEMPTIONS,
  NAMED_RESET_WORKFLOW_TRIPWIRES,
  checkNamedResetWorkflowTripwires,
  checkWorkflowDestructiveOperationGating,
  detectDestructiveOperations,
} from "./workflow-destructive-op-gating.mjs";

const workflowDirectory = resolve(".github/workflows");
const workflowFiles = readdirSync(workflowDirectory)
  .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
  .map((name) => `.github/workflows/${name}`);

function readWorkflow(file) {
  return readFileSync(resolve(file), "utf8");
}

function safeFixture() {
  return `name: Shape-selected fixture
on:
  schedule:
    - cron: "0 0 * * *"
  workflow_dispatch:
    inputs:
      dry_run:
        description: Dry run
        required: false
        default: "true"
        type: choice
        options:
          - "true"
          - "false"
      confirm:
        description: Type the apply phrase
        required: false
        type: string
permissions: {}
jobs:
  refuse-unconfirmed-apply:
    runs-on: ubuntu-latest
    if: github.event_name == 'workflow_dispatch' && inputs.dry_run == 'false' && inputs.confirm != 'delete fixture restore points'
    steps:
      - run: exit 1
  mutate:
    runs-on: ubuntu-latest
    needs: refuse-unconfirmed-apply
    if: always() && needs.refuse-unconfirmed-apply.result == 'skipped'
    env:
      FIXTURE_DRY_RUN: \${{ github.event_name == 'schedule' && 'false' || (inputs.dry_run == 'true' && 'true' || 'false') }}
    steps:
      - run: |
          apply_arg=""
          if [ "$FIXTURE_DRY_RUN" = "false" ]; then
            apply_arg="--apply"
          fi
          node ./scripts/production-db-restore-point-cleanup.mjs \${apply_arg}
`;
}

function withoutJob(source, jobId, nextJobId) {
  const start = source.indexOf(`  ${jobId}:`);
  const end = source.indexOf(`  ${nextJobId}:`, start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return source.slice(0, start) + source.slice(end);
}

describe("destructive workflow invocation-shape selection", () => {
  it("recognizes every named destructive command and script without workflow or step vocabulary", () => {
    const run = `
doctl registry repository delete-tag repo old --force
doctl registry garbage-collection start --force
terraform destroy -auto-approve
node ./scripts/digitalocean-registry-cleanup.mjs cleanup
node ../../../scripts/production-db-restore-point-cleanup.mjs --apply
node scripts/disable-terraform-prevent-destroy.mjs main.tf
`;

    expect(detectDestructiveOperations(run)).toEqual([
      "doctl:registry-repository-delete-tag",
      "doctl:registry-garbage-collection-start",
      "terraform:destroy",
      "script:digitalocean-registry-cleanup",
      "script:production-db-restore-point-cleanup",
      "script:disable-terraform-prevent-destroy",
    ]);
  });

  it("negative control: harmless provider commands and destructive-looking labels do not select a step", () => {
    const source = `jobs:
  harmless:
    runs-on: ubuntu-latest
    steps:
      - name: Terraform destroy registry cleanup
        run: |
          terraform plan
          doctl registry repository list-tags repo
`;

    const result = checkWorkflowDestructiveOperationGating(source, {
      workflowFile: ".github/workflows/destructive-name-only.yml",
    });

    expect(result.checkedSteps).toEqual([]);
    expect(result.violations).toEqual([]);
  });

  it("negative control: fails closed when a selected invocation cannot be parsed into a provable job gate", () => {
    const result = checkWorkflowDestructiveOperationGating(
      "jobs:\n  broken: [\n    run: terraform destroy -auto-approve\n",
      { workflowFile: ".github/workflows/unparseable.yml" },
    );

    expect(result.passed).toBe(false);
    expect(result.violations).toEqual([expect.stringContaining("no gate can be proven; failing closed")]);
  });
});

describe("dry-run and typed-confirmation contract", () => {
  it("accepts the canonical schedule-apply/manual-dry-run fixture", () => {
    const result = checkWorkflowDestructiveOperationGating(safeFixture(), {
      workflowFile: ".github/workflows/arbitrary-shape-selected-file.yml",
    });

    expect(result.violations).toEqual([]);
    expect(result.checkedSteps).toEqual([
      expect.objectContaining({
        jobId: "mutate",
        operations: ["script:production-db-restore-point-cleanup"],
        disposition: "provable-gate",
      }),
    ]);
  });

  it("negative control: rejects triggers beyond schedule and workflow_dispatch", () => {
    const source = safeFixture().replace("on:\n", "on:\n  push:\n");
    const result = checkWorkflowDestructiveOperationGating(source);

    expect(result.violations).toEqual([expect.stringContaining("apply can be forced only for schedule events")]);
  });

  it("negative control: requires the manual input to default to dry-run", () => {
    const source = safeFixture().replace('default: "true"', 'default: "false"');
    const result = checkWorkflowDestructiveOperationGating(source);

    expect(result.violations).toEqual([
      expect.stringContaining('dry_run must be a true/false choice that defaults to "true"'),
    ]);
  });

  it("negative control: an inverted resolver proves the manual dry_run=true incident class is rejected", () => {
    const source = safeFixture().replace(
      "inputs.dry_run == 'true' && 'true' || 'false'",
      "inputs.dry_run == 'true' && 'false' || 'true'",
    );
    const result = checkWorkflowDestructiveOperationGating(source);

    expect(result.violations).toEqual([expect.stringContaining("manual dry_run=true can resolve to apply")]);
  });

  it("negative control: a safe resolver that is not wired to the destructive invocation fails closed", () => {
    const source = safeFixture().replace("${apply_arg}", "--apply");
    const result = checkWorkflowDestructiveOperationGating(source);

    expect(result.violations).toEqual([
      expect.stringContaining("cannot associate its invocation with the provable dry-run/apply resolver"),
    ]);
  });

  it("negative control: requires a typed confirmation input", () => {
    const source = safeFixture().replace("        type: string\npermissions:", "        type: boolean\npermissions:");
    const result = checkWorkflowDestructiveOperationGating(source);

    expect(result.violations).toEqual([expect.stringContaining("typed string confirmation input named 'confirm'")]);
  });

  it("negative control: requires the refuse-unconfirmed-apply job", () => {
    const source = withoutJob(safeFixture(), "refuse-unconfirmed-apply", "mutate");
    const result = checkWorkflowDestructiveOperationGating(source);

    expect(result.violations).toEqual([
      expect.stringContaining("missing the refuse-unconfirmed-apply confirmation job"),
    ]);
  });

  it("negative control: confirmation must be scoped to manual apply and an exact phrase", () => {
    const source = safeFixture().replace(
      "if: github.event_name == 'workflow_dispatch' && inputs.dry_run == 'false' && inputs.confirm != 'delete fixture restore points'",
      "if: inputs.confirm",
    );
    const result = checkWorkflowDestructiveOperationGating(source);

    expect(result.violations).toEqual([
      expect.stringContaining("must reject manual dry_run=false unless inputs.confirm equals"),
    ]);
  });

  it("negative control: the refusal job must fail the unconfirmed path", () => {
    const source = safeFixture().replace("- run: exit 1", "- run: echo accepted");
    const result = checkWorkflowDestructiveOperationGating(source);

    expect(result.violations).toEqual([
      expect.stringContaining("must terminate the unconfirmed apply path with exit 1"),
    ]);
  });

  it("negative control: the destructive job must need the confirmation job", () => {
    const source = safeFixture().replace("    needs: refuse-unconfirmed-apply\n", "");
    const result = checkWorkflowDestructiveOperationGating(source);

    expect(result.violations).toEqual([
      expect.stringContaining("must need refuse-unconfirmed-apply and run only when"),
    ]);
  });
});

describe("real workflow coverage and bounded exemptions", () => {
  it("checks every workflow and pins positive destructive-step counts", () => {
    const checkedCounts = {};
    const violations = [];
    for (const workflowFile of workflowFiles) {
      const result = checkWorkflowDestructiveOperationGating(readWorkflow(workflowFile), { workflowFile });
      if (result.checkedSteps.length > 0) checkedCounts[workflowFile] = result.checkedSteps.length;
      violations.push(...result.violations);
    }

    expect(violations).toEqual([]);
    expect(checkedCounts).toEqual({
      ".github/workflows/platform-preview-cleanup.yml": 2,
      ".github/workflows/platform-production-restore-point-cleanup.yml": 1,
      ".github/workflows/platform-production.yml": 1,
      ".github/workflows/platform-registry-cleanup.yml": 1,
      ".github/workflows/platform-staging-reset.yml": 2,
    });
  });

  it("pins the exact bounded exemption inventory instead of allowing path-prefix exemptions", () => {
    expect(DESTRUCTIVE_OPERATION_EXEMPTIONS).toEqual([
      {
        workflowFile: ".github/workflows/platform-preview-cleanup.yml",
        jobs: [
          {
            jobId: "destroy-preview",
            expectedStepOperations: [["script:disable-terraform-prevent-destroy"], ["terraform:destroy"]],
          },
        ],
      },
      {
        workflowFile: ".github/workflows/platform-production.yml",
        jobs: [
          {
            jobId: "deploy-production",
            expectedStepOperations: [["script:production-db-restore-point-cleanup"]],
          },
        ],
      },
      {
        workflowFile: ".github/workflows/platform-staging-reset.yml",
        jobs: [
          {
            jobId: "reset-staging",
            expectedStepOperations: [
              ["script:disable-terraform-prevent-destroy", "terraform:destroy"],
              ["script:disable-terraform-prevent-destroy", "terraform:destroy"],
            ],
          },
        ],
      },
    ]);
  });

  it("negative control: an exempt job cannot gain another destructive invocation", () => {
    const workflowFile = ".github/workflows/platform-preview-cleanup.yml";
    const source = readWorkflow(workflowFile).replace(
      "run: terraform destroy -auto-approve",
      "run: |\n          terraform destroy -auto-approve\n          terraform destroy -auto-approve",
    );
    const result = checkWorkflowDestructiveOperationGating(source, { workflowFile });

    expect(result.passed).toBe(false);
    expect(result.violations).toEqual(
      expect.arrayContaining([expect.stringContaining("Exemptions are exact and may not grow")]),
    );
  });
});

describe("bounded named reset regression tripwires", () => {
  const sources = Object.fromEntries(
    NAMED_RESET_WORKFLOW_TRIPWIRES.map((workflowFile) => [workflowFile, readWorkflow(workflowFile)]),
  );

  it("checks exactly both existing reset workflows", () => {
    const result = checkNamedResetWorkflowTripwires(sources);

    expect(result.violations).toEqual([]);
    expect(result.checkedWorkflows).toEqual([
      ".github/workflows/platform-staging-reset.yml",
      ".github/workflows/catalog-integration-staging-reset.yml",
    ]);
  });

  it("negative control: catches removal of the platform reset RESET_CONFIRM check", () => {
    const mutated = {
      ...sources,
      ".github/workflows/platform-staging-reset.yml": sources[".github/workflows/platform-staging-reset.yml"].replace(
        'if [ "$RESET_CONFIRM" != "reset staging" ]; then',
        'if [ "$RESET_MODE" = "never" ]; then',
      ),
    };
    const result = checkNamedResetWorkflowTripwires(mutated);

    expect(result.violations).toEqual([
      expect.stringContaining("requires RESET_CONFIRM and both exact typed-confirmation comparisons"),
    ]);
  });

  it("negative control: catches removal of the catalog reset confirmation job", () => {
    const catalog = sources[".github/workflows/catalog-integration-staging-reset.yml"];
    const mutated = {
      ...sources,
      ".github/workflows/catalog-integration-staging-reset.yml": withoutJob(
        catalog,
        "refuse-unconfirmed-apply",
        "catalog-integration-reset",
      ),
    };
    const result = checkNamedResetWorkflowTripwires(mutated);

    expect(result.violations).toEqual([
      expect.stringContaining("requires the refuse-unconfirmed-apply typed-confirmation gate"),
    ]);
  });
});
