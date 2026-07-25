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
    if: github.event_name == 'workflow_dispatch'
    env:
      DESTRUCTIVE_OPERATION_REQUESTED_DRY_RUN: \${{ github.event.inputs.dry_run }}
      DESTRUCTIVE_OPERATION_CONFIRMATION: \${{ github.event.inputs.confirm }}
    steps:
      - run: |
          set -euo pipefail
          case "$DESTRUCTIVE_OPERATION_REQUESTED_DRY_RUN" in
            "true")
              ;;
            "false")
              if [ "$DESTRUCTIVE_OPERATION_CONFIRMATION" != "delete fixture restore points" ]; then
                echo refused >&2
                exit 1
              fi
              ;;
            *)
              echo invalid >&2
              exit 1
              ;;
          esac
  mutate:
    runs-on: ubuntu-latest
    needs: refuse-unconfirmed-apply
    if: >-
      !cancelled() &&
      (needs.refuse-unconfirmed-apply.result == 'skipped' ||
      needs.refuse-unconfirmed-apply.result == 'success')
    env:
      DESTRUCTIVE_OPERATION_REQUESTED_DRY_RUN: \${{ github.event.inputs.dry_run }}
    steps:
      - name: Resolve destructive operation mode
        run: |
          effective_dry_run="true"
          if [ "$GITHUB_EVENT_NAME" = "schedule" ]; then
            effective_dry_run="false"
          elif [ "$GITHUB_EVENT_NAME" = "workflow_dispatch" ] && [ "$DESTRUCTIVE_OPERATION_REQUESTED_DRY_RUN" = "false" ]; then
            effective_dry_run="false"
          fi
          echo "FIXTURE_DRY_RUN=\${effective_dry_run}" >> "$GITHUB_ENV"
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

  it.each([
    ["Node option", "node --no-warnings ./scripts/production-db-restore-point-cleanup.mjs --apply"],
    ["shell line continuation", "node \\\n  ./scripts/production-db-restore-point-cleanup.mjs --apply"],
  ])("negative control: %s cannot evade destructive-script discovery", (_label, run) => {
    const result = checkWorkflowDestructiveOperationGating(`jobs:
  mutate:
    runs-on: ubuntu-latest
    steps:
      - run: |
          ${run.replaceAll("\n", "\n          ")}
`);

    expect(result.checkedSteps).toHaveLength(1);
    expect(result.violations).toEqual(
      expect.arrayContaining([expect.stringContaining("missing the refuse-unconfirmed-apply")]),
    );
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
    const source = safeFixture().replace('effective_dry_run="true"', 'effective_dry_run="false"');
    const result = checkWorkflowDestructiveOperationGating(source);

    expect(result.violations).toEqual([expect.stringContaining("no fail-closed shell resolver")]);
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

  it("negative control: rejects a defaulted destructive confirmation phrase", () => {
    const source = safeFixture().replace(
      "        required: false\n        type: string",
      '        required: false\n        default: "delete fixture restore points"\n        type: string',
    );
    const result = checkWorkflowDestructiveOperationGating(source);

    expect(result.violations).toEqual([expect.stringContaining("must not default the destructive phrase")]);
  });

  it("negative control: requires the refuse-unconfirmed-apply job", () => {
    const source = withoutJob(safeFixture(), "refuse-unconfirmed-apply", "mutate");
    const result = checkWorkflowDestructiveOperationGating(source);

    expect(result.violations).toEqual([
      expect.stringContaining("missing the refuse-unconfirmed-apply confirmation job"),
    ]);
  });

  it("negative control: confirmation must be scoped to manual apply and an exact phrase", () => {
    const source = safeFixture().replace("if: github.event_name == 'workflow_dispatch'", "if: inputs.confirm");
    const result = checkWorkflowDestructiveOperationGating(source);

    expect(result.violations).toEqual([expect.stringContaining("must shell-validate every manual dry_run value")]);
  });

  it("negative control: the case-sensitive shell comparison is authoritative", () => {
    const source = safeFixture().replace(
      'if [ "$DESTRUCTIVE_OPERATION_CONFIRMATION" != "delete fixture restore points" ]; then',
      'if [ "${DESTRUCTIVE_OPERATION_CONFIRMATION,,}" != "delete fixture restore points" ]; then',
    );
    const result = checkWorkflowDestructiveOperationGating(source);

    expect(result.violations).toEqual(
      expect.arrayContaining([
        expect.stringContaining("must shell-validate every manual dry_run value"),
        expect.stringContaining("with a nonzero exit"),
      ]),
    );
  });

  it("negative control: unknown or empty manual dry_run values must refuse with nonzero exit", () => {
    const source = safeFixture().replace(
      "              echo invalid >&2\n              exit 1",
      "              echo accepted",
    );
    const result = checkWorkflowDestructiveOperationGating(source);

    expect(result.violations).toEqual([
      expect.stringContaining("must shell-validate every manual dry_run value"),
      expect.stringContaining("with a nonzero exit"),
    ]);
  });

  it("negative control: the destructive job must need the confirmation job", () => {
    const source = safeFixture().replace("    needs: refuse-unconfirmed-apply\n", "");
    const result = checkWorkflowDestructiveOperationGating(source);

    expect(result.violations).toEqual([expect.stringContaining("must be cancellation-safe")]);
  });

  it("negative control: cancellation cannot start the destructive job", () => {
    const source = safeFixture().replace("!cancelled() &&", "always() &&");
    const result = checkWorkflowDestructiveOperationGating(source);

    expect(result.violations).toEqual([expect.stringContaining("must be cancellation-safe")]);
  });

  it("negative control: restore apply wiring rejects an unconditional --apply channel", () => {
    const source = safeFixture().replace(
      "node ./scripts/production-db-restore-point-cleanup.mjs ${apply_arg}",
      "node ./scripts/production-db-restore-point-cleanup.mjs --apply ${apply_arg}",
    );
    const result = checkWorkflowDestructiveOperationGating(source);

    expect(result.violations).toEqual([expect.stringContaining("cannot associate its invocation")]);
  });

  it("negative control: restore apply wiring rejects the competing apply environment channel", () => {
    const source = safeFixture().replace(
      "    env:\n      DESTRUCTIVE_OPERATION_REQUESTED_DRY_RUN: ${{ github.event.inputs.dry_run }}\n    steps:\n      - name: Resolve destructive operation mode",
      '    env:\n      PRODUCTION_DB_RESTORE_POINT_CLEANUP_APPLY: "true"\n      DESTRUCTIVE_OPERATION_REQUESTED_DRY_RUN: ${{ github.event.inputs.dry_run }}\n    steps:\n      - name: Resolve destructive operation mode',
    );
    const result = checkWorkflowDestructiveOperationGating(source);

    expect(result.violations).toEqual([expect.stringContaining("cannot associate its invocation")]);
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
      expect.stringContaining("requires an unset-by-default typed confirmation and actual nonzero refusal"),
    ]);
  });

  it("negative control: catches a platform reset comparison that does not actually refuse", () => {
    const mutated = {
      ...sources,
      ".github/workflows/platform-staging-reset.yml": sources[".github/workflows/platform-staging-reset.yml"].replace(
        "echo \"Confirmation input must exactly equal 'reset staging'.\" >&2\n                exit 1",
        "echo \"Confirmation input must exactly equal 'reset staging'.\" >&2",
      ),
    };
    const result = checkNamedResetWorkflowTripwires(mutated);

    expect(result.violations).toEqual([
      expect.stringContaining("requires an unset-by-default typed confirmation and actual nonzero refusal"),
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

    expect(result.violations).toEqual([expect.stringContaining("requires actual nonzero refusal")]);
  });

  it("negative control: catches a catalog reset gate that does not actually refuse", () => {
    const mutated = {
      ...sources,
      ".github/workflows/catalog-integration-staging-reset.yml": sources[
        ".github/workflows/catalog-integration-staging-reset.yml"
      ].replace(
        "echo 'Confirmation text did not match exactly; expected \"reset staging catalog integration data\".' >&2\n          exit 1",
        "echo 'Confirmation text did not match exactly; expected \"reset staging catalog integration data\".' >&2",
      ),
    };
    const result = checkNamedResetWorkflowTripwires(mutated);

    expect(result.violations).toEqual([expect.stringContaining("requires actual nonzero refusal")]);
  });

  it("negative control: catches a catalog reset dependency with no required result condition", () => {
    const mutated = {
      ...sources,
      ".github/workflows/catalog-integration-staging-reset.yml": sources[
        ".github/workflows/catalog-integration-staging-reset.yml"
      ].replace(
        "!cancelled() &&\n      needs.refuse-production.result == 'skipped' &&\n      needs.refuse-unconfirmed-apply.result == 'skipped'",
        "always()",
      ),
    };
    const result = checkNamedResetWorkflowTripwires(mutated);

    expect(result.violations).toEqual([
      expect.stringContaining("cancellation-safe destructive-job dependency/result condition"),
    ]);
  });
});
