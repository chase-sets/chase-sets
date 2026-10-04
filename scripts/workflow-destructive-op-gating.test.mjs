import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import {
  DESTRUCTIVE_GRAMMAR,
  DESTRUCTIVE_OPERATION_EXEMPTIONS,
  NAMED_RESET_WORKFLOW_TRIPWIRES,
  checkDiscoveredWorkflows,
  checkNamedResetWorkflowTripwires,
  checkWorkflowDestructiveOperationGating,
  classifyShellCommands,
  deriveAuthoritativeGrammar,
  discoverWorkflowFiles,
  validateGrammarPartition,
} from "./workflow-destructive-op-gating.mjs";

const root = resolve(import.meta.dirname, "..");
const registryFile = ".github/workflows/platform-registry-cleanup.yml";
const restoreFile = ".github/workflows/platform-production-restore-point-cleanup.yml";
const catalogFile = NAMED_RESET_WORKFLOW_TRIPWIRES[1];
const stagingFile = NAMED_RESET_WORKFLOW_TRIPWIRES[0];
const readWorkflow = (file) => readFileSync(join(root, file), "utf8");
const operations = (run) => classifyShellCommands(run).operations;
const directories = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    if (!directory.startsWith(join(root, ".tmp") + "/") && !directory.startsWith(join(root, ".tmp") + "\\"))
      throw new Error("Fixture deletion escaped seat scratch.");
    rmSync(directory, { recursive: true, force: true });
  }
});

function fixtureRoot() {
  mkdirSync(join(root, ".tmp"), { recursive: true });
  const directory = mkdtempSync(join(root, ".tmp", "workflow-grammar-"));
  directories.push(directory);
  mkdirSync(join(directory, ".github/workflows"), { recursive: true });
  for (const file of discoverWorkflowFiles(root)) copyFileSync(join(root, file), join(directory, file));
  return directory;
}

function changeWorkflow(file, change) {
  const workflow = parse(readWorkflow(file));
  change(workflow);
  return stringify(workflow);
}

function violatingWorkflow(run = "terraform destroy", jobId = "anonymous", stepName = "ordinary task") {
  return stringify({
    name: "Synthetic grammar fixture",
    on: "push",
    jobs: { [jobId]: { "runs-on": "ubuntu-latest", steps: [{ name: stepName, run }] } },
  });
}

describe("derived destructive command positions", () => {
  it("detects continued destructive commands", () => {
    expect(
      operations(
        "terraform \\\n  destroy -auto-approve\ndoctl registry \\\n  repository delete-tag example old\ndoctl registry garbage-collection \\\n  start",
      ),
    ).toEqual(["terraform:destroy", "doctl:registry-repository-delete-tag", "doctl:registry-garbage-collection-start"]);
    expect(operations("terra\\\nform dest\\\nroy\ndoctl reg\\\nistry repository delete-tag example old")).toEqual([
      "terraform:destroy",
      "doctl:registry-repository-delete-tag",
    ]);
    expect(operations('"terraform" "dest\\\nroy"')).toEqual(["terraform:destroy"]);
    expect(operations("terraform 'dest\\\nroy'")).toEqual([]);
  });

  it("detects doctl global options", () => {
    expect(operations('doctl -t "$TOKEN" registry repository delete-tag example old')).toEqual([
      "doctl:registry-repository-delete-tag",
    ]);
    expect(operations("doctl --output=json registry --context fixture repo -tTOKEN dt example old")).toEqual([
      "doctl:registry-repository-delete-tag",
    ]);
    expect(operations('doctl --trace=false reg gc --api-url "https://example.invalid" s')).toEqual([
      "doctl:registry-garbage-collection-start",
    ]);
  });

  it.each(
    DESTRUCTIVE_GRAMMAR.partition.filter(
      (member) => member.surface === "doctl-option" && member.disposition === "HANDLED",
    ),
  )("handles derived global option $id", ({ form }) => {
    for (const name of form.names) {
      const option = form.arity === 1 ? `${name} "terraform destroy"` : name;
      expect(operations(`doctl ${option} registry repository delete-tag example old`)).toEqual([
        "doctl:registry-repository-delete-tag",
      ]);
    }
  });

  it("detects Terraform's equals-only pre-command chdir", () => {
    expect(operations('terraform -chdir="a directory" destroy')).toEqual(["terraform:destroy"]);
    expect(classifyShellCommands("terraform -chdir fixture destroy").indeterminate).toEqual([
      expect.objectContaining({ reason: "-chdir requires =value" }),
    ]);
    expect(classifyShellCommands("terraform -synthetic-6129-option fixture destroy").indeterminate).toHaveLength(1);
  });

  it.each([
    ["node --no-warnings ./scripts/digitalocean-registry-cleanup.mjs cleanup", "script:digitalocean-registry-cleanup"],
    [
      "node \\\n  ../../../scripts/production-db-restore-point-cleanup.mjs --apply",
      "script:production-db-restore-point-cleanup",
    ],
    [
      "node --title 'destructive-looking data' --require harmless.mjs -- ./scripts/disable-terraform-prevent-destroy.mjs main.tf",
      "script:disable-terraform-prevent-destroy",
    ],
    [
      "node --title --eval ./scripts/production-db-restore-point-cleanup.mjs --apply",
      "script:production-db-restore-point-cleanup",
    ],
    [
      'node "$GITHUB_WORKSPACE/scripts/production-db-restore-point-cleanup.mjs" --apply',
      "script:production-db-restore-point-cleanup",
    ],
  ])("retains script options and continuations: %s", (run, operation) => expect(operations(run)).toEqual([operation]));

  it("does not classify command names in data operands", () => {
    const run = `echo terraform destroy
printf '%s\\n' 'doctl registry repository delete-tag example old'
# terraform destroy
echo ./scripts/production-db-restore-point-cleanup.mjs
node --title ./scripts/production-db-restore-point-cleanup.mjs harmless.mjs
node -e 'terraform destroy'
node --eval 'doctl registry repository delete-tag example old'
node -p 'digitalocean-registry-cleanup.mjs'
node --check ./scripts/production-db-restore-point-cleanup.mjs
terraform -chdir="destroy" plan
doctl --context 'registry repository delete-tag' registry repository list-tags example
cat <<'SYNTHETIC_6129_DATA'
terraform destroy
node ./scripts/production-db-restore-point-cleanup.mjs
SYNTHETIC_6129_DATA
for label in terraform destroy doctl; do echo "$label"; done
case "$label" in terraform|destroy) echo data ;; esac
labels=("terraform destroy" "doctl registry repository delete-tag")
tools=(terraform destroy doctl registry repository delete-tag)
echo "$((terraform + destroy))"
((terraform + destroy))
command -v terraform
`;
    expect(classifyShellCommands(run)).toMatchObject({ operations: [], indeterminate: [] });
  });

  it.each([
    "echo data; terraform destroy",
    "true && terraform destroy",
    "false || terraform destroy",
    "terraform destroy | cat",
    "(terraform destroy)",
    "{ terraform destroy; }",
    ">result MODE=fixture terraform destroy 2>/dev/null",
    "MODE=fixture terraform destroy",
    'MODE="$VALUE" terraform destroy',
    "{output}>result terraform destroy",
    "env MODE=fixture terraform destroy",
    "command -- terraform destroy",
    "exec terraform destroy",
    'echo "$(terraform destroy)"',
    'echo "$(echo "$(terraform destroy)")"',
    'echo "${OPTIONAL:-$(terraform destroy)}"',
    "cat <(terraform destroy)",
    "echo `terraform destroy`",
    "OUTPUT=$(terraform destroy)",
    "if true; then terraform destroy; fi",
    "for label in example; do terraform destroy; done",
    "case fixture in fixture) terraform destroy ;; esac",
    "cleanup() { terraform destroy; }",
    "cat <<SYNTHETIC_6129_EXPANSION\n$(terraform destroy)\nSYNTHETIC_6129_EXPANSION\n",
  ])("detects executable position across shell grammar: %s", (run) =>
    expect(operations(run)).toEqual(["terraform:destroy"]),
  );

  it("fails closed on an ambiguous covered command without selecting unrelated labels", () => {
    expect(
      classifyShellCommands("node --synthetic-6129-option scripts/production-db-restore-point-cleanup.mjs")
        .indeterminate,
    ).toHaveLength(1);
    expect(classifyShellCommands('terraform "destroy').indeterminate).toHaveLength(1);
    expect(classifyShellCommands('echo "terraform destroy').indeterminate).toEqual([]);
    expect(classifyShellCommands('node "$SYNTHETIC_6129_SCRIPT"').indeterminate).toHaveLength(1);
    expect(classifyShellCommands("time -p terraform destroy").indeterminate).toHaveLength(1);
    expect(classifyShellCommands("coproc terraform destroy").indeterminate).toHaveLength(1);
    expect(operations("./scripts/production-db-restore-point-cleanup.mjs --apply")).toEqual([
      "script:production-db-restore-point-cleanup",
    ]);
  });
});

describe("authoritative grammar partition", () => {
  it("partition equals authoritative derivation", () => {
    expect(validateGrammarPartition()).toEqual({ passed: true, members: 503, violations: [] });
    expect(DESTRUCTIVE_GRAMMAR.partition).toEqual(deriveAuthoritativeGrammar());
    expect(new Set(DESTRUCTIVE_GRAMMAR.partition.map((member) => member.id)).size).toBe(503);
    expect(DESTRUCTIVE_GRAMMAR.partition.filter((member) => member.disposition === "HANDLED")).toHaveLength(421);
    expect(DESTRUCTIVE_GRAMMAR.partition.filter((member) => member.disposition === "INDETERMINATE")).toHaveLength(82);
    expect(DESTRUCTIVE_GRAMMAR.sources.map(({ id, excerptSha256 }) => [id, excerptSha256])).toEqual([
      ["bash", "79b2d71b111231a093f390e82181428b15523ffe66fb7cc8a893f81da5a0e1b8"],
      ["doctl-global", "138e78ea8ccce848f3f5c1115ae5477934311629769f59e3e51aa79651d7d8ab"],
      ["doctl-constants", "93e07da01e5c478b7a98bd87d12a903a3155b3de99a65f3a1f16cab451dea16b"],
      ["doctl-registry", "819cb62a61b3c34aaa18dad5f32fd279c8c9ba7e77cabd8f592ba813532688b5"],
      ["terraform-global", "2e8c741c11cb1f85a89d6de228be0d1cbaa9c6715c54fa5d000f90fded141205"],
      ["terraform-commands", "d465182221c8d4407eb111236f544e2d944709339a1ecb14dfcbaea1b241fb59"],
      ["node-options", "6b07ab3887f29d4f18195cb5475469f4b8c5cf0e92ad9e9bf9286fcd9d103665"],
      ["node-types", "c60a28f67e10267daf25a73c20baf2e29ddba044047e758c87f32e26fe0e3545"],
    ]);
    for (const source of DESTRUCTIVE_GRAMMAR.sources) expect(source.citation).toMatch(/^https:\/\//);
    expect(DESTRUCTIVE_GRAMMAR.partition).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "bash:list1:list1 ';' newline_list list1", disposition: "HANDLED" }),
        expect.objectContaining({
          id: "doctl:option:access-token",
          form: { names: ["--access-token", "-t"], arity: 1 },
        }),
        expect.objectContaining({ id: "node:option:--title", form: expect.objectContaining({ arity: 1 }) }),
      ]),
    );
  });

  it.each(["missing", "duplicate", "unsourced", "altered disposition", "altered source"])(
    "rejects %s grammar mutation",
    (mutation) => {
      const grammar = structuredClone(DESTRUCTIVE_GRAMMAR);
      if (mutation === "missing") grammar.partition.pop();
      if (mutation === "duplicate") grammar.partition.push(grammar.partition[0]);
      if (mutation === "unsourced")
        grammar.partition.push({
          id: "synthetic-6129-unsourced",
          source: "bash",
          surface: "shell",
          form: {},
          disposition: "HANDLED",
        });
      if (mutation === "altered disposition")
        grammar.partition[0].disposition = grammar.partition[0].disposition === "HANDLED" ? "INDETERMINATE" : "HANDLED";
      if (mutation === "altered source") grammar.sources[0].lines.push("synthetic-6129-not-authoritative");
      expect(validateGrammarPartition(grammar).passed).toBe(false);
    },
  );

  it("unknown derived command form fails closed", () => {
    const unknown = "doctl registry repository synthetic-6129-unlisted-command example";
    expect(classifyShellCommands(unknown).indeterminate).toEqual([
      expect.objectContaining({ disposition: "INDETERMINATE", reason: "unlisted registry subcommand" }),
    ]);
    const result = checkWorkflowDestructiveOperationGating(violatingWorkflow(unknown), {
      workflowFile: ".github/workflows/synthetic-6129-unknown.yml",
    });
    expect(result.passed).toBe(false);
    expect(result.violations).toContainEqual(
      expect.stringContaining("synthetic-6129-unknown.yml: job 'anonymous' step #1: INDETERMINATE"),
    );
    expect(
      checkWorkflowDestructiveOperationGating(violatingWorkflow("doctl registry repository list-tags example")).passed,
    ).toBe(true);
  });

  it.each(["jobs:\n  broken: [\n", "jobs: {}\njobs: {}\n", "a label, not a workflow"])(
    "malformed YAML fails closed: %s",
    (source) => {
      expect(checkWorkflowDestructiveOperationGating(source).violations).toContainEqual(
        expect.stringContaining("workflow could not be parsed; failing closed"),
      );
    },
  );
});

describe("semantic cleanup shape contracts and real discovery", () => {
  it("all discovered workflows satisfy shape contract", () => {
    const result = checkDiscoveredWorkflows({ root });
    expect(result.violations).toEqual([]);
    expect(result.passed).toBe(true);
    expect(result.total).toBe(57);
    expect(result.scanned).toBe(result.total);
    expect(
      Object.fromEntries(
        result.results
          .filter((entry) => entry.checkedSteps.length)
          .map((entry) => [entry.workflowFile, entry.checkedSteps.length]),
      ),
    ).toEqual({
      ".github/workflows/platform-preview-cleanup.yml": 2,
      [restoreFile]: 1,
      ".github/workflows/platform-production.yml": 1,
      [registryFile]: 1,
      [stagingFile]: 2,
    });
    expect(result.tripwires.checkedWorkflows).toEqual(NAMED_RESET_WORKFLOW_TRIPWIRES);
  });

  it.each([registryFile, restoreFile])("#6127 cleanup shapes pass: %s", (workflowFile) => {
    expect(checkWorkflowDestructiveOperationGating(readWorkflow(workflowFile), { workflowFile })).toMatchObject({
      passed: true,
      violations: [],
      checkedSteps: [expect.objectContaining({ disposition: "provable-gate" })],
    });
  });

  it("accepts env renaming and expression wrappers, not obsolete literal names", () => {
    const renamed = readWorkflow(registryFile)
      .replaceAll("MODE", "REQUESTED_MODE")
      .replaceAll("CONFIRM", "EXACT_CONFIRMATION")
      .replaceAll("DIGITALOCEAN_REGISTRY_CLEANUP_RESOLVED_DRY_RUN", "SYNTHETIC_6129_RESOLVED_MODE");
    expect(checkWorkflowDestructiveOperationGating(renamed).passed).toBe(true);
    const workflow = parse(renamed);
    workflow.jobs.cleanup.if = workflow.jobs.cleanup.if.replace(/^\$\{\{ | \}\}$/g, "");
    expect(checkWorkflowDestructiveOperationGating(stringify(workflow)).passed).toBe(true);
  });

  it.each([
    [
      "trigger set",
      (workflow) => {
        workflow.on.push = {};
      },
      "triggered only",
    ],
    [
      "dry-run default",
      (workflow) => {
        workflow.on.workflow_dispatch.inputs.dry_run.default = "false";
      },
      "defaults to",
    ],
    [
      "typed confirm",
      (workflow) => {
        workflow.on.workflow_dispatch.inputs.confirm.type = "boolean";
      },
      "typed string",
    ],
    [
      "confirm default",
      (workflow) => {
        workflow.on.workflow_dispatch.inputs.confirm.default = "";
      },
      "without a default",
    ],
    [
      "missing refusal",
      (workflow) => {
        delete workflow.jobs["refuse-unconfirmed-apply"];
      },
      "shell-validate",
    ],
    [
      "manual refusal condition",
      (workflow) => {
        workflow.jobs["refuse-unconfirmed-apply"].if = "inputs.confirm";
      },
      "shell-validate",
    ],
    [
      "nonzero unknown refusal",
      (workflow) => {
        const step = workflow.jobs["refuse-unconfirmed-apply"].steps[0];
        step.run = step.run.replaceAll("exit 1", "echo accepted");
      },
      "nonzero exit",
    ],
    [
      "case-sensitive confirmation",
      (workflow) => {
        const step = workflow.jobs["refuse-unconfirmed-apply"].steps[0];
        step.run = step.run.replace('"$CONFIRM"', '"${CONFIRM,,}"');
      },
      "case-sensitively",
    ],
    [
      "invalid mode accepted",
      (workflow) => {
        const step = workflow.jobs["refuse-unconfirmed-apply"].steps[0];
        step.run = step.run.replace('"true")', '"true" | "" | "TRUE")');
      },
      "shell-validate",
    ],
    [
      "dependency",
      (workflow) => {
        delete workflow.jobs.cleanup.needs;
      },
      "cancellation-safe",
    ],
    [
      "cancellation",
      (workflow) => {
        workflow.jobs.cleanup.if = workflow.jobs.cleanup.if.replace("!cancelled()", "always()");
      },
      "cancellation-safe",
    ],
    [
      "failure admission",
      (workflow) => {
        workflow.jobs.cleanup.if = workflow.jobs.cleanup.if.replace("'success'", "'failure'");
      },
      "cancellation-safe",
    ],
    [
      "resolver uniqueness",
      (workflow) => {
        workflow.jobs.cleanup.steps.push(workflow.jobs.cleanup.steps[0]);
      },
      "single fail-closed",
    ],
    [
      "resolver default refusal",
      (workflow) => {
        const step = workflow.jobs.cleanup.steps[0];
        step.run = step.run.replace("exit 1", "echo accepted");
      },
      "single fail-closed",
    ],
    [
      "resolver inversion",
      (workflow) => {
        workflow.jobs.cleanup.env.DIGITALOCEAN_REGISTRY_CLEANUP_REQUESTED_DRY_RUN =
          "${{ github.event_name == 'schedule' && 'true' || github.event.inputs.dry_run }}";
      },
      "single fail-closed",
    ],
    [
      "resolved publication under requested name",
      (workflow) => {
        workflow.jobs.cleanup.steps[0].run = workflow.jobs.cleanup.steps[0].run.replaceAll(
          "RESOLVED_DRY_RUN",
          "REQUESTED_DRY_RUN",
        );
      },
      "distinct resolved name",
    ],
    [
      "script dry-run wiring",
      (workflow) => {
        const step = workflow.jobs.cleanup.steps.find((candidate) => candidate.name === "Cleanup registry tags");
        step.run = step.run.replace('--dry-run="${DIGITALOCEAN_REGISTRY_CLEANUP_RESOLVED_DRY_RUN}"', "--dry-run=false");
      },
      "cannot associate",
    ],
  ])("rejects preserved shape mutant: %s", (_label, change, violation) => {
    const result = checkWorkflowDestructiveOperationGating(changeWorkflow(registryFile, change));
    expect(result.passed).toBe(false);
    expect(result.violations).toContainEqual(expect.stringContaining(violation));
  });

  it("rejects restore resolver inversion and unconditional apply wiring", () => {
    const echoed = readWorkflow(restoreFile).replace('resolved_apply="true"', "echo resolved_apply=true");
    expect(checkWorkflowDestructiveOperationGating(echoed).violations).toContainEqual(
      expect.stringContaining("single fail-closed"),
    );
    const echoedArray = readWorkflow(restoreFile).replace('apply_args=("--apply")', "echo apply_args= '(' --apply ')'");
    expect(checkWorkflowDestructiveOperationGating(echoedArray).violations).toContainEqual(
      expect.stringContaining("cannot associate"),
    );
    const inverted = readWorkflow(restoreFile).replace(
      '"true") resolved_apply="false"',
      '"true") resolved_apply="true"',
    );
    expect(checkWorkflowDestructiveOperationGating(inverted).violations).toContainEqual(
      expect.stringContaining("single fail-closed"),
    );
    const unconditional = readWorkflow(restoreFile).replace('"${apply_args[@]}"', '--apply "${apply_args[@]}"');
    expect(checkWorkflowDestructiveOperationGating(unconditional).violations).toContainEqual(
      expect.stringContaining("cannot associate"),
    );
    const competing = changeWorkflow(restoreFile, (workflow) => {
      workflow.jobs.cleanup.env.PRODUCTION_DB_RESTORE_POINT_CLEANUP_APPLY = "true";
    });
    expect(checkWorkflowDestructiveOperationGating(competing).violations).toContainEqual(
      expect.stringContaining("cannot associate"),
    );
  });

  it("exemption extra invocation rejected", () => {
    const file = DESTRUCTIVE_OPERATION_EXEMPTIONS[0].workflowFile;
    const source = changeWorkflow(file, (workflow) =>
      workflow.jobs["destroy-preview"].steps.push({ run: "terraform destroy" }),
    );
    expect(checkWorkflowDestructiveOperationGating(source, { workflowFile: file }).violations).toContainEqual(
      expect.stringContaining("exact invocation multiset required"),
    );
    const sameStep = readWorkflow(file).replace(
      "run: terraform destroy -auto-approve",
      "run: |\n          terraform destroy -auto-approve\n          terraform destroy -auto-approve",
    );
    expect(checkWorkflowDestructiveOperationGating(sameStep, { workflowFile: file }).violations).toContainEqual(
      expect.stringContaining("exact invocation multiset required"),
    );
  });

  it("exemption missing invocation rejected", () => {
    const file = DESTRUCTIVE_OPERATION_EXEMPTIONS[0].workflowFile;
    const source = readWorkflow(file).replace("run: terraform destroy -auto-approve", "run: terraform plan");
    expect(checkWorkflowDestructiveOperationGating(source, { workflowFile: file }).violations).toContainEqual(
      expect.stringContaining("exact invocation multiset required"),
    );
    const directory = fixtureRoot();
    rmSync(join(directory, file));
    expect(checkDiscoveredWorkflows({ root: directory }).violations).toContain(
      `${file}: bounded exemption workflow is missing.`,
    );
  });

  it("unknown forms cannot borrow exempt paths or jobs", () => {
    const file = DESTRUCTIVE_OPERATION_EXEMPTIONS[0].workflowFile;
    const source = changeWorkflow(file, (workflow) =>
      workflow.jobs["destroy-preview"].steps.push({ run: "terraform synthetic-6129-command" }),
    );
    const result = checkWorkflowDestructiveOperationGating(source, { workflowFile: file });
    expect(result.violations).toContainEqual(expect.stringContaining("INDETERMINATE"));
    expect(result.violations).toContainEqual(expect.stringContaining("exact invocation multiset required"));
  });

  it("new destructive workflow requires gate", () => {
    const directory = fixtureRoot();
    const file = ".github/workflows/synthetic-6129-extra.yaml";
    writeFileSync(join(directory, file), violatingWorkflow());
    const result = checkDiscoveredWorkflows({ root: directory });
    expect(result.total).toBe(58);
    expect(result.scanned).toBe(58);
    expect(result.passed).toBe(false);
    expect(result.violations).toContainEqual(expect.stringContaining(`${file}: refuse-unconfirmed-apply`));
  });

  it("arbitrary workflow sibling discovered", () => {
    const directory = fixtureRoot();
    const file = ".github/workflows/synthetic-6129-ordinary-task.yaml";
    writeFileSync(
      join(directory, file),
      violatingWorkflow(
        'MODE=fixture >output doctl -t "$TOKEN" reg repo dt example old',
        "ordinary-job",
        "ordinary step",
      ),
    );
    const result = checkDiscoveredWorkflows({ root: directory });
    expect(result).toMatchObject({ passed: false, scanned: 58, total: 58 });
    expect(result.results.find((entry) => entry.workflowFile === file).checkedSteps).toEqual([
      expect.objectContaining({
        jobId: "ordinary-job",
        name: "ordinary step",
        operations: ["doctl:registry-repository-delete-tag"],
      }),
    ]);
    expect(result.violations).toContainEqual(expect.stringContaining(`${file}: destructive job 'ordinary-job'`));
    writeFileSync(
      join(directory, file),
      violatingWorkflow(
        'MODE=fixture >output node --no-warnings "./scripts/production-db-restore-point-cleanup.mjs" --apply',
        "another-job",
        "another step",
      ),
    );
    expect(checkDiscoveredWorkflows({ root: directory }).violations).toContainEqual(
      expect.stringContaining(`${file}: destructive job 'another-job'`),
    );
    const repaired = parse(readWorkflow(restoreFile));
    repaired.jobs["ordinary-job"] = repaired.jobs.cleanup;
    delete repaired.jobs.cleanup;
    repaired.jobs["ordinary-job"].steps.find((step) => step.name === "Cleanup restore-point forks").name =
      "ordinary step";
    writeFileSync(join(directory, file), stringify(repaired));
    expect(checkDiscoveredWorkflows({ root: directory })).toMatchObject({
      passed: true,
      scanned: 58,
      total: 58,
      violations: [],
    });
  });
});

describe("both named reset tripwires", () => {
  const sources = Object.fromEntries(NAMED_RESET_WORKFLOW_TRIPWIRES.map((file) => [file, readWorkflow(file)]));

  it("catalog always() mutant red and head green", () => {
    expect(checkNamedResetWorkflowTripwires(sources)).toMatchObject({ passed: true, violations: [] });
    const mutant = sources[catalogFile].replace("!cancelled() &&", "always() &&");
    expect(mutant).not.toBe(sources[catalogFile]);
    expect(checkNamedResetWorkflowTripwires({ ...sources, [catalogFile]: mutant }).violations).toEqual([
      expect.stringContaining(`${catalogFile}: named reset tripwire`),
    ]);
  });

  it.each([
    [catalogFile, (source) => source.replace("exit 1", "echo accepted").replaceAll("exit 1", "echo accepted")],
    [catalogFile, (source) => source.replace("needs.refuse-unconfirmed-apply.result == 'skipped'", "true")],
    [
      catalogFile,
      (source) => source.replace("inputs.confirm != 'reset staging catalog integration data'", "inputs.confirm"),
    ],
    [stagingFile, (source) => source.replace('if [ "$RESET_CONFIRM" != "reset staging" ]; then', "if false; then")],
    [
      stagingFile,
      (source) => source.replace('if [ "$RESET_CONFIRM" != "resume staging recreate" ]; then', "if false; then"),
    ],
    [stagingFile, (source) => source.replaceAll("exit 1", "echo accepted")],
  ])("retains actual refusal/result control for %s", (file, mutate) => {
    const mutant = mutate(sources[file]);
    expect(mutant).not.toBe(sources[file]);
    expect(checkNamedResetWorkflowTripwires({ ...sources, [file]: mutant }).passed).toBe(false);
  });

  it("fails closed if either named tripwire source is absent", () => {
    for (const file of NAMED_RESET_WORKFLOW_TRIPWIRES)
      expect(checkNamedResetWorkflowTripwires({ ...sources, [file]: undefined }).violations).toContainEqual(
        expect.stringContaining(`${file}: named reset workflow source is missing`),
      );
  });
});
